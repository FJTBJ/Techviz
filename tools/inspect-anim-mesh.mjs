/**
 * 检查 nuola_anim.glb 是否内嵌了 SkinnedMesh 网格，及其 bind-pose 顶点分布是否正常。
 * 用法：node tools/inspect-anim-mesh.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('three');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');

function load(path) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const data = readFileSync(path);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    loader.parse(buf, '', (gltf) => resolve(gltf), reject);
  });
}

function stats(mesh, label) {
  const pos = mesh.geometry.attributes.position;
  const bb = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    bb.expandByPoint(v);
  }
  console.log(`[${label}] vertices=${pos.count}`);
  console.log(`[${label}] bind-pose bbox min=(${bb.min.x.toFixed(2)},${bb.min.y.toFixed(2)},${bb.min.z.toFixed(2)}) max=(${bb.max.x.toFixed(2)},${bb.max.y.toFixed(2)},${bb.max.z.toFixed(2)})`);
  // 高度直方图（1.8m 分 18 桶）
  const buckets = new Array(18).fill(0);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const idx = Math.min(17, Math.max(0, Math.floor(y / 0.1)));
    buckets[idx]++;
  }
  console.log(`[${label}] Y histogram (0.1m bins):`, buckets.join(' '));
  console.log(`[${label}] bones=${mesh.skeleton.bones.length} joints(usage)=${mesh.skeleton.boneInverses.length}`);
}

const gltf = await load('public/models/s079a/nuola_anim.glb');
console.log('=== nuola_anim.glb ===');
console.log('animations:', gltf.animations.length);
const skinned = [];
gltf.scene.traverse((o) => {
  if (o.isSkinnedMesh) skinned.push(o);
  else if (o.isMesh) skinned.push(o); // 普通网格也看
});
console.log('mesh count:', skinned.length);
skinned.forEach((m, i) => stats(m, `mesh#${i} type=${m.type} name=${m.name}`));
