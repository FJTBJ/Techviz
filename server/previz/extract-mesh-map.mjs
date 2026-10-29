/**
 * 采集 UE 祈祷室关卡里每个 StaticMeshActor 的真实网格资产、材质与变换，
 * 并采集灯光 Actor（类型/位置/朝向/颜色/强度/范围）
 *
 * 只读：全部走 Remote Control 单请求（/remote/batch 会触发引擎断言崩溃，禁用）
 * 输出：server/data/ue-mesh-map.json
 *   - actors: 每个 Actor 的 label / 网格资产 / 材质 / 世界变换 / 世界包围盒
 *   - lights: 每盏灯的 label / 类型 / 世界变换 / 颜色 / 强度 / 范围
 *   - meshBounds: 每个唯一网格的本地包围盒（厘米）
 *
 * 坐标：UE 厘米/度 → three.js 米/度
 *   three = [ueY/100, ueZ/100, -ueX/100]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUT_FILE = path.join(DATA_DIR, 'ue-mesh-map.json');

const UE_BASE = process.env.UE_REMOTE_BASE || 'http://localhost:30010';
const WORLD = '/Game/Techviz/Map/祈祷室.祈祷室';
const CONCURRENCY = 4;
const RETRY = 3;

async function ue(pathname, payload) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      const res = await fetch(UE_BASE + pathname, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: Buffer.from(JSON.stringify(payload), 'utf-8'),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw lastError;
}

const prop = (objectPath, propertyName) =>
  ue('/remote/object/property', { objectPath, propertyName }).then((r) => r?.[propertyName]);

const call = (ObjectPath, FunctionName, Parameters = {}) =>
  ue('/remote/object/call', { ObjectPath, FunctionName, Parameters }).then((r) => r?.ReturnValue ?? r);

/** 简单并发池（单请求并发，不走 batch） */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const toMeters = (v) => +(v / 100).toFixed(4);

function toThree(uePos) {
  return [toMeters(uePos.Y), toMeters(uePos.Z), toMeters(-uePos.X)];
}

/**
 * UE 左手系 → three 右手系的基变换 M：
 *   x_ue → -Z, y_ue → X, z_ue → Y（含一次镜像，行列式 -1）
 * 旋转按 R_three = M · R_ue · Mᵀ 共轭，结果仍是正交旋转（det=1）。
 */
const BASIS = new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
const BASIS_INV = BASIS.clone().transpose();

/** UE 四元数 → three.js 欧拉角（弧度，XYZ 顺序） */
function ueQuatToThreeEuler(q) {
  if (!q) return [0, 0, 0];
  const ueMatrix = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(q.x, q.y, q.z, q.w),
  );
  const converted = BASIS.clone().multiply(ueMatrix).multiply(BASIS_INV);
  const euler = new THREE.Euler().setFromRotationMatrix(converted, 'XYZ');
  const round = (v) => +v.toFixed(4);
  return [round(euler.x), round(euler.y), round(euler.z)];
}

async function readActor(actorPath) {
  const failures = [];
  const safe = (label, promise, fallback = null) =>
    promise.catch((err) => {
      failures.push(`${label}: ${String(err).slice(0, 80)}`);
      return fallback;
    });

  let compPath = await safe('component', prop(actorPath, 'StaticMeshComponent'));
  if (!compPath) {
    const list = await safe('componentsByClass', call(actorPath, 'K2_GetComponentsByClass', {
      ComponentClass: '/Script/Engine.StaticMeshComponent',
    }));
    compPath = Array.isArray(list) ? list[0] : null;
  }
  if (!compPath) return { error: 'no static mesh component', actorPath, failures };

  const [label, mesh, materials, transform, bounds, visible] = await Promise.all([
    safe('label', call(actorPath, 'GetActorLabel')),
    safe('mesh', prop(compPath, 'StaticMesh')),
    safe('materials', prop(compPath, 'OverrideMaterials'), []),
    safe('transform', call(actorPath, 'GetTransform')),
    safe('bounds', call(actorPath, 'GetActorBounds', { bOnlyCollidingComponents: false })),
    safe('visible', prop(compPath, 'bVisible'), true),
  ]);
  if (!mesh) return { error: 'no static mesh', actorPath, failures };

  const t = transform?.Translation;
  const s = transform?.Scale3D;
  const q = transform?.Rotation;
  return {
    actorPath,
    label,
    componentPath: compPath,
    mesh,
    materials: Array.isArray(materials) ? materials : [],
    locationCm: t ? [t.X, t.Y, t.Z].map((v) => +v.toFixed(2)) : null,
    position: t ? toThree(t) : null,
    scale: s ? [s.X, s.Y, s.Z].map((v) => +v.toFixed(4)) : [1, 1, 1],
    rotationQuat: q ? { x: q.X, y: q.Y, z: q.Z, w: q.W } : null,
    /** three.js 空间下的世界包围盒（米）：中心 + 半尺寸 */
    bounds: bounds
      ? {
          center: toThree(bounds.Origin),
          half: [
            toMeters(bounds.BoxExtent.Y),
            toMeters(bounds.BoxExtent.Z),
            toMeters(bounds.BoxExtent.X),
          ],
        }
      : null,
    visible: visible !== false,
    ...(failures.length ? { failures } : {}),
  };
}

function materialKey(materials) {
  return materials.map((m) => String(m).split('.').pop()).join('|') || '(none)';
}

/** 采集一盏灯：类型从 Actor 类名取，光学参数从 LightComponent 读 */
async function readLight(actorPath) {
  const failures = [];
  const safe = (label, promise, fallback = null) =>
    promise.catch((err) => {
      failures.push(`${label}: ${String(err).slice(0, 80)}`);
      return fallback;
    });

  // actorPath 形如 ...:PersistentLevel.PointLight_2 → 类型 PointLight
  const type = (String(actorPath).split('.').pop() ?? 'Light').replace(/_\d+$/, '') || 'Light';
  const compList = await safe('lightComponent', call(actorPath, 'K2_GetComponentsByClass', {
    ComponentClass: '/Script/Engine.LightComponent',
  }));
  const compPath = Array.isArray(compList) ? compList[0] : null;

  const [label, transform, visible, color, intensity, attenuation, innerCone, outerCone, sourceWidth, sourceHeight] =
    await Promise.all([
      safe('label', call(actorPath, 'GetActorLabel')),
      safe('transform', call(actorPath, 'GetTransform')),
      compPath ? safe('visible', prop(compPath, 'bVisible'), true) : Promise.resolve(true),
      compPath ? safe('color', prop(compPath, 'LightColor')) : Promise.resolve(null),
      compPath ? safe('intensity', prop(compPath, 'Intensity')) : Promise.resolve(null),
      compPath ? safe('attenuation', prop(compPath, 'AttenuationRadius')) : Promise.resolve(null),
      compPath ? safe('innerCone', prop(compPath, 'InnerConeAngle')) : Promise.resolve(null),
      compPath ? safe('outerCone', prop(compPath, 'OuterConeAngle')) : Promise.resolve(null),
      compPath ? safe('sourceWidth', prop(compPath, 'SourceWidth')) : Promise.resolve(null),
      compPath ? safe('sourceHeight', prop(compPath, 'SourceHeight')) : Promise.resolve(null),
    ]);

  const t = transform?.Translation;
  if (!t) return { error: 'no transform', actorPath, failures };
  const q = transform?.Rotation;
  return {
    actorPath,
    label: label ?? type,
    type,
    /** three.js 空间位置（米）与旋转（XYZ 欧拉，弧度） */
    position: toThree(t),
    rotation: ueQuatToThreeEuler(q),
    locationCm: [t.X, t.Y, t.Z].map((v) => +v.toFixed(2)),
    color: color ? [color.R ?? 255, color.G ?? 255, color.B ?? 255] : null,
    intensity: intensity ?? null,
    /** 点光/聚光衰减半径（UE 厘米） */
    attenuationRadiusCm: attenuation ?? null,
    /** 聚光锥角（度） */
    innerConeDeg: innerCone ?? null,
    outerConeDeg: outerCone ?? null,
    /** 面光源尺寸（UE 厘米） */
    sourceSizeCm: sourceWidth ? [sourceWidth, sourceHeight ?? sourceWidth] : null,
    visible: visible !== false,
    ...(failures.length ? { failures } : {}),
  };
}

async function main() {
  const listRes = await ue('/remote/object/call', {
    ObjectPath: '/Script/Engine.Default__GameplayStatics',
    FunctionName: 'GetAllActorsOfClass',
    Parameters: { WorldContextObject: WORLD, ActorClass: '/Script/Engine.StaticMeshActor' },
  });
  const actorPaths = (listRes?.OutActors ?? []).map(String);
  if (actorPaths.length === 0) throw new Error('UE 中未取到 StaticMeshActor，请确认祈祷室关卡已打开');
  console.log(`[mesh-map] StaticMeshActor: ${actorPaths.length}`);

  let done = 0;
  const results = await pool(actorPaths, CONCURRENCY, async (actorPath) => {
    const row = await readActor(actorPath);
    done++;
    if (done % 50 === 0) console.log(`[mesh-map] 进度 ${done}/${actorPaths.length}`);
    return row;
  });

  const failed = results.filter((r) => !r || r.error);
  const actors = results.filter((r) => r && !r.error);
  console.log(`[mesh-map] 已读取: ${actors.length}, 失败: ${failed.length}`);

  // 灯光采集：以 Light 基类一次抓全部（PointLight/SpotLight/RectLight/DirectionalLight/SkyLight）
  let lights = [];
  try {
    const lightRes = await ue('/remote/object/call', {
      ObjectPath: '/Script/Engine.Default__GameplayStatics',
      FunctionName: 'GetAllActorsOfClass',
      Parameters: { WorldContextObject: WORLD, ActorClass: '/Script/Engine.Light' },
    });
    const lightPaths = (lightRes?.OutActors ?? []).map(String);
    console.log(`[mesh-map] Light: ${lightPaths.length}`);
    if (lightPaths.length > 0) {
      const lightResults = await pool(lightPaths, CONCURRENCY, readLight);
      lights = lightResults.filter((r) => r && !r.error);
      const lightFailed = lightResults.filter((r) => !r || r.error);
      console.log(`[mesh-map] 灯光已读取: ${lights.length}, 失败: ${lightFailed.length}`);
      for (const f of lightFailed) console.log(`  [灯光失败] ${f.actorPath}: ${f.error}`);
    }
  } catch (err) {
    console.log(`[mesh-map] 灯光采集失败（不影响网格数据）: ${String(err).slice(0, 120)}`);
  }
  if (failed.length) {
    const reasons = {};
    for (const f of failed) {
      const key = `${f.error}: ${(f.failures || []).map((x) => x.split(':')[0]).join(',')}`;
      reasons[key] = (reasons[key] || 0) + 1;
    }
    console.log('[mesh-map] 失败原因:', JSON.stringify(reasons, null, 1));
  }

  // 世界尺寸从 GetActorBounds 直接得出
  for (const a of actors) {
    a.rotation = ueQuatToThreeEuler(a.rotationQuat);
    a.size = a.bounds ? a.bounds.half.map((v) => +(v * 2).toFixed(3)) : null;
    // 包围盒中心相对 Actor 原点（three 世界轴向上近似）
    a.offset = a.bounds && a.position
      ? a.bounds.center.map((v, i) => +(v - a.position[i]).toFixed(3))
      : [0, 0, 0];
  }

  const meshes = {};
  for (const a of actors) meshes[a.mesh] = (meshes[a.mesh] || 0) + 1;
  const materials = {};
  for (const a of actors) for (const m of a.materials) materials[m] = (materials[m] || 0) + 1;
  console.log(`[mesh-map] 唯一网格: ${Object.keys(meshes).length}, 唯一材质: ${Object.keys(materials).length}`);

  // 网格本地包围盒（厘米）
  const meshBounds = {};
  await pool(Object.keys(meshes), CONCURRENCY, async (asset) => {
    const box = await prop(asset, 'ExtendedBounds').catch(() => null);
    if (!box?.BoxExtent) {
      meshBounds[asset] = null;
      return;
    }
    meshBounds[asset] = {
      extentCm: [box.BoxExtent.X, box.BoxExtent.Y, box.BoxExtent.Z].map((v) => +v.toFixed(3)),
      originCm: [box.Origin.X, box.Origin.Y, box.Origin.Z].map((v) => +v.toFixed(3)),
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    world: WORLD,
    source: 'UE Remote Control (single-request, no /remote/batch)',
    actorTotal: actors.length,
    lightTotal: lights.length,
    failedActors: failed.map((f) => ({ actorPath: f.actorPath, error: f.error, failures: f.failures })),
    actors,
    lights,
    meshBounds,
    meshes: Object.entries(meshes)
      .sort((a, b) => b[1] - a[1])
      .map(([asset, count]) => ({ asset, count })),
    materials: Object.entries(materials)
      .sort((a, b) => b[1] - a[1])
      .map(([asset, count]) => ({ asset, count })),
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 1));
  console.log(`[mesh-map] → ${OUT_FILE}`);

  console.log('\nTop 网格:');
  for (const { asset, count } of out.meshes.slice(0, 12)) console.log(`  ${String(count).padStart(3)}  ${asset}`);
  console.log('\nTop 材质:');
  for (const { asset, count } of out.materials.slice(0, 12)) console.log(`  ${String(count).padStart(3)}  ${asset}`);
}

main().catch((err) => {
  console.error('[mesh-map] 失败:', String(err));
  process.exit(1);
});
