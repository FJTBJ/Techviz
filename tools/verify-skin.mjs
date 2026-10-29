/**
 * 无头验证：用 three.js GLTFLoader 在 Node 端加载 GLB，
 * 对 SkinnedMesh 采样 bind pose 与动画 pose 下的顶点世界位置分布，
 * 判断「躯干顶点被拉飞」发生在数据层还是渲染层。
 *
 * 用法：node tools/verify-skin.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const THREE = require('three');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');

const DIR = 'public/models/s079a';

function load(path) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const data = readFileSync(path);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    loader.parse(buf, '', (gltf) => resolve(gltf), reject);
  });
}

function meshStats(mesh, label) {
  const posAttr = mesh.geometry.attributes.position;
  const skinIndex = mesh.geometry.attributes.skinIndex;
  const skinWeight = mesh.geometry.attributes.skinWeight;
  const bones = mesh.skeleton.bones;
  const boneMatrices = mesh.skeleton.boneMatrices ?? mesh.skeleton.boneTexture;

  // 权重统计
  let zeroSum = 0;
  for (let i = 0; i < skinWeight.count; i++) {
    const s = skinWeight.getX(i) + skinWeight.getY(i) + skinWeight.getZ(i) + skinWeight.getW(i);
    if (s < 0.5) zeroSum++;
  }

  // bind pose 顶点包围盒
  const bb = new THREE.Box3();
  for (let i = 0; i < posAttr.count; i++) {
    bb.expandByPoint(new THREE.Vector3().fromBufferAttribute(posAttr, i));
  }
  console.log(`[${label}] vertices=${posAttr.count} weightSum<0.5: ${zeroSum}`);
  console.log(`[${label}] bind-pose bbox min=(${bb.min.x.toFixed(2)},${bb.min.y.toFixed(2)},${bb.min.z.toFixed(2)}) max=(${bb.max.x.toFixed(2)},${bb.max.y.toFixed(2)},${bb.max.z.toFixed(2)})`);
  console.log(`[${label}] bones=${bones.length} root=${bones[0]?.name ?? 'N/A'}`);

  // 骨骼层级采样：root → 前 3 层的世界位置
  mesh.skeleton.pose();
  mesh.skeleton.update();
  const names = ['pelvis', 'spine_01', 'spine_02', 'neck_01', 'head', 'upperarm_l', 'hand_l', 'thigh_l', 'foot_l'];
  for (const n of names) {
    const b = bones.find((x) => x.name === n || x.name === n.replace('_', ' '));
    if (!b) { console.log(`[${label}] bone "${n}" NOT FOUND`); continue; }
    const p = new THREE.Vector3();
    b.getWorldPosition(p);
    console.log(`[${label}] bone ${n}: world=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) local=(${b.position.x.toFixed(3)}, ${b.position.y.toFixed(3)}, ${b.position.z.toFixed(3)})`);
  }
  // 按顶点高度分桶统计数量，判断哪些区间缺顶点
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < posAttr.count; i++) {
    const y = posAttr.getY(i);
    const idx = Math.min(9, Math.max(0, Math.floor(y / 0.07)));
    buckets[idx]++;
  }
  console.log(`[${label}] Y-height histogram (0.07m bins):`, buckets.join(' '));
}

const skGltf = await load(`${DIR}/nuola_sk.glb`);
console.log('=== model glb ===');
const skMeshes = [];
skGltf.scene.traverse((o) => { if (o.isSkinnedMesh) skMeshes.push(o); });
console.log('skinnedMesh count:', skMeshes.length);
skMeshes.forEach((m, i) => meshStats(m, `sk#${i}`));

const animGltf = await load(`${DIR}/nuola_anim.glb`);
console.log('=== anim glb ===');
console.log('animations:', animGltf.animations.length);
const clip = animGltf.animations[0];
console.log('clip tracks:', clip.tracks.length, 'duration:', clip.duration);

// 用模型的 mesh 播放动画 glb 的 clip，采样 t=0 和 t=3s 的躯干顶点位置
if (skMeshes[0]) {
  const mesh = skMeshes[0];
  const mixer = new THREE.AnimationMixer(mesh);
  const action = mixer.clipAction(clip);
  action.play();

  const sample = (t, label) => {
    mixer.setTime(t);
    mesh.skeleton.update();
    // 采样部分顶点的蒙皮结果
    const posAttr = mesh.geometry.attributes.position;
    const skinIdx = mesh.geometry.attributes.skinIndex;
    const skinW = mesh.geometry.attributes.skinWeight;
    const boneMatrices = mesh.skeleton.boneMatrices;
    const bm = new THREE.Matrix4();
    const vp = new THREE.Vector3();
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const step = Math.max(1, Math.floor(posAttr.count / 500));
    for (let i = 0; i < posAttr.count; i += step) {
      vp.fromBufferAttribute(posAttr, i);
      let out = new THREE.Vector3();
      for (let k = 0; k < 4; k++) {
        const bi = skinIdx.getComponent(k, i);
        const w = skinW.getComponent(k, i);
        if (w === 0) continue;
        bm.fromArray(boneMatrices, bi * 16);
        out = out.clone().add(vp.clone().applyMatrix4(bm).multiplyScalar(w));
      }
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], out.getComponent(a));
        max[a] = Math.max(max[a], out.getComponent(a));
      }
    }
    console.log(`[${label}] skinned bbox min=(${min.map(v=>v.toFixed(2))}) max=(${max.map(v=>v.toFixed(2))})`);
  };

  sample(0, 'anim t=0');
  sample(3, 'anim t=3s');
}
