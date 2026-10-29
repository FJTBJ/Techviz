/**
 * 用 UE 端逐顶点转储的 bind-pose 位置，修补 GLB 中被导出器写坏的 POSITION。
 *
 * 原理：
 * - dump JSON 的位置是 UE 组件空间（厘米、Z-up）；
 * - GLB 的 inverseBindMatrices 期望的网格空间 = UE bind 网格空间经过导出器的轴变换；
 * - 对 48 种轴排列/符号（含两种 section 顺序）逐一打分：
 *   取顶点的主骨骼 j，计算 |IB_j · p|（bind 空间下顶点到其骨骼原点的距离），
 *   正确映射下该距离应很小 → 总分最小者即正确映射；
 * - 命中后用新位置覆盖 POSITION（追加新 bufferView/accessor，不动旧数据）。
 *
 * 用法：node tools/patch-positions.mjs <dump.json> <in.glb> <out.glb>
 */
import fs from 'node:fs';

const [, , dumpPath, input, output] = process.argv;
if (!dumpPath || !input || !output) {
  console.error('usage: node patch-positions.mjs <dump.json> <in.glb> <out.glb>');
  process.exit(1);
}

// ---------- GLB 解析 ----------
const src = fs.readFileSync(input);
const jsonLen = src.readUInt32LE(12);
const json = JSON.parse(src.subarray(20, 20 + jsonLen).toString('utf8'));
const binChunk = 20 + jsonLen;
const binLen = src.readUInt32LE(binChunk);
let bin = Buffer.from(src.subarray(binChunk + 8, binChunk + 8 + binLen));

const COMP_SIZE = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const COMP_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const comps = COMP_COUNT[acc.type];
  const compSize = COMP_SIZE[acc.componentType];
  const stride = view.byteStride || comps * compSize;
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const rows = [];
  for (let i = 0; i < acc.count; i++) {
    const row = [];
    const offset = base + i * stride;
    for (let c = 0; c < comps; c++) {
      const at = offset + c * compSize;
      if (acc.componentType === 5121) row.push(bin.readUInt8(at));
      else if (acc.componentType === 5123) row.push(bin.readUInt16LE(at));
      else if (acc.componentType === 5125) row.push(bin.readUInt32LE(at));
      else row.push(bin.readFloatLE(at));
    }
    rows.push(row);
  }
  return rows;
}

function appendBufferView(data) {
  const pad = (4 - (bin.length % 4)) % 4;
  if (pad) bin = Buffer.concat([bin, Buffer.alloc(pad)]);
  const byteOffset = bin.length;
  bin = Buffer.concat([bin, data]);
  json.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length });
  return json.bufferViews.length - 1;
}

function addAccessor({ bufferView, componentType, count, type, min, max }) {
  json.accessors.push({ bufferView, componentType, count, type, min, max });
  return json.accessors.length - 1;
}

// ---------- 候选变换 ----------
// 48 种轴映射：p' = s * (p[a0], p[a1], p[a2])，含 det±1
const candidates = [];
for (let perm = 0; perm < 6; perm++) {
  const p = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][perm];
  for (let signs = 0; signs < 8; signs++) {
    const s = [(signs & 1) ? -1 : 1, (signs & 2) ? -1 : 1, (signs & 4) ? -1 : 1];
    candidates.push({ perm: p, signs: s });
  }
}

// ---------- 读取 dump ----------
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const dumpPos = dump.positions;
console.log(`dump: ${dump.vertexCount} verts, ${dumpPos.length} loaded`);

// ---------- 找到 skinned primitives 与 skin ----------
const primInfos = [];
for (const mesh of json.meshes ?? []) {
  for (const prim of mesh.primitives) {
    if (prim.attributes.POSITION === undefined || prim.skin === undefined) continue;
    if (prim.attributes.JOINTS_0 === undefined || prim.attributes.WEIGHTS_0 === undefined) continue;
    const joints = readAccessor(prim.attributes.JOINTS_0);
    const weightsAcc = json.accessors[prim.attributes.WEIGHTS_0];
    const wView = json.bufferViews[weightsAcc.bufferView];
    const wBase = (wView.byteOffset ?? 0) + (weightsAcc.byteOffset ?? 0);
    const stride = wView.byteStride || 4;
    const skin = json.skins[prim.skin];
    const ibRows = readAccessor(skin.inverseBindMatrices);
    primInfos.push({
      prim,
      count: json.accessors[prim.attributes.POSITION].count,
      joints,
      weightBase: wBase,
      weightStride: stride,
      weightNormalized: weightsAcc.normalized === true,
      ib: ibRows,
    });
  }
}
console.log(`skinned primitives: ${primInfos.length}, counts: ${primInfos.map((p) => p.count).join(', ')}`);
if (primInfos.reduce((a, p) => a + p.count, 0) !== dumpPos.length) {
  console.error('!! 顶点总数与 dump 不一致，退出');
  process.exit(1);
}

function boneLocalDist(info, vIdx, p) {
  // 主骨骼 j，|IB_j · p|
  let bestJ = 0;
  let bestW = -1;
  const at = info.weightBase + vIdx * info.weightStride;
  for (let k = 0; k < 4; k++) {
    let w = bin.readUInt8(at + k);
    if (info.weightNormalized) w /= 255;
    if (w > bestW) { bestW = w; bestJ = info.joints[vIdx][k]; }
  }
  if (bestW < 0.2) return null; // 权重不可靠的顶点跳过
  const m = info.ib[bestJ];
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  return Math.sqrt(x * x + y * y + z * z);
}

// section 切分：两种顺序假设
const counts = primInfos.map((p) => p.count);
const orders = [counts, [counts[1], counts[0]]];

const SCALE = 0.01; // cm -> m
const STEP = 5; // 每 5 个顶点采样一个打分

let best = null;
for (let oi = 0; oi < orders.length; oi++) {
  const order = orders[oi];
  const slices = [];
  let off = 0;
  for (let i = 0; i < primInfos.length; i++) {
    slices.push([off, off + order[i]]);
    off += order[i];
  }
  for (const cand of candidates) {
    const [a0, a1, a2] = cand.perm;
    const [s0, s1, s2] = cand.signs;
    let total = 0;
    let n = 0;
    for (let pi = 0; pi < primInfos.length; pi++) {
      const info = primInfos[pi];
      const [start] = slices[pi];
      for (let v = 0; v < info.count; v += STEP) {
        const d = dumpPos[start + v];
        const p = [d[a0] * s0 * SCALE, d[a1] * s1 * SCALE, d[a2] * s2 * SCALE];
        const dist = boneLocalDist(info, v, p);
        if (dist !== null) { total += dist; n++; }
      }
    }
    const score = n ? total / n : Infinity;
    if (!best || score < best.score) {
      best = { score, oi, cand, slices, n };
    }
  }
}
console.log(`best score=${best.score.toFixed(4)}m (order=${best.oi}, perm=${best.cand.perm}, signs=${best.cand.signs}, samples=${best.n})`);
if (best.score > 0.5) {
  console.error('!! 最优映射的骨骼距离仍偏大（>0.5m），映射可能有误，请人工核对');
}

// ---------- 补丁 POSITION ----------
for (let pi = 0; pi < primInfos.length; pi++) {
  const info = primInfos[pi];
  const [start] = best.slices[pi];
  const [a0, a1, a2] = best.cand.perm;
  const [s0, s1, s2] = best.cand.signs;
  const data = Buffer.alloc(info.count * 12);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < info.count; v++) {
    const d = dumpPos[start + v];
    const x = d[a0] * s0 * SCALE;
    const y = d[a1] * s1 * SCALE;
    const z = d[a2] * s2 * SCALE;
    data.writeFloatLE(x, v * 12);
    data.writeFloatLE(y, v * 12 + 4);
    data.writeFloatLE(z, v * 12 + 8);
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  const view = appendBufferView(data);
  const acc = addAccessor({ bufferView: view, componentType: 5126, count: info.count, type: 'VEC3', min, max });
  info.prim.attributes.POSITION = acc;
  console.log(`prim#${pi}: patched ${info.count} verts, bbox=(${min.map((v) => v.toFixed(2))})..(${max.map((v) => v.toFixed(2))})`);
}

json.buffers[0].byteLength = bin.length;
json.asset.generator = (json.asset.generator ?? '') + ' + positions-patched(ue-dump)';

let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = (4 - (jsonBuffer.length % 4)) % 4;
if (jsonPad) jsonBuffer = Buffer.concat([jsonBuffer, Buffer.from(' '.repeat(jsonPad))]);
const binPad = (4 - (bin.length % 4)) % 4;
if (binPad) bin = Buffer.concat([bin, Buffer.alloc(binPad)]);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuffer.length + 8 + bin.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBuffer.length, 0);
jsonHeader.write('JSON', 4, 'ascii');
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.write('BIN\0', 4, 'ascii');

fs.writeFileSync(output, Buffer.concat([header, jsonHeader, jsonBuffer, binHeader, bin]));
console.log(`patched -> ${output}`);
