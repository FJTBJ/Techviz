/**
 * 从预演数据 + 环屏数据推导布景方案
 *
 * 输入：
 *   server/data/previz-shots.json    主预演序列的镜头表（60 镜 → 31 个 take，含 master 时间码）
 *   server/data/previz-cameras.json  take 相机动画（uecam 解析 .uasset 得到，已转 three 坐标）
 *   server/data/ring-led01.json      nDisplay 实测环屏几何
 *   server/data/shot-names.json      UE 镜头 → Kmoke 场记单官方短名
 *   server/data/timeline-takes.json  成片时间线实际用到的 take（Kmoke 最新 Previz 时间线）
 * 输出：
 *   server/data/setplan.json         SetPlanFile（按场次分组）
 *
 * 时间对齐：master 时间 t → take 时间 = sourceSeconds + (t - masterStart)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSetPlan, solveStagePosition, collectActorPoints } from '../setplan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');

const SHOTS_FILE = path.join(DATA, 'previz-shots.json');
const CAMS_FILE = path.join(DATA, 'previz-cameras.json');
const RING_FILE = path.join(DATA, 'ring-led01.json');
const OUT_FILE = path.join(DATA, 'setplan.json');
const TIMELINE_FILE = path.join(DATA, 'previz-timeline.json');
const SHOT_NAMES_FILE = path.join(DATA, 'shot-names.json');
const TIMELINE_TAKES_FILE = path.join(DATA, 'timeline-takes.json');
/** UE take 走位序列（演员表演区数据），用于求解每场次推荐棚位 */
const PEOPLE_FILE = path.join(DATA, 'ue-people.json');
/** 场景快照（UE 关卡构件清单，米 / three 坐标），用于判定哪些资产需要置景 */
const SNAPSHOT_FILE = path.join(DATA, 'ue-prayer-room.json');

/** 交互判定：资产包围盒表面与演员走位点的水平距离 ≤ 该值视为「与人物有交互」，需要置景 */
const INTERACT_DIST_M = 0.1;
/** 演员活动高度上限（米）：资产垂直范围与此区间无重叠则不可能交互（如房顶） */
const ACTOR_TOP_M = 1.8;

/**
 * 筛选需要置景的资产：与该场次演员走位有交互的资产默认显示，其余默认隐藏
 * 距离按「走位点到资产 3D 包围盒表面的水平距离」计算，并要求资产垂直范围
 * 与演员活动高度（0~ACTOR_TOP_M）有重叠——排除房顶等高空构件
 */
function filterSetAssets(snapshotAssets, actorPoints) {
  if (!actorPoints.length) return [];
  return snapshotAssets.filter((a) => {
    if (!Array.isArray(a.position) || a.position.length < 3) return false;
    const hx = (a.size?.[0] ?? 0) / 2;
    const hy = (a.size?.[1] ?? 0) / 2;
    const hz = (a.size?.[2] ?? 0) / 2;
    const y0 = a.position[1] - hy;
    const y1 = a.position[1] + hy;
    if (y0 > ACTOR_TOP_M || y1 < 0) return false;
    return actorPoints.some(([px, pz]) => {
      const dx = Math.max(Math.abs(px - a.position[0]) - hx, 0);
      const dz = Math.max(Math.abs(pz - a.position[2]) - hz, 0);
      return Math.hypot(dx, dz) <= INTERACT_DIST_M;
    });
  });
}

/** 环屏台面（棚地面）高度，米 */
const FLOOR_Y = 0;
/** 单个镜头最多送入方案的相机采样点（buildSetPlan 内部还会再抽 5 帧） */
const MAX_KEYS_PER_SHOT = 60;

/** 主预演画幅：S35 传感器裁 2.39:1（覆盖率必须按实际画幅算，不能用 4:3 全画幅高度） */
const SENSOR_W = 24.89;
const SENSOR_H = 24.89 / 2.39;

const round2 = (n) => Math.round(n * 100) / 100;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** /Game/.../MAP_s079a/A/... → s079a */
function sceneOf(sequence) {
  const m = /MAP_([A-Za-z0-9]+)/.exec(sequence ?? '');
  return m ? m[1] : null;
}

/** c_s001_b02_05a_a_04 → { scene:'s001', block:'b02', shotNo:'05a', take:'a_04' } */
function parseTakeName(sequence) {
  const base = (sequence ?? '').split('.').pop() ?? '';
  const m = /^c_(s\d+)_(b\d+)_(\w+?)_([a-z]_\d+)$/.exec(base);
  if (!m) return { base, scene: sceneOf(sequence) };
  return { base, scene: m[1], block: m[2], shotNo: m[3], take: m[4] };
}

/** 截取镜头时间窗内的相机关键帧；静态 take 只有 1 帧，整段复用 */
function sliceKeys(camera, sourceSeconds, durationSec, max = MAX_KEYS_PER_SHOT) {
  if (!camera || !camera.keys.length) return [];
  if (camera.keys.length === 1) return camera.keys;
  const from = sourceSeconds;
  const to = sourceSeconds + Math.max(durationSec, 1 / 24);
  const inside = camera.keys.filter((k) => k.t >= from - 1e-6 && k.t <= to + 1e-6);
  if (inside.length >= 2) return thin(inside, max);
  // 时间窗落在关键帧之外（take 被裁切或时间码错位）：退化为整段最接近的帧
  const nearest = camera.keys.reduce((best, k) =>
    Math.abs(k.t - from) < Math.abs(best.t - from) ? k : best, camera.keys[0]);
  return [nearest];
}

function thin(keys, max) {
  if (keys.length <= max) return keys;
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(keys[Math.round((i * (keys.length - 1)) / (max - 1))]);
  return out;
}

function main() {
  for (const f of [SHOTS_FILE, CAMS_FILE, RING_FILE]) {
    if (!fs.existsSync(f)) throw new Error(`缺少 ${f}`);
  }
  const shotsFile = readJson(SHOTS_FILE);
  const cams = readJson(CAMS_FILE);
  const ringFile = readJson(RING_FILE);
  const people = fs.existsSync(PEOPLE_FILE) ? readJson(PEOPLE_FILE) : null;
  const snapshot = fs.existsSync(SNAPSHOT_FILE) ? readJson(SNAPSHOT_FILE) : null;
  const snapshotAssets = (snapshot?.assets ?? []).filter((a) => a.kind === 'ue');
  const d = ringFile.derived;

  const ring = {
    diameter: d.diameterM,
    height: d.totalHeightM,
    arc: d.arcDeg,
    gapCenterDeg: 0, // 缺口中心在 three +Z
  };

  const shots = (shotsFile.shots ?? []).filter((s) => s.sequence && s.asset);
  // 成片时间线过滤：同一场次可能拍了几十条 take，只保留最新时间线里实际用到的
  const timelineTakes = fs.existsSync(TIMELINE_TAKES_FILE) ? readJson(TIMELINE_TAKES_FILE) : null;
  const shotNames = fs.existsSync(SHOT_NAMES_FILE) ? (readJson(SHOT_NAMES_FILE).shots ?? {}) : {};
  /** 无该场次时间线数据时不过滤；有数据时按官方短名严格匹配 */
  const inTimeline = (scene, base) => {
    const sceneTakes = timelineTakes?.scenes?.[scene];
    if (!sceneTakes?.takes?.length) return true;
    const short = shotNames[base]?.short;
    return Boolean(short) && sceneTakes.takes.includes(short);
  };
  const droppedShots = [];
  const byScene = new Map();
  const timelineShots = [];
  let staticShots = 0;
  let emptyShots = 0;
  const heights = [];

  for (const s of shots) {
    const scene = sceneOf(s.sequence);
    if (!scene) continue;
    const take = parseTakeName(s.sequence);
    if (!inTimeline(scene, take.base)) {
      droppedShots.push({ scene, base: take.base, short: shotNames[take.base]?.short ?? null });
      continue;
    }
    const camera = cams.cameras[s.sequence];
    const durationSec = +(s.masterEnd - s.masterStart).toFixed(3);
    const rawKeys = sliceKeys(camera, s.sourceSeconds ?? 0, durationSec, 1200);
    const keys = thin(rawKeys, MAX_KEYS_PER_SHOT);
    if (camera && camera.keys.length === 1) staticShots += 1;
    if (!keys.length) {
      emptyShots += 1;
      continue;
    }
    const first = keys[0];
    heights.push(...keys.map((k) => k.position[1]));
    const shot = {
      id: `${take.base}@${round2(s.masterStart)}s`,
      name: take.base,
      scene,
      durationSec,
      masterStart: s.masterStart,
      focal: first.focal ?? null,
      position: first.position,
      yaw: first.yaw,
      pitch: first.pitch,
      sensorWidth: SENSOR_W,
      sensorHeight: SENSOR_H,
      keys,
    };
    if (!byScene.has(scene)) byScene.set(scene, []);
    byScene.get(scene).push(shot);
    // 时间线用的关键帧密度（约 10 帧/秒），太密没必要且体积大
    timelineShots.push({
      id: shot.id,
      name: shot.name,
      scene,
      start: round2(s.masterStart),
      end: round2(s.masterEnd),
      durationSec,
      focal: shot.focal,
      keys: thin(rawKeys, Math.max(2, Math.min(240, Math.round(durationSec * 10)))),
    });
  }

  const plans = {};
  const scenes = [];
  for (const scene of [...byScene.keys()].sort()) {
    const sceneShots = byScene.get(scene).sort((a, b) => a.masterStart - b.masterStart);
    const plan = buildSetPlan({ ring, shots: sceneShots });
    // 每场次一个摆放：先按「与人物有交互」筛出置景资产，再连同演员活动范围解算统一摆放
    const actorPoints = collectActorPoints(sceneShots, people?.shots ?? null);
    const setAssets = filterSetAssets(snapshotAssets, actorPoints);
    const stagePos = solveStagePosition({ ring, shots: sceneShots, people, setAssets });
    const takeCount = new Set(sceneShots.map((s) => s.name)).size;
    const hMin = Math.min(...sceneShots.flatMap((s) => s.keys.map((k) => k.position[1])));
    const hMax = Math.max(...sceneShots.flatMap((s) => s.keys.map((k) => k.position[1])));
    plans[scene] = {
      ...plan,
      scene,
      stagePosition: stagePos,
      /** 需要置景的资产（与人物有交互）：默认显示；其余资产默认隐藏。按快照唯一实例 ID 记录（assetId 是类别代码，同类别含门窗/屋顶等多种构件） */
      setInstanceIds: setAssets.map((a) => a.instanceId),
      source: {
        rings: 'ring-led01.json（nDisplay 实测）',
        previz: 'previz-cameras.json（take 序列相机轨道）',
        shots: sceneShots.length,
        takes: takeCount,
        note:
          `相机位置/朝向直接取自 UE take 序列轨道；机位高度 ${round2(hMin)}–${round2(hMax)}m` +
          `（相对棚地面 y=${FLOOR_Y}）；无焦距轨道时按 ${cams.defaultFocal ?? 35}mm 计算`,
      },
    };
    scenes.push({ scene, shotCount: sceneShots.length, takeCount });
    if (stagePos) {
      console.log(
        `  [摆放] ${scene}: 平移(${-stagePos.offset[0]}, ${-stagePos.offset[2]})m ` +
          `演员 ${stagePos.actorBacked}%（原位 ${stagePos.actorBackedOrigin}%）` +
          ` 置景资产 ${stagePos.assetBacked}%（${stagePos.assetCount}/${snapshotAssets.length} 件）` +
          ` · ${stagePos.sampleCount} 采样 / ${stagePos.shotCount} 镜`,
      );
    }
  }

  const heightsSorted = heights.slice().sort((a, b) => a - b);
  const heightNote = heightsSorted.length
    ? `机位高度 ${round2(heightsSorted[0])}–${round2(heightsSorted[heightsSorted.length - 1])}m，中位 ${round2(heightsSorted[Math.floor(heightsSorted.length / 2)])}m`
    : '无机位数据';

  const out = {
    generatedAt: new Date().toISOString(),
    source: {
      shots: path.basename(SHOTS_FILE),
      cameras: path.basename(CAMS_FILE),
      ring: path.basename(RING_FILE),
      shotTotal: timelineShots.length,
      covered: timelineShots.length,
      staticShots,
      emptyShots,
      heightNote,
      timelineFilter: timelineTakes
        ? {
            source: timelineTakes.source,
            scenes: Object.keys(timelineTakes.scenes ?? {}),
            dropped: droppedShots.length,
            droppedShots,
          }
        : null,
      note: `环屏 ${ring.diameter.toFixed(2)}m / 高 ${ring.height.toFixed(2)}m / 覆盖 ${ring.arc.toFixed(2)}°；${heightNote}`,
    },
    scenes,
    plans,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(
    `[build-setplan] ${scenes.length} 个场次 / ${timelineShots.length} 镜 → ${OUT_FILE}` +
      `（静态 ${staticShots}，缺失 ${emptyShots}，非时间线剔除 ${droppedShots.length}；${heightNote}）`,
  );
  for (const d of droppedShots) {
    console.log(`  剔除 ${d.base}（${d.short ?? '未匹配短名'}）不在 ${d.scene} 最新时间线`);
  }

  // 播放时间线：按 master 时间码排布所有镜头，供前端底部时间线使用
  timelineShots.sort((a, b) => a.start - b.start);
  const timeline = {
    generatedAt: out.generatedAt,
    fps: 24,
    duration: round2(Math.max(1, ...timelineShots.map((s) => s.end))),
    scenes: scenes.map((s) => ({ scene: s.scene, shotCount: s.shotCount })),
    note: `master 时间码（秒），共 ${timelineShots.length} 镜；机位 ${heightNote}`,
    shots: timelineShots,
  };
  fs.writeFileSync(TIMELINE_FILE, JSON.stringify(timeline));
  console.log(`[build-setplan] 时间线 ${timelineShots.length} 镜 / ${timeline.duration}s → ${TIMELINE_FILE}`);
}

main();
