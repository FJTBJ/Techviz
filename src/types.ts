export type SensorKey = 'S35' | 'FF' | 'VV' | 'ALEV3' | 'IMAX';

export type AspectKey = '2.39:1' | '1.85:1' | '16:9' | '4:3';

export type RigType = '三脚架' | '摇臂' | '轨道' | '斯坦尼康' | '无人机' | '伸缩摇臂';

export type ProxyKind = 'wall' | 'box' | 'column' | 'person' | 'vehicle' | 'tree' | 'glb' | 'ue' | 'skeletal' | 'light';

export type Vec3 = [number, number, number];

export interface SceneAsset {
  instanceId: string;
  assetId: string;
  name: string;
  code: string;
  kind: ProxyKind;
  /** 模型地址，仅 glb / skeletal 类型使用 */
  url?: string;
  /** UE 网格资产路径（如 /Game/.../ZhuZi_4.ZhuZi_4） */
  mesh?: string;
  /** UE 网格导出的真实模型地址（如 /models/ZhuZi_4_ab12cd.glb），缺失时回退代理体块 */
  meshUrl?: string;
  /** 骨骼动画片段地址，仅 skeletal 类型使用 */
  animUrl?: string;
  /** 动画相对镜头入点的时间偏移，秒 */
  animOffset?: number;
  /** 近似包围盒尺寸，单位米：[宽, 高, 深] */
  size: Vec3;
  /** 包围盒中心相对 group 原点的局部偏移（UE 导入体块使用），单位米 */
  offset?: Vec3;
  /** 灯光类型（PointLight / SpotLight / RectLight / DirectionalLight / SkyLight），仅 light 使用 */
  lightType?: string;
  /** 灯光强度（UE 原始单位，仅展示用） */
  intensity?: number | null;
  /** 灯光衰减半径（米），点光/聚光有效 */
  lightRange?: number | null;
  /** 聚光锥角（度） */
  innerConeDeg?: number | null;
  outerConeDeg?: number | null;
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
  category: 'platform' | 'topSkirt' | 'backing';
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
  /** 该场次推荐置景摆放（演员表演区尽量都在屏内的最优环心偏移，由 build-setplan 离线解算） */
  stagePosition?: {
    offset: Vec3;
    actorBacked: number;
    actorBackedOrigin: number;
    /** 置景资产锚点在屏弧内的占比（%） */
    assetBacked?: number;
    sampleCount: number;
    /** 需要置景的资产件数 */
    assetCount?: number;
    shotCount: number;
    headY: number;
    method: string;
  } | null;
  /** 需要置景的资产实例 ID 列表（与人物有交互，对应快照 instanceId）：默认显示；其余资产默认隐藏 */
  setInstanceIds?: string[];
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
  /** Kmoke 场记单官方短名，如 s079a_c004_A */
  short?: string;
  /** take 序号 */
  take?: number;
  takeDuration?: number;
  /** take 视频（Kmoke 签名 URL，24 小时有效，仅作本地缺失时的兜底） */
  takeUrl?: string;
  /** 本地已缓存 take 视频（/api/takes/<short>.mp4） */
  takeLocal?: boolean;
}

export interface PrevizTimeline {
  generatedAt: string;
  fps: number;
  duration: number;
  scenes: { scene: string; shotCount: number }[];
  note?: string;
  shots: PrevizShot[];
}

/** shot-names.json 单条记录（Kmoke 场记镜头，键为 file_name） */
export interface ShotNameMeta {
  short?: string;
  take?: number;
  fieldRecordId?: number;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSec?: number;
}

/** 左侧镜头树的镜头行：shot-names 全量清单条目，hasRig = 预演时间线里有同名镜头（含 3D 机位数据） */
export interface ShotCatalogEntry {
  /** shot-names.json 的键（file_name），与 PrevizShot.name 同源 */
  key: string;
  /** 官方短名，如 s079a_c004_A */
  short: string;
  take: number | null;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  durationSec: number;
  /** 从短名/文件名前缀解析出的场次码（小写），解析不到为 null */
  scene: string | null;
  hasRig: boolean;
}

/** UE 人物动画关键帧（three.js 坐标，米；s 为镜头序列内时间，秒） */
export interface UePersonKey {
  s: number;
  p: Vec3;
  yaw: number;
}

export interface UePerson {
  name: string;
  label: string;
  keys: UePersonKey[];
}

/** 单个 take 对应的人物动画（来自 UE PostData 镜头序列） */
export interface UeShotPeople {
  short: string | null;
  sequence: string | null;
  /** take 时间 0 对应的镜头序列时间偏移，秒 */
  offset: number;
  duration: number | null;
  characters: UePerson[];
}

export interface UePeople {
  generatedAt: string;
  fps: number;
  shots: Record<string, UeShotPeople>;
}

/** 机位朝向计算：单个镜头计算前 / 计算后 */
export interface ShotAim {
  id: string;
  name: string;
  scene: string | null;
  start: number;
  end: number;
  focal: number;
  before: { led: number; ground: number; open: number };
  /** 整条 take 的偏航修正角，度 */
  deltaDeg: number;
  /** 整条 take 的俯仰修正角，度（低机位避免画幅压在地面上） */
  deltaPitchDeg: number;
  after: { led: number; ground: number; open: number };
}

export interface ShotAimSummary {
  shots: number;
  led: number;
  ground: number;
  open: number;
  zeroLed: number;
}

export interface ShotAimFile {
  generatedAt: string;
  mode: 'aim-at-led';
  ring: { diameter: number; height: number; arc: number; gapCenterDeg: number };
  note?: string;
  summary: { before: ShotAimSummary; after: ShotAimSummary };
  scenes: Record<
    string,
    {
      shots: number;
      before: { led: number; open: number; zeroLed: number };
      after: { led: number; open: number; zeroLed: number };
      maxDeltaDeg: number;
    }
  >;
  shots: ShotAim[];
}

/** 方案管理：一个场次场景对应一个方案 */
export interface PlanMeta {
  name: string;
  /** 关联的预演场次（空表示未关联） */
  scene: string | null;
  updatedAt: string;
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
