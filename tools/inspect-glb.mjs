/**
 * 校验从 UE 导出的 GLB：文件体积、三角面数、以及坐标轴/单位是否与前端约定一致
 *
 * 用法：node tools/inspect-glb.mjs [模型数量，默认 8]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'server', 'data', 'ue-gltf-manifest.json');
const MESH_MAP = path.join(ROOT, 'server', 'data', 'ue-mesh-map.json');
const MODELS_DIR = path.join(ROOT, 'server', 'public', 'models');

/** 读取 GLB 的 JSON chunk */
function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB');
  const chunkLength = buf.readUInt32LE(12);
  const chunkType = buf.readUInt32LE(16);
  if (chunkType !== 0x4e4f534a) throw new Error('首个 chunk 不是 JSON');
  return JSON.parse(buf.subarray(20, 20 + chunkLength).toString('utf8'));
}

function boundsOf(gltf) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const posIndex = primitive.attributes?.POSITION;
      const accessor = posIndex != null ? gltf.accessors?.[posIndex] : null;
      if (accessor?.min && accessor?.max) {
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], accessor.min[i]);
          max[i] = Math.max(max[i], accessor.max[i]);
        }
      }
      const indices = primitive.indices != null ? gltf.accessors?.[primitive.indices] : null;
      const count = indices?.count ?? accessor?.count ?? 0;
      triangles += Math.floor(count / 3);
    }
  }
  return { min, max, triangles };
}

const limit = Number(process.argv[2] || 8);
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const map = JSON.parse(fs.readFileSync(MESH_MAP, 'utf8'));

let totalBytes = 0;
let totalTris = 0;
const rows = [];
for (const [asset, info] of Object.entries(manifest.models ?? {})) {
  const file = path.join(MODELS_DIR, info.file);
  if (!fs.existsSync(file)) continue;
  const bytes = fs.statSync(file).size;
  totalBytes += bytes;
  if (!file.endsWith('.glb')) {
    rows.push({ asset, file: info.file, bytes, triangles: info.triangles ?? null, note: '非 GLB' });
    continue;
  }
  try {
    const gltf = readGlbJson(file);
    const { min, max, triangles } = boundsOf(gltf);
    totalTris += triangles;
    const ue = map.meshBounds?.[asset];
    rows.push({
      asset,
      file: info.file,
      bytes,
      triangles,
      glbSizeM: max.map((v, i) => +(v - min[i]).toFixed(3)),
      glbMin: min.map((v) => +v.toFixed(3)),
      glbMax: max.map((v) => +v.toFixed(3)),
      ueExtentCm: ue?.extentCm ?? null,
      ueOriginCm: ue?.originCm ?? null,
    });
  } catch (err) {
    rows.push({ asset, file: info.file, bytes, error: String(err) });
  }
}

rows.sort((a, b) => b.bytes - a.bytes);
console.log(`模型 ${rows.length} 个，合计 ${(totalBytes / 1048576).toFixed(2)} MB，三角面 ${totalTris.toLocaleString()}`);
console.log('（对照 ueExtentCm：UE 网格本地包围盒半尺寸×2，单位厘米）\n');
for (const row of rows.slice(0, limit)) {
  console.log(JSON.stringify(row, null, 1));
}
