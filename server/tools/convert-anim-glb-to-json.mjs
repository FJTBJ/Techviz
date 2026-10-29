/**
 * 把 UE 导出的骨骼动画 GLB 转成 json 骨架数据：
 *   node server/tools/convert-anim-glb-to-json.mjs <in.glb> <out.json> [fps]
 *
 * 输出内容：主骨骼层级（rest 变换）+ 每根骨骼的旋转关键帧（pelvis 含位移），
 * 前端据此程序化搭建体积人形，运行时不再依赖 glb 模型文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath, fpsArg] = process.argv;
if (!inPath || !outPath) {
  console.error('用法: node convert-anim-glb-to-json.mjs <in.glb> <out.json> [fps=15]');
  process.exit(1);
}
const FPS = Number(fpsArg) || 15;

// ---- GLB 解析 ----
const buf = readFileSync(inPath);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binChunkOff = 20 + jsonLen + 8;
const binLen = buf.readUInt32LE(20 + jsonLen);
const bin = buf.subarray(binChunkOff, binChunkOff + binLen);

const COMPONENT = { 5126: 4, 5123: 2, 5121: 1 };
const TYPE_N = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
function readAccessor(acc) {
  const n = TYPE_N[acc.type];
  const bytes = n * COMPONENT[acc.componentType];
  let src = bin;
  let offset = (acc.byteOffset ?? 0);
  if (acc.bufferView != null) {
    const bv = json.bufferViews[acc.bufferView];
    src = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    offset = acc.byteOffset ?? 0;
  }
  const out = new Float32Array(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < n; c++) out[i * n + c] = src.readFloatLE(offset + i * bytes + c * 4);
  }
  return out;
}

// ---- 主骨骼过滤（与前端渲染一致，减小体积）----
// 白名单精确匹配 MetaHuman 核心运动骨骼，排除大量 corrective/肌肉辅助骨骼
const KEEP = /^(pelvis$|spine_0[1-5]$|neck_01$|head$|clavicle_[lr]$|upperarm_[lr]$|lowerarm_[lr]$|hand_$|hand_[lr]$|thumb_0[1-3]_[lr]$|thigh_[lr]$|calf_[lr]$|foot_[lr]$|ball_[lr]$)/i;
const DROP = /thumb|index|middle|ring|pinky|twist|_drv|roll|corrective|bicep|tricep|pec|scap|latissimus|knee|_bck|_in|_out|_fwd|heel/i;

const clip = json.animations?.[0];
if (!clip) {
  console.error('GLB 内没有动画轨道');
  process.exit(1);
}

// 动画涉及的节点 → 骨骼集合
const animatedNames = new Set();
for (const ch of clip.channels) {
  const node = json.nodes[ch.target.node];
  if (KEEP.test(node.name) && !DROP.test(node.name)) animatedNames.add(ch.target.node);
}

// 构建骨骼树：从场景根找到骨架根，收集主骨骼并保持父子关系
const nodes = json.nodes;
const childOf = new Map(); // childIndex -> parentIndex
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => childOf.set(c, i)));

// 找骨架根（主骨骼中父链上不再有主骨骼的）
const bones = [...animatedNames].sort((a, b) => a - b);
const isKept = (i) => KEEP.test(nodes[i].name) && !DROP.test(nodes[i].name);
const boneList = [];
const indexByNode = new Map();
for (const bi of bones) {
  let p = childOf.get(bi);
  while (p != null && !isKept(p)) p = childOf.get(p);
  indexByNode.set(bi, boneList.length);
  boneList.push({ node: bi, parentNode: p != null && indexByNode.has(p) ? p : null, parentIdx: null });
}
boneList.forEach((b) => {
  b.parentIdx = b.parentNode != null ? indexByNode.get(b.parentNode) : -1;
});

// rest 变换
const restOf = (i) => {
  const n = nodes[i];
  return {
    pos: n.translation ?? [0, 0, 0],
    quat: n.rotation ?? [0, 0, 0, 1],
  };
};

// ---- 动画轨道抽取与降采样 ----
// glTF sampler: input=时间(s)，output=值。旋转四元数 glTF 为 (x,y,z,w)。
const trackByNode = new Map(); // node -> { times, rot?, pos? }
for (const ch of clip.channels) {
  if (!animatedNames.has(ch.target.node)) continue;
  const sampler = clip.samplers[ch.sampler];
  const times = readAccessor({ ...json.accessors[sampler.input] });
  const out = readAccessor({ ...json.accessors[sampler.output] });
  let t = trackByNode.get(ch.target.node);
  if (!t) { t = {}; trackByNode.set(ch.target.node, t); }
  if (ch.target.path === 'rotation') t.rot = { times, out };
  if (ch.target.path === 'translation') t.pos = { times, out };
}

const duration = Math.max(...[...trackByNode.values()].flatMap((t) => [
  t.rot ? t.rot.times[t.rot.times.length - 1] : 0,
  t.pos ? t.pos.times[t.pos.times.length - 1] : 0,
]));
const frameCount = Math.floor(duration * FPS) + 1;

// nlerp 四元数（与 three 的 slerp 在小角度下几乎一致，离线足够）
function nlerp(a, b, f, o) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  o[0] = a[0] + (b[0] * s - a[0]) * f;
  o[1] = a[1] + (b[1] * s - a[1]) * f;
  o[2] = a[2] + (b[2] * s - a[2]) * f;
  o[3] = a[3] + (b[3] * s - a[3]) * f;
  const len = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
  o[0] /= len; o[1] /= len; o[2] /= len; o[3] /= len;
}

// rotFrames: 每帧 [骨骼0 quat(4), 骨骼1 quat(4), ...]；posFrames 仅 pelvis 的位移
const rotFrames = new Float32Array(frameCount * boneList.length * 4);
const pelvisIdx = boneList.findIndex((b) => /pelvis/i.test(nodes[b.node].name));
const posFrames = pelvisIdx >= 0 && trackByNode.get(boneList[pelvisIdx].node)?.pos
  ? new Float32Array(frameCount * 3) : null;

function sampleAxis(times, out, n, time, target) {
  // 找 time 所在区间做线性插值
  let lo = 0, hi = times.length - 1;
  if (time <= times[0]) { for (let c = 0; c < n; c++) target[c] = out[c]; return; }
  if (time >= times[hi]) { for (let c = 0; c < n; c++) target[c] = out[hi * n + c]; return; }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; (times[mid] <= time ? lo = mid : hi = mid); }
  const span = times[hi] - times[lo] || 1e-6;
  const f = (time - times[lo]) / span;
  for (let c = 0; c < n; c++) target[c] = out[lo * n + c] + (out[hi * n + c] - out[lo * n + c]) * f;
}

const q = new Float32Array(4);
const v = new Float32Array(3);
for (let f = 0; f < frameCount; f++) {
  const time = Math.min(f / FPS, duration);
  for (let i = 0; i < boneList.length; i++) {
    const t = trackByNode.get(boneList[i].node);
    const o = f * boneList.length * 4 + i * 4;
    if (t?.rot) {
      sampleAxis(t.rot.times, t.rot.out, 4, time, q);
      // 保证相邻帧同向，避免渲染端 nlerp 走远路
      if (o >= 4) {
        const p = o - 4;
        const d = q[0] * rotFrames[p] + q[1] * rotFrames[p + 1] + q[2] * rotFrames[p + 2] + q[3] * rotFrames[p + 3];
        if (d < 0) { q[0] = -q[0]; q[1] = -q[1]; q[2] = -q[2]; q[3] = -q[3]; }
      }
      rotFrames[o] = q[0]; rotFrames[o + 1] = q[1]; rotFrames[o + 2] = q[2]; rotFrames[o + 3] = q[3];
    } else {
      const rest = restOf(boneList[i].node);
      rotFrames[o] = rest.quat[0]; rotFrames[o + 1] = rest.quat[1];
      rotFrames[o + 2] = rest.quat[2]; rotFrames[o + 3] = rest.quat[3];
    }
  }
  if (posFrames) {
    const t = trackByNode.get(boneList[pelvisIdx].node);
    if (t?.pos) { sampleAxis(t.pos.times, t.pos.out, 3, time, v); posFrames[f * 3] = v[0]; posFrames[f * 3 + 1] = v[1]; posFrames[f * 3 + 2] = v[2]; }
  }
}

const round4 = (x) => Math.round(x * 10000) / 10000;
const r4 = (arr) => Array.from(arr, round4);

const result = {
  name: (json.asset?.generator ?? 'anim') + '|' + (inPath.split(/[\\/]/).pop() ?? ''),
  fps: FPS,
  duration: round4(duration),
  frameCount,
  bones: boneList.map((b) => {
    const rest = restOf(b.node);
    return {
      name: nodes[b.node].name,
      parent: b.parentIdx,
      pos: r4(rest.pos),
      quat: r4(rest.quat),
    };
  }),
  pelvisIndex: pelvisIdx,
  // 扁平帧数据：rotFrames[帧*骨骼数*4 + 骨骼*4]
  rotFrames: r4(rotFrames),
  ...(posFrames ? { posFrames: r4(posFrames) } : {}),
};

writeFileSync(outPath, JSON.stringify(result));
const kb = (Buffer.byteLength(JSON.stringify(result)) / 1024).toFixed(0);
console.log(`骨骼 ${boneList.length} 根，动画 ${duration.toFixed(2)}s → ${frameCount} 帧 @${FPS}fps，输出 ${kb}KB → ${outPath}`);
