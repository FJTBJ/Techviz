/**
 * 分析 GLB 体积构成：几何 vs 贴图，并统计重复贴图
 * 用法：node tools/analyze-glb.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'server', 'public', 'models');

function parseGlb(file) {
  const buf = fs.readFileSync(file);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8;
  return { json, bin: buf.subarray(binStart) };
}

const files = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb'));
const seen = new Map();
let geometryBytes = 0;
let imageBytes = 0;
const imageStats = [];

for (const file of files) {
  const { json, bin } = parseGlb(path.join(MODELS_DIR, file));
  const usedViews = new Set();
  for (const image of json.images ?? []) {
    if (image.bufferView == null) continue;
    const view = json.bufferViews[image.bufferView];
    usedViews.add(image.bufferView);
    const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const hash = crypto.createHash('md5').update(data).digest('hex').slice(0, 12);
    if (!seen.has(hash)) seen.set(hash, data.length);
    imageBytes += data.length;
    imageStats.push({ file, bytes: data.length, hash, size: `${data.length / 1024 | 0}KB` });
  }
  for (const view of json.bufferViews ?? []) {
    if (!usedViews.has(json.bufferViews.indexOf(view))) geometryBytes += view.byteLength;
  }
}

console.log(`模型 ${files.length} 个`);
console.log(`几何/其它：${(geometryBytes / 1048576).toFixed(2)} MB`);
console.log(`贴图原始总量：${(imageBytes / 1048576).toFixed(2)} MB，唯一贴图 ${seen.size} 张，去重后 ${([...seen.values()].reduce((a, b) => a + b, 0) / 1048576).toFixed(2)} MB`);
const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [hash, size] of top) console.log(`  ${hash}  ${(size / 1024).toFixed(0)} KB`);
