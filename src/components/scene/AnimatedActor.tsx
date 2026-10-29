import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useScene } from '../../store/sceneStore';

/**
 * json 骨骼人形角色。
 *
 * 背景：UE glTF 导出器对 MetaHuman 管线网格的顶点位置会系统性写错，
 * 但骨骼与动画数据完整正确。因此不再使用 glb 模型文件，而是把骨骼层级 +
 * 旋转关键帧离线转换为 json（server/tools/convert-anim-glb-to-json.mjs），
 * 前端按骨骼层级程序化搭建「胶囊体积人形」，动画由全局时间轴驱动。
 */

interface RigBone {
  name: string;
  parent: number;
  pos: number[];
  quat: number[];
}
interface RigData {
  fps: number;
  duration: number;
  frameCount: number;
  bones: RigBone[];
  pelvisIndex: number;
  /** 扁平帧：[帧 * 骨骼数 * 4 + 骨骼 * 4]，四元数 (x,y,z,w) 本地旋转 */
  rotFrames: number[];
  /** 仅 pelvis 位移帧：[帧 * 3] */
  posFrames?: number[];
}

/** 骨骼段胶囊半径（米，按 1.7m 身高归一化前的相对量，随骨架整体缩放） */
function boneRadius(name: string): number {
  if (/^spine/.test(name)) return 0.115;
  if (/^neck/.test(name)) return 0.045;
  if (/^clavicle/.test(name)) return 0.06;
  if (/^upperarm/.test(name)) return 0.052;
  if (/^lowerarm/.test(name)) return 0.043;
  if (/^thigh/.test(name)) return 0.088;
  if (/^calf/.test(name)) return 0.068;
  if (/^foot/.test(name)) return 0.05;
  return 0.035;
}

/** 部位配色：四肢与躯干为服装色，头颈手为肤色 */
const SKIN = '#e0b08c';

export function AnimatedActor({
  animUrl,
  animOffset = 0,
  height = 1.7,
  clothColor = '#4a86c8',
  mode = 'timeline',
}: {
  animUrl: string;
  animOffset?: number;
  /** 角色登记身高（米），骨架按 rest 姿态自动归一化到该高度 */
  height?: number;
  /** 服装颜色，可按角色区分外观 */
  clothColor?: string;
  /**
   * timeline = 播放骨骼动画（全局时间轴驱动）；
   * rest = 静态人形，取动画第 0 帧姿态（供只有走位轨迹、暂无骨骼动画数据的角色使用）
   */
  mode?: 'timeline' | 'rest';
}) {
  const [rig, setRig] = useState<RigData | null>(null);
  const [loadErr, setLoadErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(animUrl)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: RigData) => {
        if (!cancelled) setRig(data);
      })
      .catch(() => {
        if (!cancelled) setLoadErr(true);
      });
    return () => {
      cancelled = true;
    };
  }, [animUrl]);

  /** 骨骼 Object3D 树 + 体积段网格，一次构建 */
  const built = useMemo(() => {
    if (!rig) return null;
    const boneCount = rig.bones.length;

    // 1) Object3D 骨架树（rest 变换摆放）
    const objs: THREE.Object3D[] = rig.bones.map((b) => {
      const o = new THREE.Object3D();
      o.name = b.name;
      o.position.set(b.pos[0], b.pos[1], b.pos[2]);
      o.quaternion.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
      return o;
    });
    const rootObjs: THREE.Object3D[] = [];
    rig.bones.forEach((b, i) => {
      if (b.parent >= 0) objs[b.parent].add(objs[i]);
      else rootObjs.push(objs[i]);
    });
    const root = rootObjs[0] ?? new THREE.Object3D();

    // 2) rest 姿态下量身高（世界坐标 Y 跨度），归一化到登记身高
    root.updateMatrixWorld(true);
    let minY = Infinity;
    let maxY = -Infinity;
    const tmp = new THREE.Vector3();
    for (const o of objs) {
      o.getWorldPosition(tmp);
      minY = Math.min(minY, tmp.y);
      maxY = Math.max(maxY, tmp.y);
    }
    const span = maxY - minY;

    // 3) 体积段：每根骨骼向其所有子骨骼连一根胶囊（即标准骨架连线）
    //    无子的骨骼放末端件（头=球、手=球、ball=脚趾盒）
    const group = new THREE.Group();
    const skinMat = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.85 });
    const clothMat = new THREE.MeshStandardMaterial({ color: clothColor, roughness: 0.75 });
    const darkMat = new THREE.MeshStandardMaterial({ color: '#33404f', roughness: 0.8 });
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const childIdx = rig.bones.map(() => [] as number[]);
    rig.bones.forEach((b, i) => {
      if (b.parent >= 0) childIdx[b.parent].push(i);
    });
    const segFor = (i: number, j: number, r: number, mat: THREE.Material) => {
      const p = rig.bones[j].pos;
      dir.set(p[0], p[1], p[2]);
      const len = dir.length();
      if (len < 1e-5) return;
      const geo = new THREE.CapsuleGeometry(r, Math.max(len - r * 0.6, r), 4, 10);
      const mesh = new THREE.Mesh(geo, mat);
      // 胶囊沿 +Y，旋转对齐父子骨骼连线方向，放到线段中点
      mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      mesh.position.copy(dir).multiplyScalar(0.5);
      mesh.castShadow = true;
      objs[i].add(mesh);
    };
    const endFor = (i: number) => {
      const name = rig.bones[i].name.toLowerCase();
      const mesh =
        /^head/.test(name) ? new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 16), skinMat)
        : /^hand/.test(name) ? new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), skinMat)
        : /^ball/.test(name) ? new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.035, 0.11), darkMat)
        : null;
      if (!mesh) return;
      mesh.castShadow = true;
      // head 前移一点鼻尖标记朝向
      if (/^head/.test(name)) {
        const nose = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), skinMat);
        nose.position.set(0, -0.02, -0.1);
        objs[i].add(nose);
      }
      objs[i].add(mesh);
    };
    rig.bones.forEach((b, i) => {
      const kids = childIdx[i];
      const name = b.name.toLowerCase();
      if (kids.length) {
        const r = boneRadius(b.name);
        const mat = /^thigh|^calf/.test(name) ? darkMat
          : /^spine|^pelvis/.test(name) ? clothMat
          : skinMat;
        for (const k of kids) segFor(i, k, r, mat);
      } else {
        endFor(i);
      }
    });
    if (span > 1e-6) {
      group.scale.setScalar(height / span);
      // 骨架原点在 pelvis，走位轨迹点是脚底地面点：整体平移让脚底 (rest 最低点) 贴地
      group.position.y = -minY * (height / span);
    }
    group.add(root);

    // 静态模式：直接取动画第 0 帧姿态（比 bind pose 的 A/T-pose 自然）
    if (mode === 'rest') {
      const rot = Float32Array.from(rig.rotFrames);
      for (let i = 0; i < boneCount; i++) {
        const o = i * 4;
        objs[i].quaternion.set(rot[o], rot[o + 1], rot[o + 2], rot[o + 3]);
      }
      if (rig.posFrames && rig.pelvisIndex >= 0) {
        const p = objs[rig.pelvisIndex].position;
        p.set(rig.posFrames[0], rig.posFrames[1], rig.posFrames[2]);
      }
    }

    return {
      group,
      objs,
      rot: Float32Array.from(rig.rotFrames),
      pos: rig.posFrames ? Float32Array.from(rig.posFrames) : null,
      fps: rig.fps || 15,
      duration: rig.duration || 1,
      frameCount: rig.frameCount,
      boneCount,
      pelvisIndex: rig.pelvisIndex,
    };
  }, [rig, height, clothColor, mode]);

  const frameQuat = useRef(new THREE.Quaternion());
  const frameQuat2 = useRef(new THREE.Quaternion());

  useFrame(() => {
    const b = built;
    if (!b || mode === 'rest') return;
    const t = Math.max(0, useScene.getState().timelineTime + animOffset) % b.duration;
    const f = t * b.fps;
    const f0 = Math.min(Math.floor(f), b.frameCount - 1);
    const f1 = Math.min(f0 + 1, b.frameCount - 1);
    const frac = f - f0;

    for (let i = 0; i < b.boneCount; i++) {
      const o0 = (f0 * b.boneCount + i) * 4;
      const o1 = (f1 * b.boneCount + i) * 4;
      const rot = b.rot;
      const qa = frameQuat.current;
      qa.set(rot[o0], rot[o0 + 1], rot[o0 + 2], rot[o0 + 3]);
      const qb = frameQuat2.current;
      qb.set(rot[o1], rot[o1 + 1], rot[o1 + 2], rot[o1 + 3]);
      if (qa.dot(qb) < 0) qa.set(-qa.x, -qa.y, -qa.z, -qa.w);
      qa.slerp(qb, frac);
      b.objs[i].quaternion.copy(qa);
    }
    if (b.pos && b.pelvisIndex >= 0) {
      const p = b.objs[b.pelvisIndex].position;
      const a0 = f0 * 3;
      const a1 = f1 * 3;
      // glTF 动画语义：translation 轨道完全覆盖节点本地位移，不做 rest 叠加
      p.set(
        b.pos[a0] + (b.pos[a1] - b.pos[a0]) * frac,
        b.pos[a0 + 1] + (b.pos[a1 + 1] - b.pos[a0 + 1]) * frac,
        b.pos[a0 + 2] + (b.pos[a1 + 2] - b.pos[a0 + 2]) * frac,
      );
    }
  });

  if (loadErr) return null;
  if (!built) return null;
  return <primitive object={built.group} />;
}
