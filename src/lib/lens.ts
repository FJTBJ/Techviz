import { ASPECTS, SENSORS, type AspectKey, type SensorKey } from '../types';

export interface LensResult {
  /** 有效成像宽 / 高，单位 mm */
  effectiveWidth: number;
  effectiveHeight: number;
  /** 水平 / 垂直视场角，弧度 */
  hfov: number;
  vfov: number;
  hfovDeg: number;
  vfovDeg: number;
  /** 等效全画幅焦距 */
  equivalentFocal: number;
  /** 指定距离处的画面尺寸，米 */
  coverageAt: (distance: number) => { width: number; height: number };
}

/**
 * 镜头光学计算：以传感器尺寸与目标画幅比例推出有效成像面积，
 * 再由焦距反推水平/垂直视场角。
 */
export function lensMath(focal: number, sensor: SensorKey, aspectKey: AspectKey): LensResult {
  const s = SENSORS[sensor];
  const aspect = ASPECTS[aspectKey];
  const sensorAspect = s.width / s.height;

  let effectiveWidth: number;
  let effectiveHeight: number;
  if (sensorAspect > aspect) {
    effectiveHeight = s.height;
    effectiveWidth = s.height * aspect;
  } else {
    effectiveWidth = s.width;
    effectiveHeight = s.width / aspect;
  }

  const hfov = 2 * Math.atan(effectiveWidth / (2 * focal));
  const vfov = 2 * Math.atan(effectiveHeight / (2 * focal));

  return {
    effectiveWidth,
    effectiveHeight,
    hfov,
    vfov,
    hfovDeg: (hfov * 180) / Math.PI,
    vfovDeg: (vfov * 180) / Math.PI,
    equivalentFocal: focal * (36 / effectiveWidth),
    coverageAt: (distance: number) => ({
      width: 2 * Math.tan(hfov / 2) * distance,
      height: 2 * Math.tan(vfov / 2) * distance,
    }),
  };
}

/** 画面高度占画面的比例，用于机位模式下的画幅遮罩 */
export function frameFractions(canvasAspect: number, frameAspect: number) {
  const heightFraction = Math.min(1, canvasAspect / frameAspect);
  return {
    heightFraction,
    widthFraction: (heightFraction * frameAspect) / canvasAspect,
  };
}
