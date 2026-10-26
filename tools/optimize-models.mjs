/**
 * 优化 UE 导出的 GLB：贴图转 WebP 外置共享 + 几何 meshopt 压缩 + 坐标烘焙
 *
 * 1. 贴图：最长边 512，统一转 WebP(q72)，按内容哈希写到 models/tex/ 共享，
 *    GLB 内只保留相对 URI（117 张贴图被 53 个模型重复引用，去重后只存一份）
 * 2. 几何：meshopt（EXT_meshopt_compression，three 用 MeshoptDecoder 解码）+ 顶点量化
 * 3. 坐标：UE 导出的 GLB 是 (UE_X, UE_Z, UE_Y)、单位厘米；
 *    前端约定 three = (UE_Y, UE_Z, -UE_X) 米，差一个「绕 Y 轴 +90° + 缩放 0.01」，
 *    这里烘焙成包装节点，前端无需特殊处理。
 *
 * 原始导出备份在 .models-raw/（不入库），可随时重跑。
 * 用法：node tools/optimize-models.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, weld, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'server', 'public', 'models');
const TEX_DIR = path.join(MODELS_DIR, 'tex');
const RAW_DIR = path.join(ROOT, '.models-raw');
const MANIFEST = path.join(ROOT, 'server', 'data', 'ue-gltf-manifest.json');

const TEXTURE_MAX = 512;
const WEBP_QUALITY = 72;
/** 绕 Y 轴 +90° 的四元数分量：sin(45°), cos(45°) */
const Y90 = Math.SQRT1_2;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

/** 已写出的共享贴图：内容哈希 → 字节数 */
const texCache = new Map();
let texBytes = 0;

async function embedTextures(doc) {
  let textures = 0;
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const source = Buffer.from(image);

    let encoded;
    try {
      encoded = await sharp(source)
        .resize(TEXTURE_MAX, TEXTURE_MAX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, alphaQuality: 80 })
        .toBuffer();
    } catch {
      continue;
    }
    if (encoded.length === 0) continue;

    texture.setImage(new Uint8Array(encoded));
    texture.setMimeType('image/webp');
    textures += 1;

    const hash = crypto.createHash('md5').update(encoded).digest('hex').slice(0, 16);
    if (!texCache.has(hash)) {
      texCache.set(hash, encoded.length);
      texBytes += encoded.length;
    }
  }

  if (textures > 0) doc.createExtension(EXTTextureWebP).setRequired(true);
}

/** 把 GLB 根节点包一层：厘米 → 米，UE 轴向 → 项目轴向 */
function bakeAxis(doc) {
  const scene = doc.getRoot().listScenes()[0];
  if (!scene) return;
  const roots = scene.listChildren();
  if (roots.length === 0) return;
  if (roots.length === 1 && roots[0].getName() === '__ue_to_meters') return;

  const wrapper = doc
    .createNode('__ue_to_meters')
    .setTranslation([0, 0, 0])
    .setRotation([0, Y90, 0, Y90])
    .setScale([0.01, 0.01, 0.01]);
  for (const root of roots) {
    scene.removeChild(root);
    wrapper.addChild(root);
  }
  scene.addChild(wrapper);
}

async function optimize(file) {
  const doc = await io.read(path.join(RAW_DIR, file));
  await embedTextures(doc);
  await doc.transform(
    dedup(),
    weld(),
    prune(),
    quantize({
      quantizePosition: 14,
      quantizeNormal: 10,
      quantizeTexcoord: 12,
      quantizeColor: 8,
      quantizeGeneric: 12,
    }),
  );
  bakeAxis(doc);
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));

  const outPath = path.join(MODELS_DIR, file);
  await io.write(outPath, doc);
  return { bytes: fs.statSync(outPath).size, rawBytes: fs.statSync(path.join(RAW_DIR, file)).size };
}

async function main() {
  await MeshoptEncoder.ready;
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const files = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb'));
  for (const file of files) {
    const rawPath = path.join(RAW_DIR, file);
    if (!fs.existsSync(rawPath)) fs.copyFileSync(path.join(MODELS_DIR, file), rawPath);
  }

  let totalRaw = 0;
  let totalOut = 0;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  for (const [index, file] of files.entries()) {
    const result = await optimize(file);
    totalRaw += result.rawBytes;
    totalOut += result.bytes;
    const info = Object.values(manifest.models).find((m) => m.file === file);
    if (info) info.bytes = result.bytes;
    console.log(
      `[opt] ${index + 1}/${files.length} ${file} ${(result.rawBytes / 1048576).toFixed(2)}MB → ${(
        result.bytes / 1048576
      ).toFixed(2)}MB`,
    );
  }

  manifest.optimizedAt = new Date().toISOString();
  manifest.optimized = {
    textureFormat: 'webp',
    textureMax: TEXTURE_MAX,
    textureQuality: WEBP_QUALITY,
    uniqueTextures: texCache.size,
    geometry: 'meshopt + quantize',
    axis: 'wrapper yaw +90deg, scale 0.01',
  };
  manifest.totalBytes = totalOut;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));

  console.log(
    `[opt] 完成：GLB ${(totalRaw / 1048576).toFixed(1)}MB → ${(totalOut / 1048576).toFixed(1)}MB；唯一贴图 ${
      texCache.size
    } 张 ${(texBytes / 1048576).toFixed(1)}MB`,
  );
}

main().catch((err) => {
  console.error('[opt] 失败:', err);
  process.exit(1);
});
