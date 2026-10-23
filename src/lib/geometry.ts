import * as THREE from 'three';
import type { SceneAsset, Vec3 } from '../types';

/** 点到资产包围盒（考虑旋转与缩放）的最短距离，单位米 */
export function pointToAssetDistance(point: Vec3, asset: SceneAsset): number {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(asset.rotation[0], asset.rotation[1], asset.rotation[2]),
  );
  const pos = new THREE.Vector3(...asset.position);
  const scale = new THREE.Vector3(...asset.scale);
  const local = new THREE.Vector3(...point)
    .sub(pos)
    .applyQuaternion(q.clone().invert())
    .divide(scale);

  const half = new THREE.Vector3(asset.size[0] / 2, asset.size[1] / 2, asset.size[2] / 2);
  const clamped = local.clone().clamp(half.clone().negate(), half);
  const diff = local.sub(clamped).multiply(scale).applyQuaternion(q);
  return diff.length();
}

export function assetTopY(asset: SceneAsset): number {
  return asset.position[1] + asset.size[1] * asset.scale[1];
}

export const fmt = (value: number, digits = 2): string => {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(digits);
};
