import { ASPECTS, type PrevizShot, type ShotCamera, type Vec3 } from '../types';
import { frameFractions, lensMathNum } from './lens';
import { rotatePoseY, shotPoseAt } from './previz';

/** 机位取景解算结果：世界位姿 + 垂直视场角（度） */
export interface CameraViewResult {
  position: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  fovDeg: number;
}

/**
 * 机位取景解算：主视口机位模式（CameraDriver）与右下机位取景画中画共用同一份计算。
 * 选中镜头时取该镜头当前帧机位（叠加集合整体转向与摆放平移），
 * 画幅优先用 take 视频实测比例（机位取景与原视频同比例），无 take 时回落相机参数画幅；
 * 无预演机位时退回「机位」面板的手动机位参数。
 */
export function resolveCameraView(params: {
  /** 「机位」面板的手动机位参数（画幅 / 传感器 / 默认焦距与静态位姿） */
  cam: ShotCamera;
  activeShot: PrevizShot | null;
  /** master 时间码，秒 */
  time: number;
  ensembleYaw: number;
  setOffset: Vec3;
  /** 渲染目标宽高比（主视口或画中画小窗） */
  aspect: number;
  /** take 视频元素（用于实测画幅比例，可为 null） */
  takeEl: HTMLVideoElement | null;
}): CameraViewResult | null {
  const { cam, activeShot, time, ensembleYaw, setOffset, aspect, takeEl } = params;
  const frameAspect =
    takeEl && takeEl.videoWidth > 0 && takeEl.videoHeight > 0
      ? takeEl.videoWidth / takeEl.videoHeight
      : ASPECTS[cam.aspect];
  const lens = lensMathNum(cam.focal, cam.sensor, frameAspect);
  const canvasAspect = Math.max(0.001, aspect);
  const frame = frameFractions(canvasAspect, frameAspect);
  const camVfov = 2 * Math.atan(Math.tan(lens.vfov / 2) / frame.heightFraction);
  const rad2deg = (r: number) => (r * 180) / Math.PI;

  // 选中镜头时取该镜头当前帧机位，再按集合整体转向角旋转（机位与演员/布景一起转）
  const raw = activeShot ? shotPoseAt(activeShot, time) : null;
  const pose = raw ? rotatePoseY(raw, ensembleYaw, setOffset) : null;
  if (pose) {
    const shotLens = lensMathNum(pose.focal ?? cam.focal, cam.sensor, frameAspect);
    return {
      position: pose.position,
      yaw: pose.yaw,
      pitch: pose.pitch,
      roll: 0,
      fovDeg: rad2deg(2 * Math.atan(Math.tan(shotLens.vfov / 2) / frame.heightFraction)),
    };
  }

  return {
    position: cam.position,
    yaw: cam.yaw,
    pitch: cam.pitch,
    roll: cam.roll,
    fovDeg: rad2deg(camVfov),
  };
}
