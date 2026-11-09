import * as THREE from 'three';
import type { PrevizShot, SceneAsset, Vec3 } from '../types';
import { shotPoseAt, rotatePoseY } from './previz';

/** 单个镜头检出一个问题 */
export interface ShotIssue {
  /** occlusion 遮挡穿帮 / off-platform 地台外穿帮 / in-frame 入画穿帮 /
   *  outside-ring 置景入屏不满足 / gap-shot 画面拍到缺口 / off-screen 画面超出屏体 */
  type:
    | 'occlusion'
    | 'off-platform'
    | 'in-frame'
    | 'outside-ring'
    | 'gap-shot'
    | 'off-screen';
  severity: 'high' | 'mid';
  assetName: string;
  message: string;
}

/** 一个镜头的影响检查结果 */
export interface ShotImpact {
  shotId: string;
  issues: ShotIssue[];
}

/** 整体检查结果 */
export interface ImpactResult {
  checkedAt: number;
  /** 本次检查的镜头数 */
  shotCount: number;
  /** 有异常的镜头 */
  issueShots: ShotImpact[];
}

/** 环屏参数（来自棚体数据，环心为世界原点，缺口朝 +Z 固定不动） */
export interface RingSpec {
  radius: number;
  height: number;
  /** 屏体弧段覆盖角度（度） */
  arc: number;
}

/** 调整过的资产（基础模型等新增/移动内容）才参与资产类检查 */
const adjustedAssets = (assets: SceneAsset[]): SceneAsset[] =>
  assets.filter((a) => a.instanceId.startsWith('prim-') && a.visible);

/** 内容局部坐标 → 世界坐标：world = R(ensembleYaw)·(setOffset + R(stageRotationY)·p) */
function toWorld(
  p: Vec3,
  ensembleYaw: number,
  setOffset: Vec3,
  stageRotationY: number,
): THREE.Vector3 {
  const v = new THREE.Vector3(...p);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(stageRotationY));
  v.add(new THREE.Vector3(...setOffset));
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(ensembleYaw));
  return v;
}

/** 机位前向单位向量（与播放驱动同一定义：rotation YXZ = pitch/yaw/0） */
function forwardOf(yawDeg: number, pitchDeg: number): THREE.Vector3 {
  const y = THREE.MathUtils.degToRad(yawDeg);
  const p = THREE.MathUtils.degToRad(pitchDeg);
  return new THREE.Vector3(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
}

/**
 * 方案调整影响检查（依据《KMOKE-261104-置景方案逻辑规则》规则四「覆盖判定」）：
 *  1. 置景入屏（硬约束）：调整资产必须位于环屏屏体弧段内，超出即全部镜头不覆盖；
 *  2. 画面入屏（硬约束）：镜头画面须完整落在屏体上——拍到缺口 / 超出屏体上沿均违规（按镜头全程关键帧检查）；
 *  3. 遮挡穿帮（高）：调整资产位于机位视线走廊内，可能挡住画面主体；
 *  4. 入画穿帮（中）：调整资产可能出现在画面中；落在表演区地台外时还会露出台外实景。
 */
export function analyzeShotImpacts(params: {
  shots: PrevizShot[];
  assets: SceneAsset[];
  platform: { position: Vec3; size: Vec3 } | null;
  ring: RingSpec | null;
  ensembleYaw: number;
  setOffset: Vec3;
  stageRotationY: number;
}): ImpactResult {
  const { shots, assets, platform, ring, ensembleYaw, setOffset, stageRotationY } = params;
  const items = adjustedAssets(assets);
  const issueShots: ShotImpact[] = [];

  // —— 置景入屏（与机位无关，方案级硬约束，违反即波及全部镜头）——
  const ringIssues: ShotIssue[] = [];
  if (ring) {
    for (const asset of items) {
      const center = toWorld(asset.position, ensembleYaw, setOffset, stageRotationY);
      const distH = Math.hypot(center.x, center.z);
      if (distH > ring.radius) {
        ringIssues.push({
          type: 'outside-ring',
          severity: 'high',
          assetName: asset.name,
          message: `「${asset.name}」位于环屏屏体外（距环心 ${distH.toFixed(1)}m > 屏半径 ${ring.radius.toFixed(1)}m），违反「置景入屏」覆盖判定，所有镜头均不可被本方案覆盖`,
        });
      }
    }
  }

  for (const shot of shots) {
    const issues: ShotIssue[] = [...ringIssues];

    // —— 画面入屏：按镜头全程关键帧逐帧检查（拍到缺口 / 超出屏体上沿）——
    if (ring) {
      const gapHalfRad = THREE.MathUtils.degToRad((360 - ring.arc) / 2);
      for (const key of shot.keys) {
        const pose = rotatePoseY(
          { position: key.position, yaw: key.yaw, pitch: key.pitch, focal: key.focal },
          ensembleYaw,
          setOffset,
        );
        if (!pose) continue;
        const cam = new THREE.Vector3(...pose.position);
        const fwd = forwardOf(pose.yaw, pose.pitch);
        const fwdH = Math.hypot(fwd.x, fwd.z);
        if (fwdH < 1e-6) continue;
        // 前向射线与环屏圆柱（半径 ring.radius）求交：|camH + t·fwdH| = R
        const b = cam.x * fwd.x + cam.z * fwd.z;
        const c = cam.x * cam.x + cam.z * cam.z - ring.radius * ring.radius;
        const disc = b * b - c;
        if (disc <= 0) continue; // 射线到不了屏体（朝环心外侧），入屏由置景侧兜底
        const t = -b + Math.sqrt(disc);
        if (t <= 0) continue;
        const hitX = cam.x + fwd.x * t;
        const hitZ = cam.z + fwd.z * t;
        const hitY = cam.y + fwd.y * t;
        const azimuth = Math.atan2(hitX, hitZ); // 0 = +Z（缺口中心方向）
        if (Math.abs(azimuth) < gapHalfRad) {
          issues.push({
            type: 'gap-shot',
            severity: 'high',
            assetName: '—',
            message: `镜头画面朝向环屏缺口（t=${key.t.toFixed(1)}s），拍到屏外空间，违反「画面入屏」覆盖判定`,
          });
          break;
        }
        if (hitY > ring.height) {
          issues.push({
            type: 'off-screen',
            severity: 'mid',
            assetName: '—',
            message: `镜头画面超出环屏上沿（t=${key.t.toFixed(1)}s 交点高度 ${hitY.toFixed(1)}m > 屏高 ${ring.height.toFixed(1)}m），可能拍到屏外`,
          });
          break;
        }
      }
    }

    // —— 资产类检查：用首帧机位姿态 ——
    const raw = shotPoseAt(shot, shot.start);
    const pose0 = raw ? rotatePoseY(raw, ensembleYaw, setOffset) : null;
    if (pose0) {
      const cam = new THREE.Vector3(...pose0.position);
      const fwd = forwardOf(pose0.yaw, pose0.pitch);

      for (const asset of items) {
        const center = toWorld(asset.position, ensembleYaw, setOffset, stageRotationY);
        const v = center.clone().sub(cam);
        const dist = v.length();
        if (dist < 0.5 || dist > 60) continue;
        const angleDeg = THREE.MathUtils.radToDeg(v.clone().normalize().angleTo(fwd));
        if (angleDeg > 40) continue; // 大概率不入画

        // 遮挡穿帮：资产中心到前向射线的垂距小于其包围半径
        const proj = v.dot(fwd);
        const perp = v.clone().sub(fwd.clone().multiplyScalar(proj)).length();
        const boundR = Math.max(...asset.size) * 0.5 * Math.max(...asset.scale);
        if (perp < boundR + 0.3) {
          issues.push({
            type: 'occlusion',
            severity: 'high',
            assetName: asset.name,
            message: `「${asset.name}」位于机位视线走廊内（偏离视线约 ${perp.toFixed(1)}m），可能遮挡画面主体`,
          });
          continue;
        }

        // 入画穿帮：可能入画的调整模型本身即穿帮风险；地台外时还会露出台外实景
        const [w, , d] = platform?.size ?? [Infinity, 0, Infinity];
        const [cx, , cz] = platform?.position ?? [0, 0, 0];
        const [px, , pz] = asset.position;
        const halfIn = 0.3; // 地台边缘内收，避免贴边误报
        const offPlatform =
          platform &&
          (px < cx - w / 2 + halfIn ||
            px > cx + w / 2 - halfIn ||
            pz < cz - d / 2 + halfIn ||
            pz > cz + d / 2 - halfIn);
        issues.push({
          type: offPlatform ? 'off-platform' : 'in-frame',
          severity: 'mid',
          assetName: asset.name,
          message: offPlatform
            ? `「${asset.name}」位于表演区地台范围外且可能入画，画面中会露出台外实景（穿帮）`
            : `「${asset.name}」可能出现在本镜头画面中（偏离视线约 ${perp.toFixed(1)}m），存在穿帮风险`,
        });
      }
    }

    if (issues.length > 0) {
      issueShots.push({ shotId: shot.id, issues });
    }
  }

  return { checkedAt: Date.now(), shotCount: shots.length, issueShots };
}
