import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountAuthRoutes, requireAuth, requireAuthMedia, logAuthConfigSummary } from './auth.mjs';
import {
  getScene,
  upsertScene,
  listScenes,
  deleteScene,
  getCurrentSceneName,
  setCurrentScene,
  seedUserScenes,
  addSceneRevision,
  listSceneRevisions,
  getSceneRevision,
} from './db.mjs';
import { getUeStatus, getUeLevel, getUeActors } from './ue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 运行时数据目录（SQLite + 快照 JSON + take 视频） */
const DATA_DIR = path.join(__dirname, 'data');
const TAKES_DIR = path.join(DATA_DIR, 'takes');

/** UE 工程位置（数据源）：引擎插件内的 nDisplay 环屏棚目录 */
const UE_NDC_DIRS = [
  'D:/Ver_Launcher/UnrealEngine/5.8.1/Windows/Engine/Plugins/Ver/LED/VersatileNDisplay/Content/NDC',
];

/**
 * 棚规格映射：编号 → [直径m, 屏高m, 覆盖角度°]
 * 编号与屏体分块网格（vp_h 系列 / vp_d 系列）来自 UE 工程 NDC 目录扫描；
 * Led_01 的直径/屏高/覆盖角由 nDisplay 配置 + 46 块 vp_* 网格的 ExtendedBounds 实测得出
 * （圆心拟合残差 8.15cm），缺口中心落在 three.js 的 +Z 方向；
 * Led_05 / Led_07 尚未实测，当前为占位值。
 */
const STAGE_SPECS = {
  Led_01: {
    no: 1,
    diameter: 22.285,
    height: 8.064,
    arc: 270.18,
    gapCenterDeg: 0,
    name: '24m棚',
    code: 'STAGE_LED_B_24M',
  },
  Led_05: { no: 5, diameter: 36, height: 7.5, arc: 250, name: '36m棚', code: 'STAGE_LED_C_36M' },
  Led_07: { no: 7, diameter: 50, height: 9.0, arc: 270, name: '50m棚', code: 'STAGE_LED_D_50M' },
};

/** 线上无 UE 工程目录时，回退到本地导出的棚清单快照 */
const STAGE_SNAPSHOT_FILE = path.join(__dirname, 'data', 'stages.json');

function readStageSnapshot() {
  try {
    if (!fs.existsSync(STAGE_SNAPSHOT_FILE)) return [];
    const json = JSON.parse(fs.readFileSync(STAGE_SNAPSHOT_FILE, 'utf8'));
    return Array.isArray(json) ? json : [];
  } catch (err) {
    console.warn('[stages] 快照读取失败：', String(err));
    return [];
  }
}

function scanStages() {
  const stages = [];
  for (const root of UE_NDC_DIRS) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^Led_\d+$/.test(entry.name)) continue;
      const key = entry.name;
      const spec = STAGE_SPECS[key];
      if (!spec) continue;
      const dir = path.join(root, entry.name);
      // 统计屏体分块网格数量（vp_*），以及 umap 主关卡
      let panels = 0;
      let umap = null;
      let meshDir = null;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory() && f.name.toLowerCase() === 'mesh') meshDir = path.join(dir, f.name);
        if (f.isFile() && f.name.endsWith('.umap')) umap = f.name;
      }
      if (meshDir) panels = fs.readdirSync(meshDir).filter((n) => /^vp_.*\.uasset$/.test(n)).length;
      const stat = fs.statSync(dir);
      stages.push({
        id: key,
        ...spec,
        panels,
        umap,
        uePath: dir,
        updatedAt: stat.mtime.toISOString(),
      });
    }
  }
  stages.sort((a, b) => a.no - b.no);
  return stages.length > 0 ? stages : readStageSnapshot();
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// 认证端点（login/callback/me/logout，不需要会话）
mountAuthRoutes(app);

// take 视频：<video> 无法带 Authorization 头，支持 ?token= 鉴权，需在全局 /api 鉴权之前注册
app.use('/api/takes', requireAuthMedia, express.static(TAKES_DIR, { maxAge: '1h' }));

// 真实模型（GLB，由 tools/export_ue_meshes.py 从 UE 导出）：公开静态资源
const MODELS_DIR = path.join(__dirname, 'public', 'models');
app.use('/models', express.static(MODELS_DIR, { maxAge: '7d', fallthrough: true }));

// 其余 /api/* 一律需要登录（开发模式自动注入 dev 用户）
app.use('/api', requireAuth);

/** 棚清单：从 UE 工程目录实时扫描 */
app.get('/api/stages', (_req, res) => {
  try {
    res.json({ code: 0, data: scanStages() });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 当前方案（当前用户正在使用的方案，默认「默认方案」） */
app.get('/api/scene', (req, res) => {
  // 老用户（或首次登录未触发模板复制）没有方案时，先用模板补一份
  seedUserScenes(req.user.id);
  const row = getScene(req.user.id, getCurrentSceneName(req.user.id));
  if (!row) return res.status(404).json({ code: 1, data: null });
  let data = null;
  try {
    data = JSON.parse(row.data);
  } catch {
    data = null;
  }
  res.json({ code: 0, data });
});

/** 保存方案（前端自动调用，SQLite 持久化） */
app.put('/api/scene', (req, res) => {
  try {
    const scene = { ...req.body, savedAt: new Date().toISOString() };
    const name = getCurrentSceneName(req.user.id);
    const payload = JSON.stringify(scene);
    upsertScene(req.user.id, name, payload, scene.sceneKey ?? null);
    addSceneRevision(req.user.id, name, payload);
    res.json({ code: 0, data: { savedAt: scene.savedAt } });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 当前方案的历史版本列表（仅元信息，不含正文） */
app.get('/api/scene/revisions', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  res.json({
    code: 0,
    data: listSceneRevisions(req.user.id, getCurrentSceneName(req.user.id), limit),
  });
});

/** 恢复到指定历史版本：恢复前先把当前状态存一条，避免二次误操作丢数据 */
app.post('/api/scene/revisions/:id/restore', (req, res) => {
  try {
    const name = getCurrentSceneName(req.user.id);
    const revision = getSceneRevision(req.user.id, name, Number(req.params.id));
    if (!revision) return res.status(404).json({ code: 1, message: '版本不存在' });

    let data;
    try {
      data = JSON.parse(revision.data);
    } catch {
      return res.status(400).json({ code: 1, message: '该版本数据损坏，无法恢复' });
    }

    const current = getScene(req.user.id, name);
    if (current) addSceneRevision(req.user.id, name, current.data, 'restore-checkpoint');
    upsertScene(req.user.id, name, revision.data, data?.sceneKey ?? null);
    res.json({ code: 0, data });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 手动从 UE 重新同步棚数据（目前=重新扫描工程目录） */
app.post('/api/stages/sync', (_req, res) => {
  try {
    res.json({ code: 0, data: scanStages() });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 当前用户方案列表（含关联场次与当前方案名） */
app.get('/api/scenes', (req, res) => {
  res.json({
    code: 0,
    current: getCurrentSceneName(req.user.id),
    data: listScenes(req.user.id),
  });
});

/**
 * 新建方案：一个场景（场次）对应一个方案。
 * 方案名默认取场次编号；数据从当前方案复制，避免新方案空白。
 */
app.post('/api/scenes', (req, res) => {
  const scene = typeof req.body?.scene === 'string' ? req.body.scene.trim() : '';
  if (!scene) return res.status(400).json({ code: 1, message: '请选择关联场次' });
  const name = (typeof req.body?.name === 'string' ? req.body.name.trim() : '') || scene;
  if (getScene(req.user.id, name)) {
    return res.status(409).json({ code: 1, message: '同名方案已存在' });
  }
  if (listScenes(req.user.id).some((row) => row.scene === scene)) {
    return res.status(409).json({ code: 1, message: `场次 ${scene} 已有方案` });
  }
  const src = getScene(req.user.id, getCurrentSceneName(req.user.id));
  let data = null;
  if (src) {
    try {
      data = JSON.parse(src.data);
    } catch {
      data = null;
    }
  }
  const payload = {
    version: 2,
    savedAt: new Date().toISOString(),
    ...(data && typeof data === 'object' ? data : {}),
    sceneKey: scene,
  };
  upsertScene(req.user.id, name, JSON.stringify(payload), scene);
  setCurrentScene(req.user.id, name);
  res.json({ code: 0, data: { name, scene } });
});

/** 切换当前方案 */
app.put('/api/scenes/current', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!getScene(req.user.id, name)) return res.status(404).json({ code: 1, message: '方案不存在' });
  setCurrentScene(req.user.id, name);
  res.json({ code: 0, data: { name } });
});

/** 删除方案：至少保留一个；删掉当前方案时自动切到剩余最新方案 */
app.delete('/api/scenes/:name', (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!getScene(req.user.id, name)) return res.status(404).json({ code: 1, message: '方案不存在' });
  if (listScenes(req.user.id).length <= 1) {
    return res.status(400).json({ code: 1, message: '至少保留一个方案' });
  }
  const remaining = deleteScene(req.user.id, name);
  let current = getCurrentSceneName(req.user.id);
  if (current === name) {
    current = remaining[0]?.name ?? '默认方案';
    setCurrentScene(req.user.id, current);
  }
  res.json({ code: 0, data: { current, deleted: name } });
});

/** UE Remote Control 状态探测 */
app.get('/api/ue/status', async (_req, res) => {
  res.json({ code: 0, data: await getUeStatus() });
});

/**
 * 祈祷室场景快照：由 UE Remote Control 采集关卡内全部 StaticMeshActor，
 * 转换为代理体块（kind='ue'）后落盘。文件缺失时返回 404。
 */
const UE_SCENE_FILE = path.join(__dirname, 'data', 'ue-prayer-room.json');

app.get('/api/ue/prayer-room', (_req, res) => {
  try {
    if (!fs.existsSync(UE_SCENE_FILE)) {
      return res.status(404).json({ code: 1, message: '尚未采集 UE 祈祷室场景' });
    }
    const data = JSON.parse(fs.readFileSync(UE_SCENE_FILE, 'utf8'));
    res.json({ code: 0, data });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/**
 * 布景方案：由预演相机动画（UE take 序列）+ 环屏几何离线推导，
 * 结果由 build-setplan 脚本写入 data/setplan.json。
 */
const SETPLAN_FILE = path.join(__dirname, 'data', 'setplan.json');
const TIMELINE_FILE = path.join(DATA_DIR, 'previz-timeline.json');
const SHOT_NAMES_FILE = path.join(DATA_DIR, 'shot-names.json');

app.get('/api/setplan', (_req, res) => {
  try {
    if (!fs.existsSync(SETPLAN_FILE)) {
      return res.status(404).json({ code: 1, message: '尚未生成布景方案' });
    }
    const data = JSON.parse(fs.readFileSync(SETPLAN_FILE, 'utf8'));
    res.json({ code: 0, data });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 预演播放时间线（master 时间码 + 相机关键帧），由 previz/build-setplan.mjs 生成 */
app.get('/api/previz/timeline', (_req, res) => {
  try {
    if (!fs.existsSync(TIMELINE_FILE)) {
      return res.status(404).json({ code: 1, message: '尚未生成预演时间线' });
    }
    const data = JSON.parse(fs.readFileSync(TIMELINE_FILE, 'utf8'));
    // 合并 Kmoke 场记单的官方短名与 take 视频（shot-names.json 由 kmoke4 MCP 生成）
    if (fs.existsSync(SHOT_NAMES_FILE)) {
      const names = JSON.parse(fs.readFileSync(SHOT_NAMES_FILE, 'utf8')).shots ?? {};
      for (const shot of data.shots ?? []) {
        const meta = names[String(shot.name).replace(/@.*$/, '')];
        if (!meta) continue;
        shot.short = meta.short;
        shot.take = meta.take;
        shot.takeDuration = meta.durationSec;
        shot.takeUrl = meta.videoUrl;
        shot.takeLocal = Boolean(meta.short && fs.existsSync(path.join(TAKES_DIR, `${meta.short}.mp4`)));
      }
    }
    res.json({ code: 0, data });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 全量镜头清单（Kmoke 场记单 shot-names.json）：左侧镜头树数据源 */
app.get('/api/shot-names', (_req, res) => {
  try {
    if (!fs.existsSync(SHOT_NAMES_FILE)) {
      return res.status(404).json({ code: 1, message: '尚无镜头清单' });
    }
    res.json({ code: 0, data: JSON.parse(fs.readFileSync(SHOT_NAMES_FILE, 'utf8')) });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 场次 → 场景资产名映射（scene-asset-map.json）：镜头树一级分组用 */
const SCENE_ASSET_MAP_FILE = path.join(DATA_DIR, 'scene-asset-map.json');

app.get('/api/scene-asset-map', (_req, res) => {
  try {
    if (!fs.existsSync(SCENE_ASSET_MAP_FILE)) {
      return res.status(404).json({ code: 1, message: '尚无场次场景映射' });
    }
    res.json({ code: 0, data: JSON.parse(fs.readFileSync(SCENE_ASSET_MAP_FILE, 'utf8')) });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** 机位朝向计算：计算前 / 计算后两组数据，由 previz/aim-shots.mjs 生成 */
const SHOT_AIM_FILE = path.join(DATA_DIR, 'shot-aim.json');

app.get('/api/previz/shot-aim', (_req, res) => {
  try {
    if (!fs.existsSync(SHOT_AIM_FILE)) {
      return res.status(404).json({ code: 1, message: '尚未计算机位朝向' });
    }
    res.json({ code: 0, data: JSON.parse(fs.readFileSync(SHOT_AIM_FILE, 'utf8')) });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/**
 * 人物动画：从 UE take 关联的 PostData 镜头序列里抽取的 actor 位移，
 * 由 previz/build-ue-people.mjs 生成。带 ?shot=<take 名> 时只返回该镜头。
 */
const UE_PEOPLE_FILE = path.join(DATA_DIR, 'ue-people.json');

app.get('/api/ue-people', (req, res) => {
  try {
    if (!fs.existsSync(UE_PEOPLE_FILE)) {
      return res.status(404).json({ code: 1, message: '尚未生成人物动画数据' });
    }
    const data = JSON.parse(fs.readFileSync(UE_PEOPLE_FILE, 'utf8'));
    const shot = typeof req.query.shot === 'string' ? req.query.shot : null;
    if (shot) {
      const one = data.shots?.[shot] ?? null;
      return res.json({ code: 0, data: { generatedAt: data.generatedAt, fps: data.fps, shots: one ? { [shot]: one } : {} } });
    }
    res.json({ code: 0, data });
  } catch (err) {
    res.status(500).json({ code: 1, message: String(err) });
  }
});

/** UE 当前关卡（World）信息 */
app.get('/api/ue/level', async (_req, res) => {
  res.json({ code: 0, data: await getUeLevel() });
});
/** UE 当前关卡 Actor 清单（函数调用被安全设置挡住时返回开启提示） */
app.get('/api/ue/actors', async (_req, res) => {
  res.json({ code: 0, data: await getUeActors() });
});

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => {
  console.log(`[techviz-server] http://localhost:${PORT}`);
  logAuthConfigSummary();
  console.log(`[techviz-server] UE stages source: ${UE_NDC_DIRS[0]}`);
});
