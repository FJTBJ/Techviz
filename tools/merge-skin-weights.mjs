/**
 * 把 glb 中每个顶点超过 4 个的骨骼影响合并为 4 个并归一化。
 *
 * 背景：UE 的 glTF 导出器会输出 JOINTS_0/1/2 + WEIGHTS_0/1/2（每顶点最多 12 个骨骼影响），
 * 而 three.js 的 SkinnedMesh 只读取第一组 4 个影响，其余被丢弃，导致顶点权重和远小于 1、模型塌缩。
 *
 * 用法：node merge-skin-weights.mjs <in.glb> <out.glb>
 */
import fs from 'node:fs';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('usage: node merge-skin-weights.mjs <in.glb> <out.glb>');
  process.exit(1);
}

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

function addAccessor({ bufferView, componentType, count, type, normalized }) {
  json.accessors.push({ bufferView, componentType, count, type, ...(normalized ? { normalized } : {}) });
  return json.accessors.length - 1;
}

let merged = 0;
for (const mesh of json.meshes ?? []) {
  for (const prim of mesh.primitives) {
    const attrs = prim.attributes;
    if (attrs.JOINTS_0 === undefined || attrs.WEIGHTS_0 === undefined) continue;

    const jointSets = [0, 1, 2].map((i) => attrs[`JOINTS_${i}`]).filter((v) => v !== undefined && v !== null);
    const weightSets = [0, 1, 2].map((i) => attrs[`WEIGHTS_${i}`]).filter((v) => v !== undefined && v !== null);
    if (jointSets.length <= 1) continue;

    const joints = jointSets.map(readAccessor);
    const weights = weightSets.map(readAccessor);
    const count = json.accessors[attrs.POSITION].count;

    const outJoints = Buffer.alloc(count * 4 * 2);
    const outWeights = Buffer.alloc(count * 4);

    for (let v = 0; v < count; v++) {
      const influences = [];
      for (let s = 0; s < joints.length; s++) {
        for (let c = 0; c < 4; c++) {
          const w = weights[s][v]?.[c] ?? 0;
          if (w > 0) influences.push([joints[s][v][c], w]);
        }
      }
      influences.sort((a, b) => b[1] - a[1]);
      const top = influences.slice(0, 4);
      const sum = top.reduce((acc, [, w]) => acc + w, 0) || 1;
      for (let i = 0; i < 4; i++) {
        const [joint, weight] = top[i] ?? [0, 0];
        outJoints.writeUInt16LE(joint, (v * 4 + i) * 2);
        outWeights.writeUInt8(Math.round((weight / sum) * 255), v * 4 + i);
      }
    }

    const jointView = appendBufferView(outJoints);
    const weightView = appendBufferView(outWeights);
    attrs.JOINTS_0 = addAccessor({
      bufferView: jointView,
      componentType: 5123,
      count,
      type: 'VEC4',
      normalized: false,
    });
    attrs.WEIGHTS_0 = addAccessor({
      bufferView: weightView,
      componentType: 5121,
      count,
      type: 'VEC4',
      normalized: true,
    });
    delete attrs.JOINTS_1;
    delete attrs.JOINTS_2;
    delete attrs.WEIGHTS_1;
    delete attrs.WEIGHTS_2;
    merged++;
  }
}

json.buffers[0].byteLength = bin.length;
json.asset.generator = (json.asset.generator ?? '') + ' + skin-weights-merged(4)';

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
console.log(`merged ${merged} primitive(s) -> ${output}`);
