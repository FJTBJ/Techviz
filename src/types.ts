export type SensorKey = 'S35' | 'FF' | 'VV' | 'ALEV3' | 'IMAX';

export type AspectKey = '2.39:1' | '1.85:1' | '16:9' | '4:3';

export type RigType = '三脚架' | '摇臂' | '轨道' | '斯坦尼康' | '无人机' | '伸缩摇臂';

export type ProxyKind = 'wall' | 'box' | 'column' | 'person' | 'vehicle' | 'tree' | 'glb' | 'ue';

export type Vec3 = [number, number, number];

export interface SceneAsset {
  instanceId: string;
  assetId: string;
  name: string;
  code: string;
  kind: ProxyKind;
  /** 模型地址，仅 glb 类型使用 */
  url?: string;
  /** 近似包围盒尺寸，单位米：[宽, 高, 深] */
  size: Vec3;
  /** 包围盒中心相对 group 原点的局部偏移（UE 导入体块使用），单位米 */
  offset?: Vec3;
  color: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
}

export interface ShotCamera {
  position: Vec3;
  /** 水平旋转，0° 朝向 -Z */
  yaw: number;
  /** 俯仰，正值向上 */
  pitch: number;
  /** 横滚 */
  roll: number;
  /** 焦距 mm */
  focal: number;
  sensor: SensorKey;
  aspect: AspectKey;
  rig: RigType;
  sceneNo: string;
  shotNo: string;
  notes: string;
}

export interface Measurement {
  id: string;
  a: Vec3;
  b: Vec3;
  distance: number;
  deltaY: number;
  deltaXZ: number;
}

export interface AssetDef {
  assetId: string;
  name: string;
  code: string;
  assetType: string;
  level: string;
  kind: ProxyKind;
  size: Vec3;
  color: string;
}

/** 环屏棚：来自后端扫描 UE 工程 NDC 目录 */
export interface StageDef {
  id: string;
  no: number;
  name: string;
  code: string;
  diameter: number;
  height: number;
  arc: number;
  /** 缺口中心方位角（three.js 角度，0=+Z，90=+X） */
  gapCenterDeg?: number;
  panels: number;
  umap: string | null;
  uePath: string;
  updatedAt: string;
}

export type ViewMode = 'orbit' | 'camera' | 'measure';
export type GizmoMode = 'translate' | 'rotate' | 'scale';

/** 布景方案：由「UE 预演镜头相机动画 + 环屏几何」推导出的实体搭建条目 */
export interface SetPiece {
  id: string;
  name: string;
  category: 'platform' | 'gapMask' | 'topSkirt' | 'backing';
  position: Vec3;
  /** [宽, 高, 深]，单位米 */
  size: Vec3;
  rotationY: number;
  color: string;
  relatedShots: string[];
  rationale: string;
  metrics?: Record<string, number>;
}

export interface PlanShot {
  id: string;
  name: string;
  scene: string | null;
  durationSec: number | null;
  focal: number | null;
  camera: Vec3 | null;
  cameraSpanDeg: [string, string] | null;
  samples: number;
  insideRing: boolean;
  coverage: { led: number; ground: number; open: number };
}

export interface SetPlan {
  generatedAt: string;
  scene: string;
  ring: {
    diameter: number;
    radius: number;
    height: number;
    arc: number;
    gapDeg: number;
    gapCenterDeg: number;
  };
  source: {
    rings?: string;
    previz?: string;
    shots?: number;
    takes?: number;
    note?: string;
  };
  summary: {
    shotCount: number;
    rayCount: number;
    led: number;
    ground: number;
    open: number;
    setPieceCount: number;
  };
  shots: PlanShot[];
  setPieces: SetPiece[];
}

export interface SetPlanFile {
  generatedAt: string;
  scenes: { scene: string; shotCount: number; takeCount: number }[];
  plans: Record<string, SetPlan>;
}

/** 预演时间线上的相机关键帧（已验证为 three.js 坐标） */
export interface PrevizKey {
  /** master 时间码，秒 */
  t: number;
  position: Vec3;
  yaw: number;
  pitch: number;
  focal: number | null;
}

/** 时间线上的一个镜头（对应 UE take 序列的一段） */
export interface PrevizShot {
  id: string;
  name: string;
  scene: string | null;
  start: number;
  end: number;
  durationSec: number;
  focal: number | null;
  keys: PrevizKey[];
}

export interface PrevizTimeline {
  generatedAt: string;
  fps: number;
  duration: number;
  scenes: { scene: string; shotCount: number }[];
  note?: string;
  shots: PrevizShot[];
}


/** 传感器实际成像尺寸，单位 mm */
export const SENSORS: Record<SensorKey, { label: string; width: number; height: number }> = {
  S35: { label: 'Super 35 (24.89×18.66)', width: 24.89, height: 18.66 },
  FF: { label: '全画幅 (36×24)', width: 36, height: 24 },
  VV: { label: 'VistaVision (37.7×24.9)', width: 37.7, height: 24.9 },
  ALEV3: { label: 'ARRI ALEV III (28.17×18.13)', width: 28.17, height: 18.13 },
  IMAX: { label: 'IMAX (70.41×52.63)', width: 70.41, height: 52.63 },
};

export const ASPECTS: Record<AspectKey, number> = {
  '2.39:1': 2.39,
  '1.85:1': 1.85,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
};

export const ASPECT_KEYS = Object.keys(ASPECTS) as AspectKey[];
export const SENSOR_KEYS = Object.keys(SENSORS) as SensorKey[];
export const RIG_TYPES: RigType[] = ['三脚架', '摇臂', '轨道', '斯坦尼康', '无人机', '伸缩摇臂'];
