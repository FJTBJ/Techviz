/**
 * 解剖 GLB 各 attribute：看坏掉的 POSITION 是否与其他通道存在置换/缩放关系。
 * 用法：node tools/inspect-attrs.mjs
 */
import fs from 'node:fs';

const path = process.argv[2] ?? 'public/models/s079a/nuola_sk.glb';
const src = fs.readFileSync(path);
const jsonLen = src.readUInt32LE(12);
const json = JSON.parse(src.subarray(20, 20 + jsonLen).toString('utf8'));
const binChunk = 20 + jsonLen;
const binLen = src.readUInt32LE(binChunk);
const bin = src.subarray(binChunk + 8, binChunk + 8 + binLen);

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
      if (acc.componentType === 5121) row.push(acc.normalized ? bin.readUInt8(at) / 255 : bin.readUInt8(at));
      else if (acc.componentType === 5123) row.push(acc.normalized ? bin.readUInt16LE(at) / 65535 : bin.readUInt16LE(at));
      else if (acc.componentType === 5125) row.push(bin.readUInt32LE(at));
      else row.push(bin.readFloatLE(at));
    }
    rows.push(row);
  }
  return rows;
}

for (let mi = 0; mi < json.meshes.length; mi++) {
  const mesh = json.meshes[mi];
  console.log(`=== mesh#${mi} ===`);
  for (const prim of mesh.primitives) {
    const attrs = prim.attributes;
    console.log('attributes:', Object.entries(attrs).map(([k, v]) => {
      const a = json.accessors[v];
      return `${k}[${a.componentType}${a.normalized ? 'n' : ''}]count=${a.count}`;
    }).join(' '));
    console.log('accessor declared min/max for POSITION:', JSON.stringify(json.accessors[attrs.POSITION].min), JSON.stringify(json.accessors[attrs.POSITION].max));

    const pos = readAccessor(attrs.POSITION);
    const normal = attrs.NORMAL !== undefined ? readAccessor(attrs.NORMAL) : null;
    const tangent = attrs.TANGENT !== undefined ? readAccessor(attrs.TANGENT) : null;
    const color = attrs.COLOR_0 !== undefined ? readAccessor(attrs.COLOR_0) : null;
    const uv0 = attrs.TEXCOORD_0 !== undefined ? readAccessor(attrs.TEXCOORD_0) : null;
    const joints = attrs.JOINTS_0 !== undefined ? readAccessor(attrs.JOINTS_0) : null;
    const weights = attrs.WEIGHTS_0 !== undefined ? readAccessor(attrs.WEIGHTS_0) : null;

    console.log('-- 前 5 个顶点 --');
    for (let i = 0; i < 5; i++) {
      const f = (r) => (r ? r[i].map((v) => (typeof v === 'number' ? +v.toFixed(4) : v)).join(',') : 'N/A');
      console.log(`v${i}: pos=(${f(pos)}) normal=(${f(normal)}) tangent=(${f(tangent)}) color=(${f(color)}) uv0=(${f(uv0)}) j0=${joints ? joints[i].join(',') : 'N/A'} w0=${weights ? weights[i].map((v) => +v.toFixed(3)).join(',') : 'N/A'}`);
    }

    // POSITION 各分量范围
    const ranges = [0, 1, 2].map((c) => {
      let mn = Infinity, mx = -Infinity;
      for (const r of pos) { if (r[c] < mn) mn = r[c]; if (r[c] > mx) mx = r[c]; }
      return `[${mn.toFixed(3)},${mx.toFixed(3)}]`;
    });
    console.log('POSITION 各分量范围:', ranges.join(' '));

    // POSITION 与 NORMAL 是否相同/置换
    if (normal) {
      const tests = {
        'pos==normal': [0, 1, 2],
        'pos==normal(置换xzy)': [0, 2, 1],
      };
      let same = 0, perm = 0;
      const stepN = Math.max(1, Math.floor(pos.count / 2000));
      let cnt = 0;
      for (let i = 0; i < pos.count; i += stepN) {
        cnt++;
        const p = pos[i], n = normal[i];
        if (Math.abs(p[0] - n[0]) < 1e-4 && Math.abs(p[1] - n[1]) < 1e-4 && Math.abs(p[2] - n[2]) < 1e-4) same++;
        if (Math.abs(p[0] - n[0]) < 1e-4 && Math.abs(p[1] - n[2]) < 1e-4 && Math.abs(p[2] - n[1]) < 1e-4) perm++;
      }
      console.log(`POSITION==NORMAL: ${same}/${cnt}, 置换: ${perm}/${cnt}`);
    }
    // POSITION 分量离散度：是否只有少数离散值（说明是索引类数据被当成了浮点）
    const uniq = new Set();
    for (let i = 0; i < pos.count; i++) uniq.add(pos[i][0].toFixed(4));
    console.log(`POSITION.x 唯一值数量: ${uniq.size} / ${pos.count}`);
  }
}
