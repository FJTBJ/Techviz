/**
 * 用实时采集的 UE 网格映射重建场景快照
 *
 * 输入：server/data/ue-mesh-map.json（extract-mesh-map.mjs 生成）
 *       server/data/ue-gltf-manifest.json（tools/export_ue_meshes.py 生成，可选）
 * 输出：server/data/ue-prayer-room.json（前端「导入祈祷室场景」读取）
 *
 * 与旧快照的差别：按当前关卡重新采集，附带真实网格路径与模型地址（meshUrl），
 * 前端据此用真实 GLB 替换代理包围盒；模型缺失时仍回退到盒体。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const MAP_FILE = path.join(DATA_DIR, 'ue-mesh-map.json');
const MANIFEST_FILE = path.join(DATA_DIR, 'ue-gltf-manifest.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'ue-prayer-room.json');

/** 只保留环屏棚附近的布景；远处还有同一关卡的复制布景，属于别的场次 */
const MAX_RADIUS_M = 25;
const MIN_Y = -3;
const MAX_Y = 14;

/** 旧快照里已有的配色按 assetId 沿用，保证视觉连续 */
const COLORS = ['#8a6a4b', '#8e8578', '#b8ab95', '#6b4a33', '#a08055', '#7c8794', '#587e93', '#98938b', '#8d9299', '#a29684', '#9b7f5e', '#7d5f45', '#a3a08f'];

function hashColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

function main() {
  if (!fs.existsSync(MAP_FILE)) throw new Error(`缺少 ${MAP_FILE}，先运行 extract-mesh-map.mjs`);
  const map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));

  /** mesh 资产路径 → 已导出模型地址 */
  const meshUrls = {};
  if (fs.existsSync(MANIFEST_FILE)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    for (const [asset, info] of Object.entries(manifest.models ?? {})) {
      // 带版本号：模型重新导出后 URL 变化，避免浏览器命中 /models 的长缓存
      if (info?.url) {
        const v = `${info.bytes ?? 0}${info.triangles ?? 0}`;
        meshUrls[asset] = `${info.url}?v=${Buffer.from(v).toString('base64url').slice(0, 6)}`;
      }
    }
  }

  /** 旧快照的 assetId → 颜色 */
  const oldColors = {};
  if (fs.existsSync(SNAPSHOT_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      for (const asset of old.assets ?? []) oldColors[asset.assetId] = asset.color;
    } catch {
      /* 旧文件损坏不影响重建 */
    }
  }

  const kept = [];
  let skippedFar = 0;
  for (const actor of map.actors) {
    if (!actor.position || !actor.size) continue;
    const [x, y, z] = actor.position;
    if (Math.hypot(x, z) > MAX_RADIUS_M || y < MIN_Y || y > MAX_Y) {
      skippedFar++;
      continue;
    }
    kept.push(actor);
  }

  // 先按网格名分组，保持同款构件连续、id 稳定
  kept.sort((a, b) => {
    const ma = a.mesh.split('/').pop();
    const mb = b.mesh.split('/').pop();
    return ma === mb ? String(a.label).localeCompare(String(b.label)) : ma.localeCompare(mb);
  });

  const assets = kept.map((actor, index) => {
    const file = actor.mesh.split('/').pop().replace(/\.\w+$/, '');
    const code = file.toUpperCase();
    const assetId = `ue/${code}`;
    const box = map.meshBounds?.[actor.mesh];
    // actor.scale 是 UE 轴序 [Sx, Sy, Sz]；three 轴序为 [Sy, Sz, Sx]
    const [ux, uy, uz] = actor.scale;
    const [sx, sy, sz] = [uy, uz, ux];
    // 世界尺寸（米，three 轴序）：网格本地包围盒 × 对应轴的缩放绝对值
    const size = box
      ? [
          +((2 * box.extentCm[1] * Math.abs(sx)) / 100).toFixed(3),
          +((2 * box.extentCm[2] * Math.abs(sy)) / 100).toFixed(3),
          +((2 * box.extentCm[0] * Math.abs(sz)) / 100).toFixed(3),
        ]
      : actor.size;
    const offset = box
      ? [
          +((box.originCm[1] * sx) / 100).toFixed(3),
          +((box.originCm[2] * sy) / 100).toFixed(3),
          +((-box.originCm[0] * sz) / 100).toFixed(3),
        ]
      : [0, 0, 0];

    return {
      instanceId: `ue-${String(index + 1).padStart(4, '0')}`,
      assetId,
      name: String(actor.label ?? file),
      code,
      kind: 'ue',
      mesh: actor.mesh,
      ...(meshUrls[actor.mesh] ? { meshUrl: meshUrls[actor.mesh] } : {}),
      size,
      offset,
      color: oldColors[assetId] ?? hashColor(assetId),
      position: actor.position,
      rotation: actor.rotation ?? [0, 0, 0],
      scale: [sx, sy, sz],
      visible: actor.visible !== false,
    };
  });

  const snapshot = {
    version: 2,
    stageId: 'Led_01',
    source: {
      level: '/Game/Techviz/Map/祈祷室',
      engine: 'UE 5.8.1 / Web Remote Control',
      importedAt: new Date().toISOString(),
      actorTotal: map.actors.length,
      imported: assets.length,
      skippedFar,
      meshes: Object.keys(map.meshBounds ?? {}).length,
      modelsExported: Object.keys(meshUrls).length,
      note: 'UE cm -> Web m；位置 [Y,Z,-X]；旋转按 M·R·Mᵀ 共轭；size/offset 为网格本地包围盒 × 缩放',
    },
    assets,
  };

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 1));
  const withModel = assets.filter((a) => a.meshUrl).length;
  console.log(
    `[snapshot] ${assets.length} 个构件（跳过远处 ${skippedFar}），其中 ${withModel} 个带真实模型 → ${SNAPSHOT_FILE}`,
  );
  if (withModel === 0) {
    console.log('[snapshot] 提示：先运行 tools/export_ue_meshes.py 导出 GLB，再执行本脚本即可带模型');
  }
}

main();
