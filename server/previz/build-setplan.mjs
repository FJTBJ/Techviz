/**
 * 从预演数据 + 环屏数据推导布景方案
 *
 * 输入：
 *   server/data/previz-shots.json    主预演序列的镜头表（60 镜 → 31 个 take，含 master 时间码）
 *   server/data/previz-cameras.json  take 相机动画（uecam 解析 .uasset 得到，已转 three 坐标）
 *   server/data/ring-led01.json      nDisplay 实测环屏几何
 * 输出：
 *   server/data/setplan.json         SetPlanFile（按场次分组）
 *
 * 时间对齐：master 时间 t → take 时间 = sourceSeconds + (t - masterStart)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSetPlan } from '../setplan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data');

const SHOTS_FILE = path.join(DATA, 'previz-shots.json');
const CAMS_FILE = path.join(DATA, 'previz-cameras.json');
const RING_FILE = path.join(DATA, 'ring-led01.json');
const OUT_FILE = path.join(DATA, 'setplan.json');
const TIMELINE_FILE = path.join(DATA, 'previz-timeline.json');

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
  const d = ringFile.derived;

  const ring = {
    diameter: d.diameterM,
    height: d.totalHeightM,
    arc: d.arcDeg,
    gapCenterDeg: 0, // 缺口中心在 three +Z
  };

  const shots = (shotsFile.shots ?? []).filter((s) => s.sequence && s.asset);
  const byScene = new Map();
  const timelineShots = [];
  let staticShots = 0;
  let emptyShots = 0;
  const heights = [];

  for (const s of shots) {
    const scene = sceneOf(s.sequence);
    if (!scene) continue;
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
    const take = parseTakeName(s.sequence);
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
    const takeCount = new Set(sceneShots.map((s) => s.name)).size;
    const hMin = Math.min(...sceneShots.flatMap((s) => s.keys.map((k) => k.position[1])));
    const hMax = Math.max(...sceneShots.flatMap((s) => s.keys.map((k) => k.position[1])));
    plans[scene] = {
      ...plan,
      scene,
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
      note: `环屏 ${ring.diameter.toFixed(2)}m / 高 ${ring.height.toFixed(2)}m / 覆盖 ${ring.arc.toFixed(2)}°；${heightNote}`,
    },
    scenes,
    plans,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(
    `[build-setplan] ${scenes.length} 个场次 / ${timelineShots.length} 镜 → ${OUT_FILE}` +
      `（静态 ${staticShots}，缺失 ${emptyShots}；${heightNote}）`,
  );

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
