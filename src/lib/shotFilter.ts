import * as THREE from 'three';
import type { PrevizShot, SceneAsset, Vec3 } from '../types';
import { lensMath } from './lens';
import { sampleShot } from './previz';

/** 镜头采样帧数：镜头用到的元素 = 这些帧视锥并集（与 shot/build_shot.py 同口径） */
const SAMPLES = 24;
/** 时间线上没有焦距轨道时按 35mm 计算 */
export const DEFAULT_FOCAL = 35;

export interface ShotUsage {
  ids: string[];
  count: number;
}

/** 预计算的资产世界坐标包围盒（8 个角点） */
export interface AssetBox {
  id: string;
  corners: Vec3[];
}

export function buildBoxes(assets: SceneAsset[]): AssetBox[] {
  return assets.map((asset) => {
    const rotation = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(asset.rotation[0], asset.rotation[1], asset.rotation[2], 'XYZ'),
    );
    const offset = new THREE.Vector3(...(asset.offset ?? [0, 0, 0]));
    const half = new THREE.Vector3(asset.size[0] / 2, asset.size[1] / 2, asset.size[2] / 2);
    const scale = new THREE.Vector3(...asset.scale);
    const origin = new THREE.Vector3(...asset.position);
    const corners: Vec3[] = [];
    for (const ix of [-1, 1]) {
      for (const iy of [-1, 1]) {
        for (const iz of [-1, 1]) {
          // group.scale 同时作用于 size 与 offset，与 SceneObject 的渲染一致
          const local = new THREE.Vector3(half.x * ix, half.y * iy, half.z * iz)
            .add(offset)
            .multiply(scale)
            .applyMatrix4(rotation)
            .add(origin);
          corners.push([local.x, local.y, local.z]);
        }
      }
    }
    return { id: asset.instanceId, corners };
  });
}

/** 相机基向量：yaw 0° 朝 -Z，pitch 正值向上（与 sceneStore / 预演数据一致） */
function basis(yaw: number, pitch: number) {
  const y = (yaw * Math.PI) / 180;
  const p = (pitch * Math.PI) / 180;
  const cp = Math.cos(p);
  return {
    f: [-Math.sin(y) * cp, Math.sin(p), -Math.cos(y) * cp] as Vec3,
    r: [Math.cos(y), 0, -Math.sin(y)] as Vec3,
    u: [Math.sin(y) * Math.sin(p), Math.cos(p), Math.cos(y) * Math.sin(p)] as Vec3,
  };
}

/** 相机空间 AABB 与视锥的保守相交测试（不精确剔除近裁面后方） */
function hit(
  box: AssetBox,
  eye: Vec3,
  f: Vec3,
  r: Vec3,
  u: Vec3,
  tanH: number,
  tanV: number,
  near = 0.15,
) {
  let zmax = -Infinity;
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const corner of box.corners) {
    const dx = corner[0] - eye[0];
    const dy = corner[1] - eye[1];
    const dz = corner[2] - eye[2];
    const x = dx * r[0] + dy * r[1] + dz * r[2];
    const y = dx * u[0] + dy * u[1] + dz * u[2];
    const z = dx * f[0] + dy * f[1] + dz * f[2];
    if (z > zmax) zmax = z;
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  if (zmax < near) return false;
  if (xmin > zmax * tanH || xmax < -zmax * tanH) return false;
  if (ymin > zmax * tanV || ymax < -zmax * tanV) return false;
  return true;
}

/**
 * 按镜头内进度取姿态。
 * 注意：previz 关键帧的 t 是 UE 时间码（如 33275s），不是时间线秒数，
 * 因此这里按关键帧自身的 t 区间归一化采样，不能直接用 shot.start/end。
 */
export function poseAtFraction(shot: PrevizShot, fraction: number) {
  const keys = shot.keys;
  if (keys.length === 0) return null;
  const t0 = keys[0].t;
  const t1 = keys[keys.length - 1].t;
  return sampleShot(shot, t0 + (t1 - t0) * fraction);
}

/** 某镜头 24 帧采样视锥内出现过的资产 id 集合 */
export function usedAssetIds(boxes: AssetBox[], shot: PrevizShot): string[] {
  const lens = lensMath(shot.focal ?? DEFAULT_FOCAL, 'S35', '2.39:1');
  const tanH = Math.tan(lens.hfov / 2);
  const tanV = Math.tan(lens.vfov / 2);
  const hitIds = new Set<string>();

  for (let i = 0; i < SAMPLES; i += 1) {
    const pose = poseAtFraction(shot, i / (SAMPLES - 1));
    if (!pose) continue;
    const { f, r, u } = basis(pose.yaw, pose.pitch);
    for (const box of boxes) {
      if (hitIds.has(box.id)) continue;
      if (hit(box, pose.position, f, r, u, tanH, tanV)) hitIds.add(box.id);
    }
  }
  // 保持资产原有顺序，便于表格/大纲对照
  return boxes.filter((box) => hitIds.has(box.id)).map((box) => box.id);
}

/** 批量统计多个镜头的用量（镜头库列表用） */
export function computeShotUsage(assets: SceneAsset[], shots: PrevizShot[]): Record<string, ShotUsage> {
  if (shots.length === 0) return {};
  const boxes = buildBoxes(assets);
  const result: Record<string, ShotUsage> = {};
  for (const shot of shots) {
    const ids = usedAssetIds(boxes, shot);
    result[shot.id] = { ids, count: ids.length };
  }
  return result;
}
