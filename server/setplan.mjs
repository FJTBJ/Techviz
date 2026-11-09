/**
 * 布景方案推导（纯几何计算，无 IO）
 *
 * 输入：
 *   ring  —— 环屏几何（米 / 度）
 *   shots —— 预演镜头（相机采样点）
 * 输出：
 *   coverage —— 逐镜头「LED 环屏 / 实体地面 / 无覆盖」的射线占比
 *   setPieces —— 需要实体搭建的布景条目（地台 / 顶部延伸）
 *
 * 坐标约定与工作台一致：three.js 右手系，Y 向上，XZ 为地平面，单位米。
 * 环屏网格：position = [R·sinθ, y, R·cosθ]，θ=90° 指向 +X。
 */

const DEG = Math.PI / 180;

/** 环屏覆盖的角区间（弧度）；缺口以 gapCenterDeg 为中心 */
export function ringArcRange(ring) {
  const arc = Math.min(360, Math.max(1, ring.arc)) * DEG;
  const gap = 2 * Math.PI - arc;
  const center = (ring.gapCenterDeg ?? 90) * DEG;
  const start = center + gap / 2;
  return { start, end: start + arc, arc, gap };
}

/** 把角度归一到 [0, 2π) */
const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** 判断角度是否落在环屏（非缺口）区间 */
function inArc(theta, range) {
  const t = norm(theta);
  const s = norm(range.start);
  const span = range.arc;
  const rel = norm(t - s + 2 * Math.PI);
  return rel <= span + 1e-9;
}

/** 相机朝向单位向量：Euler YXZ（yaw 绕 Y、pitch 绕 X），forward = -Z */
function forwardVector(yawDeg, pitchDeg) {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/** 相机右向量 / 上向量（忽略 roll，roll 对取景范围影响可忽略） */
function basisVectors(yawDeg, pitchDeg) {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const f = forwardVector(yawDeg, pitchDeg);
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [
    Math.sin(yaw) * Math.sin(pitch),
    Math.cos(pitch),
    Math.cos(yaw) * Math.sin(pitch),
  ];
  return { f, right, up };
}

/** 射线与环屏圆柱面求交，返回最近的 t（含缺口/超高信息） */
function intersectRing(origin, dir, ring, range) {
  const R = ring.diameter / 2;
  const a = dir[0] * dir[0] + dir[2] * dir[2];
  if (a < 1e-12) return null;
  const b = 2 * (origin[0] * dir[0] + origin[2] * dir[2]);
  const c = origin[0] * origin[0] + origin[2] * origin[2] - R * R;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const t = [t1, t2].find((v) => v > 1e-4);
  if (t === undefined) return null;
  const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
  const theta = Math.atan2(p[0], p[2]);
  return { t, point: p, theta, inArc: inArc(theta, range) };
}

/** 射线与地面 y=0 求交 */
function intersectGround(origin, dir) {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = -origin[1] / dir[1];
  if (t <= 1e-4) return null;
  return { t, point: [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t] };
}

/** 逐镜头取样：边界 + 中间关键帧（最多 5 个），返回相机状态列表 */
function pickSamples(shot, maxSamples = 5) {
  const keys = Array.isArray(shot.keys) && shot.keys.length ? shot.keys : null;
  if (!keys) {
    return [
      {
        position: shot.position,
        yaw: shot.yaw,
        pitch: shot.pitch,
        focal: shot.focal,
        t: 0,
      },
    ];
  }
  if (keys.length <= maxSamples) return keys;
  const picked = [];
  for (let i = 0; i < maxSamples; i += 1) {
    picked.push(keys[Math.round((i * (keys.length - 1)) / (maxSamples - 1))]);
  }
  return picked;
}

const COLS = 11;
const ROWS = 7;
const BINS = 24;

/**
 * 生成布景方案
 * @param {{ring: {diameter:number,height:number,arc:number,gapCenterDeg?:number}, shots: Array}} input
 */
export function buildSetPlan({ ring, shots, platformHeight = 0.15 }) {
  const range = ringArcRange(ring);
  const R = ring.diameter / 2;
  const H = ring.height;

  const shotResults = [];
  const openBins = new Map(); // binIndex -> {aboveTop:number, maxHeight:number, shots:Set}
  const groundPoints = [];
  let totalRays = 0;
  let totalLed = 0;
  let totalGround = 0;
  let totalOpen = 0;

  for (const shot of shots) {
    const sensorW = shot.sensorWidth ?? 24.89;
    const sensorH = shot.sensorHeight ?? 18.66;
    const samples = pickSamples(shot);

    let led = 0;
    let ground = 0;
    let open = 0;
    let rays = 0;
    let nearestCam = null;
    let insideRing = true;
    const camSpan = { min: Infinity, max: -Infinity };

    for (const s of samples) {
      const focal = s.focal || shot.focal || 35;
      const hfov = 2 * Math.atan(sensorW / (2 * focal));
      const vfov = 2 * Math.atan(sensorH / (2 * focal));
      const { f, right, up } = basisVectors(s.yaw, s.pitch);
      const origin = s.position;
      // 相机必须在环内，环屏才能当背景（在环外时近侧屏面位于相机与场景之间，不能算覆盖）
      const inside = Math.hypot(origin[0], origin[2]) < R - 0.05;
      if (!inside) insideRing = false;

      if (!nearestCam) nearestCam = origin;
      const camTheta = Math.atan2(origin[0], origin[2]);
      camSpan.min = Math.min(camSpan.min, camTheta);
      camSpan.max = Math.max(camSpan.max, camTheta);

      for (let iy = 0; iy < ROWS; iy += 1) {
        const v = ((iy + 0.5) / ROWS - 0.5) * 2 * Math.tan(vfov / 2);
        for (let ix = 0; ix < COLS; ix += 1) {
          const u = ((ix + 0.5) / COLS - 0.5) * 2 * Math.tan(hfov / 2);
          let dx = f[0] + right[0] * u + up[0] * v;
          let dy = f[1] + right[1] * u + up[1] * v;
          let dz = f[2] + right[2] * u + up[2] * v;
          const len = Math.hypot(dx, dy, dz);
          dx /= len;
          dy /= len;
          dz /= len;
          const dir = [dx, dy, dz];

          rays += 1;
          const ringHit = intersectRing(origin, dir, ring, range);
          const groundHit = intersectGround(origin, dir);

          // 环屏有效覆盖：相机在环内、命中圆柱且在弧段内、高度在屏体范围内
          const screenHit =
            inside &&
            ringHit &&
            ringHit.inArc &&
            ringHit.point[1] >= 0 &&
            ringHit.point[1] <= H;

          if (screenHit && (!groundHit || ringHit.t < groundHit.t)) {
            led += 1;
            continue;
          }
          if (groundHit && (!ringHit || groundHit.t < ringHit.t)) {
            ground += 1;
            groundPoints.push(groundHit.point);
            continue;
          }

          open += 1;
          // 从缺口漏出的射线只计入「无覆盖」，现场不设封挡，不生成任何补缺口方案
          if (ringHit && ringHit.inArc) {
            const theta = ringHit.theta;
            const bin = Math.floor((norm(theta) / (2 * Math.PI)) * BINS) % BINS;
            const entry = openBins.get(bin) ?? {
              aboveTop: 0,
              maxHeight: 0,
              shots: new Set(),
            };
            entry.aboveTop += 1;
            entry.maxHeight = Math.max(entry.maxHeight, Math.min(ringHit.point[1], H + 6));
            entry.shots.add(shot.id);
            openBins.set(bin, entry);
          }
        }
      }
    }

    totalRays += rays;
    totalLed += led;
    totalGround += ground;
    totalOpen += open;

    shotResults.push({
      id: shot.id,
      name: shot.name,
      scene: shot.scene ?? null,
      durationSec: shot.durationSec ?? null,
      focal: shot.focal ?? null,
      camera: nearestCam,
      cameraSpanDeg:
        camSpan.min === Infinity
          ? null
          : [(norm(camSpan.min) / DEG).toFixed(1), (norm(camSpan.max) / DEG).toFixed(1)],
      samples: samples.length,
      insideRing,
      coverage: {
        led: pct(led, rays),
        ground: pct(ground, rays),
        open: pct(open, rays),
      },
    });
  }

  const setPieces = [];

  // 1) 表演区地台：所有镜头地面命中点的包围盒
  if (groundPoints.length > 0) {
    const xs = groundPoints.map((p) => p[0]);
    const zs = groundPoints.map((p) => p[2]);
    const pad = 0.6;
    let minX = Math.min(...xs) - pad;
    let maxX = Math.max(...xs) + pad;
    let minZ = Math.min(...zs) - pad;
    let maxZ = Math.max(...zs) + pad;
    // 收到环屏内侧（留 0.4m 安全距）
    const limit = R - 0.4;
    const corners = [
      [minX, minZ],
      [maxX, minZ],
      [minX, maxZ],
      [maxX, maxZ],
    ];
    const overshoot = corners.some(([x, z]) => Math.hypot(x, z) > limit);
    if (overshoot) {
      const scale = limit / Math.max(...corners.map(([x, z]) => Math.hypot(x, z)));
      minX *= scale;
      maxX *= scale;
      minZ *= scale;
      maxZ *= scale;
    }
    const w = Math.max(0.5, maxX - minX);
    const d = Math.max(0.5, maxZ - minZ);
    setPieces.push({
      id: 'platform',
      name: '表演区地台',
      category: 'platform',
      position: [(minX + maxX) / 2, platformHeight / 2, (minZ + maxZ) / 2],
      size: [round2(w), round2(platformHeight), round2(d)],
      rotationY: 0,
      color: '#3b6f8f',
      relatedShots: shots.map((s) => s.id),
      rationale: `所有镜头地面取景范围的并集，外扩 0.6m；受环屏半径 ${R}m 限制`,
      metrics: { areaM2: round2(w * d), coverage: pct(totalGround, totalRays) },
    });
  }

  // 2) 顶部延伸：按角度扇区聚合
  const binArc = (2 * Math.PI) / BINS;
  const topPieces = [];
  for (const [bin, entry] of [...openBins.entries()].sort((a, b) => a[0] - b[0])) {
    topPieces.push({
      bin,
      theta: (bin + 0.5) * binArc,
      count: entry.aboveTop,
      shots: [...entry.shots],
      height: entry.maxHeight,
    });
  }

  // 顶部延伸：连续扇区合并成景片
  for (const group of groupByAdjacent(topPieces)) {
    const thetaFrom = (group[0].bin + 0.5) * binArc;
    const thetaTo = (group[group.length - 1].bin + 0.5) * binArc;
    const thetaMid = (thetaFrom + thetaTo) / 2;
    const needed = Math.max(...group.map((g) => g.height));
    const extHeight = Math.max(0.5, round2(needed - H));
    const width = Math.max(1, round2(((thetaTo - thetaFrom) + binArc) * R));
    setPieces.push({
      id: `top-skirt-${group[0].bin}`,
      name: `顶部延伸遮光 ${round2(extHeight)}m`,
      category: 'topSkirt',
      position: [R * Math.sin(thetaMid), H + extHeight / 2, R * Math.cos(thetaMid)],
      size: [width, extHeight, 0.1],
      rotationY: thetaMid,
      color: '#1d2733',
      relatedShots: [...new Set(group.flatMap((g) => g.shots))],
      rationale: `该 ${Math.round((width / (2 * Math.PI * R)) * 360)}° 扇区有镜头越过屏顶，需向上延伸遮光`,
      metrics: { sectors: group.length, rays: group.reduce((n, g) => n + g.count, 0) },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    ring: {
      diameter: ring.diameter,
      radius: R,
      height: H,
      arc: ring.arc,
      gapDeg: round2(2 * Math.PI / DEG - ring.arc),
      gapCenterDeg: ring.gapCenterDeg ?? 90,
    },
    summary: {
      shotCount: shots.length,
      rayCount: totalRays,
      led: pct(totalLed, totalRays),
      ground: pct(totalGround, totalRays),
      open: pct(totalOpen, totalRays),
      setPieceCount: setPieces.length,
    },
    shots: shotResults,
    setPieces,
  };
}

/** 把按 bin 排序的数组切成连续块（bin 相邻或相差 1） */
function groupByAdjacent(items) {
  const groups = [];
  let cur = [];
  for (const item of items) {
    if (cur.length === 0 || item.bin === cur[cur.length - 1].bin + 1) {
      cur.push(item);
    } else {
      groups.push(cur);
      cur = [item];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
const round2 = (n) => Math.round(n * 100) / 100;

/** 演员头顶高度：表演区「全身在屏内」按地面点 + 头顶点双重判定 */
const ACTOR_HEAD_Y = 1.7;
/** 交互/遮挡判定中的演员活动高度上限（KMOKE-261104 规则：0–1.8m） */
export const ACTOR_TOP_M = 1.8;
/** 每镜每角色最多抽多少个走位采样点 */
const MAX_SAMPLES_PER_CHAR = 40;

/**
 * 灯光硬约束接口（KMOKE-261104 规则四）。
 * 灯位配置数据尚未下发，先落规则框架：validateLighting 在无灯位数据时返回 checked=false。
 * @param {number} diameter 环屏直径（米）
 */
export function lightRuleForRing(diameter) {
  if (diameter < 30) return { label: '24米屏', offscreenMinM: 1, offscreenMaxM: 1, note: '灯具离屏 1 米' };
  if (diameter < 45) return { label: '36米屏', offscreenMinM: 0, offscreenMaxM: 2, note: '依顶屏情况离屏 0–2 米' };
  return { label: '50米屏', offscreenMinM: 0, offscreenMaxM: 0, note: '允许灯具与屏重合' };
}

/**
 * 校验一组灯位是否满足离屏规则与被摄对象最近距离。
 * @param {{positions:[x,y,z][], rule:object, actorPoints:[x,z][]}} input
 * @returns {checked:boolean, ...}  无灯位数据时 checked=false（规则框架就位，等灯位下发后启用）
 */
export function validateLighting({ positions, rule, actorPoints }) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return { checked: false, reason: `灯位配置未下发（${rule?.label ?? ''}：${rule?.note ?? ''}）；被摄对象与灯具最近距离须 ≥3m，效果复现预留 3–7m` };
  }
  const MIN_TO_SUBJECT_M = 3;
  let minDist = Infinity;
  for (const [lx, , lz] of positions) {
    for (const [px, pz] of actorPoints ?? []) {
      minDist = Math.min(minDist, Math.hypot(lx - px, lz - pz));
    }
  }
  return { checked: true, minToSubjectM: round2(minDist), pass: minDist >= MIN_TO_SUBJECT_M };
}

/** 内容点绕环心旋转 deg 度（环屏与缺口固定，旋转的是内容位姿） */
function rotatePoint([x, z], deg) {
  if (!deg) return [x, z];
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - z * s, x * s + z * c];
}

/**
 * 收集一个场次各镜头的演员走位点（带镜头归属），用于逐镜头的交互/遮挡资产筛选。
 * KMOKE-261104 规则二：置景实例先按镜头筛出，方案置景 = 覆盖镜头实例并集。
 * @returns Map<shotId, [[x, z], ...]>
 */
export function collectActorPointsByShot(shots, peopleShots) {
  const out = new Map();
  for (const shot of shots) {
    const track = peopleShots?.[shot.name];
    if (!track?.characters?.length) continue;
    const pts = [];
    for (const ch of track.characters) {
      for (const k of ch.keys ?? []) {
        const p = k?.p;
        if (!Array.isArray(p) || p.length < 3) continue;
        pts.push([p[0], p[2]]);
      }
    }
    if (pts.length) out.set(shot.id, pts);
  }
  return out;
}

/** 线段 (a→b) 与 AABB [c0,c1] 相交测试（slab 法，含端点） */
function segmentIntersectsAabb(a, b, c0, c1) {
  let tmin = 0;
  let tmax = 1;
  for (let i = 0; i < 3; i += 1) {
    const d = b[i] - a[i];
    if (Math.abs(d) < 1e-9) {
      if (a[i] < c0[i] || a[i] > c1[i]) return false;
    } else {
      let t1 = (c0[i] - a[i]) / d;
      let t2 = (c1[i] - a[i]) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

/** 遮挡视线采样：演员代表点高度（胸口），低于头顶避免把「越过肩部」判成遮挡 */
const OCCLUSION_EYE_Y = 1.6;
/** 每镜头最多抽多少个相机帧 / 演员点做视线采样 */
const OCCLUSION_CAM_SAMPLES = 6;
const OCCLUSION_ACTOR_SAMPLES = 8;

/**
 * 遮挡资产筛选（KMOKE-261104 规则二）：相机到演员的视线被实例截断 → 该实例需要置景。
 * 不受高度限制（高处构件同样可能遮挡演员），已判为交互资产的实例不重复计入。
 * @param {Array} assets 场景快照资产（position/size/instanceId）
 * @param {Set<string>} excludeIds 已判为交互资产的 instanceId
 * @param {Map<string,[x,z][]>} actorPointsByShot collectActorPointsByShot 输出
 * @param {Array} shots 镜头列表（取 keys 相机帧）
 * @returns Set<string> 遮挡资产 instanceId
 */
export function filterOccluderAssets({ assets, excludeIds = new Set(), actorPointsByShot, shots }) {
  const hit = new Set();
  for (const shot of shots) {
    const pts = actorPointsByShot.get(shot.id);
    if (!pts?.length) continue;
    const camKeys = shot.keys?.length ? shot.keys : [{ t: 0, position: shot.position }];
    const stepC = Math.max(1, Math.ceil(camKeys.length / OCCLUSION_CAM_SAMPLES));
    const stepA = Math.max(1, Math.ceil(Math.min(pts.length, 64) / OCCLUSION_ACTOR_SAMPLES));
    const actors = pts.filter((_, i) => i % stepA === 0);
    for (let ci = 0; ci < camKeys.length; ci += stepC) {
      const cam = camKeys[ci].position;
      for (const [px, pz] of actors) {
        const b = [px, OCCLUSION_EYE_Y, pz];
        // 视线段包围盒粗剔除后做 AABB 精确相交
        const bb0 = [Math.min(cam[0], b[0]), Math.min(cam[1], b[1]), Math.min(cam[2], b[2])];
        const bb1 = [Math.max(cam[0], b[0]), Math.max(cam[1], b[1]), Math.max(cam[2], b[2])];
        for (const a of assets) {
          if (excludeIds.has(a.instanceId) || hit.has(a.instanceId)) continue;
          const hx = (a.size?.[0] ?? 0) / 2;
          const hy = (a.size?.[1] ?? 0) / 2;
          const hz = (a.size?.[2] ?? 0) / 2;
          const c0 = [a.position[0] - hx, a.position[1] - hy, a.position[2] - hz];
          const c1 = [a.position[0] + hx, a.position[1] + hy, a.position[2] + hz];
          if (bb0[0] > c1[0] || bb1[0] < c0[0]) continue;
          if (bb0[1] > c1[1] || bb1[1] < c0[1]) continue;
          if (bb0[2] > c1[2] || bb1[2] < c0[2]) continue;
          if (segmentIntersectsAabb(cam, b, c0, c1)) hit.add(a.instanceId);
        }
      }
    }
  }
  return hit;
}

/**
 * 单个采样点在给定内容位姿（平移 off + 绕环心旋转 rotDeg）下的「表演区在屏内」得分（0/1）。
 * 判据：演员在环内，且相机经演员头顶(1.7m)延伸的视线命中环屏弧段内、屏高范围内、演员身后。
 * 环屏与缺口固定不动，旋转/平移作用于内容（演员走位、置景），相机不动。
 */
function actorScore(cam, pt, off, rotDeg, ring, range) {
  const R = ring.diameter / 2;
  const H = ring.height;
  const [rx, rz] = rotatePoint(pt, rotDeg);
  const ox = cam[0] - off[0];
  const oz = cam[2] - off[2];
  const tx = rx - off[0];
  const tz = rz - off[2];
  if (Math.hypot(ox, oz) > R - 0.05) return 0;
  if (Math.hypot(tx, tz) > R - 0.05) return 0;
  const dx = tx - ox;
  const dy = ACTOR_HEAD_Y - cam[1];
  const dz = tz - oz;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return 0;
  const hit = intersectRing([ox, cam[1], oz], [dx / len, dy / len, dz / len], ring, range);
  return hit && hit.inArc && hit.point[1] >= 0 && hit.point[1] <= H && hit.t > len - 0.05 ? 1 : 0;
}

/**
 * 置景资产锚点得分（0/1）：资产在环内，且资产方向落在屏体弧段内（背后是屏不是缺口）。
 * 锚点取资产顶面中心；资产高于屏体的部分由「顶部延伸遮光」方案兜底，不参与此项判定。
 */
function assetScore(anchor, off, rotDeg, ring, range) {
  const R = ring.diameter / 2;
  const [rx, rz] = rotatePoint([anchor[0], anchor[2]], rotDeg);
  const tx = rx - off[0];
  const tz = rz - off[2];
  if (Math.hypot(tx, tz) > R - 0.05) return 0;
  return inArc(Math.atan2(tx, tz), range) ? 1 : 0;
}

/** 旋转搜索档位（步长可调）：内容可绕环心任意旋转，全周扫描 */
function rotationSteps(rotStepDeg) {
  const steps = [];
  for (let d = 0; d < 360; d += rotStepDeg) steps.push(d === 180 ? 180 : d > 180 ? d - 360 : d);
  return steps;
}

/**
 * 求解一套方案的内容位姿（KMOKE-261104 规则四）：
 * 平移 + 绕环心旋转两自由度，镜头级覆盖评分为目标（覆盖镜头数最多 → 采样命中 → 资产入屏 → 偏移小）。
 * 搜索前按规则做平移预筛：内容包围圆（仅演员走位点与置景锚点，相机不参与）到环心距离
 * 不得超过环屏内半径减包围圆半径，仅在该可行圆盘内铺设搜索网格。
 * @param {object} input
 * @param {Array} input.shots 场次镜头
 * @param {Set<string>|null} input.shotFilter 待覆盖镜头 id 集合（多方案轮次用；null = 全部）
 * @returns null | { offset, rotationDeg, coveredShotIds, shotCoverage, actorBacked, assetBacked, sampleCount, assetCount, method }
 */
export function solveStagePosition({
  ring,
  shots,
  people,
  setAssets = [],
  shotFilter = null,
  coarseStep = 1,
  fineStep = 0.25,
  rotStepDeg = 15,
}) {
  const peopleShots = people?.shots ?? null;
  if (!peopleShots) return null;
  const filterSet = shotFilter ? new Set(shotFilter) : null;
  const inScope = (id) => !filterSet || filterSet.has(id);
  const allSamples = collectActorSamples(shots, peopleShots).filter((s) => inScope(s.shot));
  // 逐镜头聚合采样，镜头级覆盖判定用
  const byShot = new Map();
  for (const s of allSamples) {
    if (!byShot.has(s.shot)) byShot.set(s.shot, []);
    byShot.get(s.shot).push(s);
  }
  const anchors = setAssets.map((a) => [
    a.position[0],
    (a.position[1] ?? 0) + (a.size?.[1] ?? 0) / 2,
    a.position[2],
  ]);
  const shotIds = [...byShot.keys()];
  if (shotIds.length === 0 && anchors.length === 0) return null;

  const range = ringArcRange(ring);
  const R = ring.diameter / 2;
  const LIMIT = R - 0.05;

  // 平移预筛：内容包围圆（走位点 + 锚点；随旋转逐档重算质心）
  const contentPts = [
    ...allSamples.map((s) => s.pt),
    ...anchors.map((a) => [a[0], a[2]]),
  ];
  if (contentPts.length === 0) return null;
  const centroid = [
    contentPts.reduce((n, p) => n + p[0], 0) / contentPts.length,
    contentPts.reduce((n, p) => n + p[1], 0) / contentPts.length,
  ];
  const contentRadius = Math.max(
    ...contentPts.map((p) => Math.hypot(p[0] - centroid[0], p[1] - centroid[1])),
  );
  // 可行圆盘半径：质心到环心距离上限 = 环内限 - 包围圆半径；无余量时退化为质心附近 ±0.5m
  const discR = Math.max(0.5, LIMIT - contentRadius);

  const shotCoveredAt = (off, rotDeg) => {
    let shotsCovered = 0;
    let sampleHit = 0;
    for (const sid of shotIds) {
      const list = byShot.get(sid);
      let hit = 0;
      for (const s of list) {
        if (actorScore(s.cam, s.pt, off, rotDeg, ring, range)) hit += 1;
      }
      sampleHit += hit;
      if (hit === list.length) shotsCovered += 1;
    }
    let assetHit = 0;
    for (const a of anchors) {
      if (assetScore(a, off, rotDeg, ring, range)) assetHit += 1;
    }
    return { shotsCovered, sampleHit, assetHit };
  };

  // 候选比较：覆盖镜头数 → 采样命中 → 资产入屏 → 偏移小
  let best = null;
  const consider = (off, rotDeg) => {
    const m = shotCoveredAt(off, rotDeg);
    const cand = {
      off,
      rotDeg,
      shotsCovered: m.shotsCovered,
      sampleHit: m.sampleHit,
      assetHit: m.assetHit,
    };
    const better =
      !best ||
      cand.shotsCovered > best.shotsCovered ||
      (cand.shotsCovered === best.shotsCovered &&
        (cand.sampleHit > best.sampleHit ||
          (cand.sampleHit === best.sampleHit &&
            (cand.assetHit > best.assetHit ||
              (cand.assetHit === best.assetHit && Math.hypot(off[0], off[2]) < Math.hypot(best.off[0], best.off[2]))))));
    if (better) best = cand;
  };

  // 两段搜索：各旋转档在可行圆盘内粗搜（coarseStep）→ 最优档邻域细搜（fineStep × 相邻旋转档）
  const rotSteps = rotationSteps(rotStepDeg);
  for (const rotDeg of rotSteps) {
    const [cx, cz] = rotatePoint(centroid, rotDeg);
    const grid = Math.ceil(discR / coarseStep);
    for (let ix = -grid; ix <= grid; ix += 1) {
      for (let iz = -grid; iz <= grid; iz += 1) {
        const ox = cx + ix * coarseStep;
        const oz = cz + iz * coarseStep;
        if (Math.hypot(ox, oz) > discR + 1e-9) continue;
        consider([ox, 0, oz], rotDeg);
      }
    }
  }
  if (!best) return null;
  const gridF = Math.ceil(coarseStep / fineStep) * fineStep;
  for (const dR of [-rotStepDeg, 0, rotStepDeg]) {
    const rotDeg = best.rotDeg + dR;
    const [cx, cz] = rotatePoint(centroid, rotDeg);
    for (let ix = -gridF; ix <= gridF + 1e-9; ix += fineStep) {
      for (let iz = -gridF; iz <= gridF + 1e-9; iz += fineStep) {
        const ox = best.off[0] + ix;
        const oz = best.off[2] + iz;
        if (Math.hypot(ox, oz) > discR + 1e-9) continue;
        consider([ox, 0, oz], rotDeg);
      }
    }
  }

  const final = shotCoveredAt(best.off, best.rotDeg);
  const originM = shotCoveredAt([0, 0, 0], 0);
  const pct1 = (n, t) => (t > 0 ? Math.round((n / t) * 1000) / 10 : 0);
  return {
    offset: [round2(best.off[0]), 0, round2(best.off[2])],
    rotationDeg: best.rotDeg,
    coveredShotIds: shotIds.filter((sid) => {
      const list = byShot.get(sid);
      return list.every((s) => actorScore(s.cam, s.pt, best.off, best.rotDeg, ring, range));
    }),
    shotCoverage: shotIds.map((sid) => {
      const list = byShot.get(sid);
      const hit = list.filter((s) => actorScore(s.cam, s.pt, best.off, best.rotDeg, ring, range)).length;
      return { id: sid, hit, total: list.length, covered: hit === list.length };
    }),
    actorBacked: pct1(final.sampleHit, allSamples.length),
    actorBackedOrigin: pct1(originM.sampleHit, allSamples.length),
    assetBacked: pct1(final.assetHit, anchors.length),
    sampleCount: allSamples.length,
    assetCount: anchors.length,
    shotCount: shotIds.length,
    shotsCovered: final.shotsCovered,
    contentRadiusM: round2(contentRadius),
    discRadiusM: round2(discR),
    headY: ACTOR_HEAD_Y,
    method: `内容位姿搜索 平移${coarseStep}m×旋转${rotStepDeg}°粗搜→${fineStep}m细搜；预筛=内容包围圆(${round2(contentRadius)}m)可行圆盘(r=${round2(discR)}m)；目标=覆盖镜头数→采样命中→资产入屏→偏移小；数据=UE take 走位序列 + 置景资产包围盒`,
  };
}

/**
 * 收集一个场次所有镜头的演员走位采样点
 * @returns [{ cam:[x,y,z] 采样时刻的相机位置, pt:[x,z] 演员地面位置, shot 镜头 id }]
 */
function collectActorSamples(shots, peopleShots) {
  const out = [];
  for (const shot of shots) {
    const track = peopleShots?.[shot.name];
    if (!track?.characters?.length) continue;
    const camKeys = shot.keys?.length ? shot.keys : [{ t: 0, position: shot.position }];
    // 相机关键帧时间 ≈ sourceSeconds + take 本地时间；走位 key.s 是 take 本地时间
    const base = camKeys[0].t;
    const camAt = (tt) => {
      if (camKeys.length === 1) return camKeys[0].position;
      const target = base + tt;
      const last = camKeys[camKeys.length - 1];
      if (target <= camKeys[0].t) return camKeys[0].position;
      if (target >= last.t) return last.position;
      let lo = 0;
      let hi = camKeys.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (camKeys[mid].t <= target) lo = mid;
        else hi = mid;
      }
      const a = camKeys[lo];
      const b = camKeys[hi];
      const f = (target - a.t) / Math.max(1e-6, b.t - a.t);
      return [
        a.position[0] + (b.position[0] - a.position[0]) * f,
        a.position[1] + (b.position[1] - a.position[1]) * f,
        a.position[2] + (b.position[2] - a.position[2]) * f,
      ];
    };
    for (const ch of track.characters) {
      const keys = ch.keys ?? [];
      const step = Math.max(1, Math.ceil(keys.length / MAX_SAMPLES_PER_CHAR));
      for (let i = 0; i < keys.length; i += step) {
        const k = keys[i];
        const p = k?.p;
        if (!Array.isArray(p) || p.length < 3) continue;
        out.push({ cam: camAt(k.s ?? 0), pt: [p[0], p[2]], shot: shot.id });
      }
    }
  }
  return out;
}

/**
 * 单个采样点在给定环心偏移下的「表演区在屏内」得分（0/1）
 * 判据：演员在环内，且相机经演员头顶(1.7m)延伸的视线命中环屏弧段内、屏高范围内、演员身后。
 * （脚部视线延伸必然落到屏底以下，由地面与屏底衔接，不参与判定）
 * 相机在环外或演员在环外 → 0 分。
 */

/**
 * 置景资产锚点得分（0/1）：资产在环内，且资产方向落在屏体弧段内（背后是屏不是缺口）。
 * 锚点取资产顶面中心；资产高于屏体的部分由「顶部延伸遮光」方案兜底，不参与此项判定。
 */
