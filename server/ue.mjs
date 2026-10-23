/**
 * UE 编辑器 Remote Control API 代理（只读）。
 * UE 没开 / 接口失败时一律返回降级结构，绝不 500。
 */

const UE_BASE = process.env.UE_REMOTE_BASE || 'http://localhost:30010';
/** 当前打开的关卡（World 对象路径，实测可用） */
const WORLD_PATH = '/Game/Techviz/Map/祈祷室.祈祷室';

const FUNCTION_CALL_HINT =
  '需在 UE 编辑器开启 Allow Any Remote Function Call（Editor Preferences → Plugins → Web Remote Control）';

/** 发 PUT：中文 body 必须按 UTF-8 字节发送，Content-Type 显式带 charset */
async function uePut(pathname, payload, timeoutMs = 5000) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  return fetch(UE_BASE + pathname, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 探测 UE Remote Control 是否在线；routes 为 /remote/info 暴露的路由数量 */
export async function getUeStatus() {
  try {
    const res = await fetch(UE_BASE + '/remote/info', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { online: false };
    const info = await res.json();
    // 实测 UE 5.8 字段名是 HttpRoutes（兼容 Routes）
    const routes = Array.isArray(info?.HttpRoutes)
      ? info.HttpRoutes.length
      : Array.isArray(info?.Routes)
        ? info.Routes.length
        : Object.keys(info ?? {}).length;
    return { online: true, routes };
  } catch {
    return { online: false };
  }
}

/** 读取当前 World：describe 拿对象名 / 类名，另做一次属性读取验证通路 */
export async function getUeLevel() {
  try {
    // 实测 describe/property 的 body 用单数 objectPath（大小写不敏感）
    const res = await uePut('/remote/object/describe', { objectPath: WORLD_PATH });
    if (!res.ok) return { online: false };
    const desc = await res.json();
    // 响应：{ Name, Class: '/Script/Engine.World', Properties: [...], Functions: [...] }
    const classPath = typeof desc?.Class === 'string' ? desc.Class : '';
    const className = classPath ? classPath.split('.').pop() : null;
    const worldName =
      (typeof desc?.Name === 'string' && desc.Name) ||
      WORLD_PATH.split('/').pop().split('.')[0];

    // 顺带读一个属性验证 property 通路（失败不影响结果）
    let worldType;
    try {
      const pres = await uePut('/remote/object/property', {
        objectPath: WORLD_PATH,
        propertyName: 'WorldType',
      });
      if (pres.ok) {
        const pjson = await pres.json();
        worldType = pjson?.WorldType;
      }
    } catch {
      /* 属性读取失败可忽略 */
    }

    return {
      online: true,
      worldName,
      className,
      ...(worldType !== undefined ? { worldType } : {}),
    };
  } catch {
    return { online: false };
  }
}

/** 尝试拉取当前关卡全部 Actor；被 UE 安全设置挡住时返回降级提示 */
export async function getUeActors() {
  let res;
  try {
    res = await uePut('/remote/object/call', {
      ObjectPath: '/Script/Engine.Default__GameplayStatics',
      FunctionName: 'GetAllActorsOfClass',
      Parameters: {
        WorldContextObject: WORLD_PATH,
        ActorClass: '/Script/Engine.Actor',
      },
    });
  } catch {
    return { enabled: false, online: false, message: `UE Remote Control 未连接（${UE_BASE}）` };
  }

  if (!res.ok) {
    // 实测：函数调用被安全设置拒绝时返回 400 "not allowed by remote control settings"
    return { enabled: false, online: true, message: FUNCTION_CALL_HINT };
  }

  try {
    const json = await res.json();
    const raw = Array.isArray(json?.ReturnValue) ? json.ReturnValue : [];
    const actors = raw.slice(0, 500).map((p) => {
      const s = String(p);
      return { name: s.slice(s.lastIndexOf('.') + 1), path: s };
    });
    return { enabled: true, actors };
  } catch {
    return { enabled: false, online: true, message: '返回结果解析失败' };
  }
}
