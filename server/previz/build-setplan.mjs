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
 *   server/data/setplan.json         SetPlanFile（按场景分组：全部镜头同属一个场景）
 *
 * 时间对齐：master 时间 t → take 时间 = sourceSeconds + (t - masterStart)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSetPlan,
  solveStagePosition,
  collectActorPointsByShot,
  buildWalkableSurfaces,
  filterOccluderAssets,
  lightRuleForRing,
  validateLighting,
} from '../setplan.mjs';

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
/** 镜头分类判定结果（机械臂/交互/无交互 + 置景/地板子维度），KMOKE-261104 规则输入 */
const CLASSIFICATIONS_FILE = path.join(DATA, 'shot-classifications.json');

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
    // 走位点带站立海拔：站在台面上时演员活动区间随之上移（[y, y+1.8]）
    return actorPoints.some((p) => {
      const ay = p[2] ?? 0;
      if (y0 > ay + ACTOR_TOP_M || y1 < ay) return false;
      const dx = Math.max(Math.abs(p[0] - a.position[0]) - hx, 0);
      const dz = Math.max(Math.abs(p[1] - a.position[2]) - hz, 0);
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
  // 悬空剔除：包围盒底部高于地面 FLOAT_BOTTOM_MAX_M 的构件（梁、悬挂结构等）不参与置景方案
  const FLOAT_BOTTOM_MAX_M = 0.1;
  const bottomY = (a) =>
    (a.position?.[1] ?? 0) + (a.offset?.[1] ?? 0) - (a.size?.[1] ?? 0) / 2;
  const excludedFloating = [];
  const snapshotAssets = (snapshot?.assets ?? []).filter((a) => {
    if (a.kind !== 'ue') return false;
    if (bottomY(a) > FLOAT_BOTTOM_MAX_M) {
      excludedFloating.push(a.code);
      return false;
    }
    return true;
  });
  const classifications = fs.existsSync(CLASSIFICATIONS_FILE) ? (readJson(CLASSIFICATIONS_FILE).shots ?? {}) : {};
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
  const excludedRobotArms = []; // KMOKE-261104 规则一：机械臂镜头整镜剔除，不参与任何方案推导
  const byScene = new Map();
  const timelineShots = [];
  let staticShots = 0;
  let emptyShots = 0;
  const heights = [];

  for (const s of shots) {
    const scene = sceneOf(s.sequence);
    if (!scene) continue;
    const take = parseTakeName(s.sequence);
    if (classifications[take.base]?.category === 'robot_arm') {
      excludedRobotArms.push({ scene, base: take.base, short: shotNames[take.base]?.short ?? null });
      continue;
    }
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
  let globalPlanNo = 0; // 方案全局编号：方案不按场次区分，跨场次连续编号
  /** 置景筛选门槛（规则二）：有交互=需置景；无交互按遮挡情况（分类判定 need_set/has_set）；无分类结论默认参与（保守） */
  const needSetShot = (base) => {
    const cls = classifications[base];
    if (!cls) return true;
    if (cls.category === 'interaction') return true;
    return cls.category === 'no_interaction' && (cls.scene_setting === 'need_set' || cls.scene_setting === 'has_set');
  };

  // 方案按「场景」生成（KMOKE-261104：小场景为最小落地单位）。
  // 当前项目全部镜头同属一个场景，合并所有场次镜头解算，不再按 MAP 场次分组。
  const SCENE_KEY = 'scene_all';
  const sceneGroups = [
    { scene: SCENE_KEY, sceneShots: [...byScene.values()].flat().sort((a, b) => a.masterStart - b.masterStart) },
  ];

  const walkableSurfaces = buildWalkableSurfaces(snapshotAssets);
  console.log(`  可踩台面 ${walkableSurfaces.length} 块（走位点落在台面上时演员抬升至台面顶面）`);

  for (const { scene, sceneShots } of sceneGroups) {
    const plan = buildSetPlan({ ring, shots: sceneShots });
    const actorPointsByShot = collectActorPointsByShot(sceneShots, people?.shots ?? null, walkableSurfaces);

    // 逐镜头交互资产筛选（仅「需置景」镜头参与）与遮挡资产筛选（不受高度限制）
    const setShotIds = new Set(sceneShots.filter((s) => needSetShot(s.name)).map((s) => s.id));
    const shotInstanceIds = new Map(); // shotId -> Set<instanceId>（方案置景 = 覆盖镜头实例并集）
    const interactIds = new Set();
    for (const s of sceneShots) {
      if (!setShotIds.has(s.id)) continue;
      const pts = actorPointsByShot.get(s.id);
      const ids = new Set(pts ? filterSetAssets(snapshotAssets, pts).map((a) => a.instanceId) : []);
      const occluders = filterOccluderAssets({
        assets: snapshotAssets,
        excludeIds: ids,
        actorPointsByShot: pts ? new Map([[s.id, pts]]) : new Map(),
        shots: [s],
      });
      for (const id of occluders) ids.add(id);
      shotInstanceIds.set(s.id, ids);
      for (const id of ids) interactIds.add(id);
    }
    const assetById = new Map(snapshotAssets.map((a) => [a.instanceId, a]));

    /** 地台（内容局部系）：方案覆盖镜头的演员活动范围包围盒，外扩 0.5m，高 0.15m */
    const platformFor = (shotIds) => {
      const pts = [];
      for (const sid of shotIds) pts.push(...(actorPointsByShot.get(sid) ?? []));
      if (!pts.length) return null;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [x, z] of pts) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const pad = 0.5;
      minX -= pad;
      maxX += pad;
      minZ -= pad;
      maxZ += pad;
      const r2 = (v) => Math.round(v * 100) / 100;
      return {
        position: [r2((minX + maxX) / 2), 0, r2((minZ + maxZ) / 2)],
        size: [r2(maxX - minX), 0.15, r2(maxZ - minZ)],
      };
    };

    // 多方案轮次生成（规则四）：每轮在待覆盖镜头上解算覆盖最多镜头的内容位姿，
    // 该轮覆盖的镜头移出待覆盖集，直到待覆盖为空或无新覆盖产生
    let pending = sceneShots.map((s) => s.id);
    const planList = [];
    for (let roundNo = 1; roundNo <= 8 && pending.length; roundNo += 1) {
      const pendingSet = new Set(pending);
      const roundAssetIds = new Set();
      for (const sid of pending) {
        for (const id of shotInstanceIds.get(sid) ?? []) roundAssetIds.add(id);
      }
      const roundAssets = [...roundAssetIds].map((id) => assetById.get(id)).filter(Boolean);
      const res = solveStagePosition({
        ring,
        shots: sceneShots,
        people,
        setAssets: roundAssets,
        shotFilter: pending,
      });
      if (!res || !res.coveredShotIds.length) break;
      globalPlanNo += 1;
      planList.push({
        planId: `P${globalPlanNo}`,
        label: `方案 ${globalPlanNo}`,
        offset: res.offset,
        rotationDeg: res.rotationDeg,
        coveredShotIds: res.coveredShotIds,
        coveredCount: res.coveredShotIds.length,
        shotCoverage: res.shotCoverage,
        actorBacked: res.actorBacked,
        assetBacked: res.assetBacked,
        sampleCount: res.sampleCount,
        contentRadiusM: res.contentRadiusM,
        discRadiusM: res.discRadiusM,
        method: res.method,
        platform: platformFor(res.coveredShotIds),
        setInstanceIds: [...roundAssetIds],
      });
      const covered = new Set(res.coveredShotIds);
      pending = pending.filter((id) => !covered.has(id));
    }

    // 收尾兜底（最终不留未覆盖镜头）：剩余镜头逐镜单独解算成版，
    // 哪怕单镜无法全采样命中，也取该镜最优位姿单独出一版（method=best_effort）
    const fallbackShot = (sid) => {
      const ids = new Set(shotInstanceIds.get(sid) ?? []);
      const res = solveStagePosition({
        ring,
        shots: sceneShots,
        people,
        setAssets: [...ids].map((id) => assetById.get(id)).filter(Boolean),
        shotFilter: [sid],
      });
      globalPlanNo += 1;
      planList.push({
        planId: `P${globalPlanNo}`,
        label: `方案 ${globalPlanNo}`,
        // 单镜也无解（无演员采样等）时用归零位姿兜底
        offset: res ? res.offset : [0, 0, 0],
        rotationDeg: res ? res.rotationDeg : 0,
        coveredShotIds: [sid],
        coveredCount: 1,
        shotCoverage: res?.shotCoverage ?? [{ id: sid, hit: 0, total: 0, covered: false }],
        actorBacked: res?.actorBacked ?? 0,
        assetBacked: res?.assetBacked ?? 0,
        sampleCount: res?.sampleCount ?? 0,
        contentRadiusM: res?.contentRadiusM,
        discRadiusM: res?.discRadiusM,
        method: res ? res.method : 'no_actor_samples',
        platform: platformFor([sid]),
        setInstanceIds: [...ids],
      });
      pending = pending.filter((id) => id !== sid);
      console.log(
        `  [方案兜底] ${sid} 单独成版（方法 ${res ? res.method : 'no_actor_samples'}，采样命中 ${res?.actorBacked ?? 0}%）`,
      );
    };
    while (pending.length) fallbackShot(pending[0]);

    const takeCount = new Set(sceneShots.map((s) => s.name)).size;
    const hMin = Math.min(...sceneShots.flatMap((s) => s.keys.map((k) => k.position[1])));
    const hMax = Math.max(...sceneShots.flatMap((s) => s.keys.map((k) => k.position[1])));
    const first = planList[0] ?? null;
    const classifiedCount = sceneShots.filter((s) => classifications[s.name]).length;
    plans[scene] = {
      ...plan,
      scene,
      /** 兼容字段：取第一套方案（前端多方案联动逐步切换） */
      stagePosition: first
        ? {
            offset: first.offset,
            rotationDeg: first.rotationDeg,
            actorBacked: first.actorBacked,
            assetBacked: first.assetBacked,
            sampleCount: first.sampleCount,
            assetCount: first.setInstanceIds.length,
            shotCount: sceneShots.length,
            method: first.method,
          }
        : null,
      setInstanceIds: first ? first.setInstanceIds : [],
      /** 多方案列表（KMOKE-261104 规则四：小场景内多套方案，覆盖镜头互斥） */
      planList,
      pendingShotIds: pending,
      /** 灯光约束接口：灯位配置未下发前仅输出规则，不做硬校验 */
      lightRule: lightRuleForRing(ring.diameter),
      lighting: validateLighting({ rule: lightRuleForRing(ring.diameter) }),
      classification: {
        classified: classifiedCount,
        needSetShots: sceneShots.filter((s) => setShotIds.has(s.id)).length,
        noSetShots: sceneShots.length - setShotIds.size,
        instanceCount: interactIds.size,
      },
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
    const planNote = planList.length
      ? planList.map((p) => `${p.label}:覆盖${p.coveredCount}镜 平移(${p.offset[0]},${p.offset[2]}) 旋转${p.rotationDeg}° 置景${p.setInstanceIds.length}件`).join(' | ')
      : '无覆盖方案';
    console.log(
      `  [方案] ${scene}: ${sceneShots.length} 镜（需置景门槛 ${setShotIds.size}）→ ${planList.length} 套；${planNote}` +
        (pending.length ? `；未覆盖 ${pending.length} 镜` : ''),
    );
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
      /** KMOKE-261104 规则一：机械臂镜头整镜剔除记录 */
      excludedRobotArms,
      /** 镜头分类覆盖情况：未分类镜头按「参与推导、需置景」保守处理 */
      classificationCoverage: {
        file: path.basename(CLASSIFICATIONS_FILE),
        classified: Object.keys(classifications).length,
        note: '分页接口当前只返回第 1 页，仅覆盖部分镜头，修复后补拉全量',
      },
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
  for (const r of excludedRobotArms) {
    console.log(`  剔除 ${r.base}（${r.short ?? '未匹配短名'}）机械臂镜头，不参与方案推导`);
  }
  console.log(`  悬空剔除 ${excludedFloating.length} 个构件（底部高于地面 ${FLOAT_BOTTOM_MAX_M}m）：${[...new Set(excludedFloating)].join('、')}`);

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
