import { create } from 'zustand';
import { DEMO_SHOT, demoAssets } from '../data/mockData';
import { apiFetch } from '../lib/api';
import { buildBoxes, usedAssetIds } from '../lib/shotFilter';
import { pivotShift, rotatePoseY, shotPoseAt } from '../lib/previz';
import { analyzeShotImpacts } from '../lib/impactCheck';
import type { ImpactResult } from '../lib/impactCheck';
import type {
  GizmoMode,
  Measurement,
  SceneAsset,
  SetPlanFile,
  ShotCamera,
  ShotCatalogEntry,
  ShotNameMeta,
  StageDef,
  Vec3,
  ViewMode,
  PrevizTimeline,
  ShotAimFile,
} from '../types';

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${seq++}`;

/**
 * gizmo 拖拽保护期：TransformControls 的 gizmo 不参与 R3F 事件系统，
 * 松开 gizmo 后浏览器补发的 click 会被视作“点击空白/地面”而取消选中，
 * 导致 gizmo 一碰就断。这里在拖拽结束时打一个时间戳，
 * 让 Ground 点击 / onPointerMissed 在短暂保护期内忽略取消选中。
 */
let lastGizmoDragEnd = 0;
export const markGizmoDragEnd = () => {
  lastGizmoDragEnd = performance.now();
};
export const isGizmoActive = () => performance.now() - lastGizmoDragEnd < 200;

/** 角度归一到 (-180, 180] */
const normDeg = (deg: number) => ((deg % 360) + 540) % 360 - 180;

/** 是否已从后端恢复过数据；恢复完成后才开启自动保存，避免用 demo 数据覆盖存档 */
let hydrated = false;

/** 默认打开空态（尚无方案界面）后，?plans=0 参数已无实际作用；恢复自动进方案视图时用（见 initFromServer） */
const forceEmptyPlans =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('plans') === '0';

/** 自动保存定时器 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 从镜头短名 / 文件名解析场次码（如 s079a_c004_A → s079a），解析不到返回 null */
const parseSceneCode = (name: string): string | null => {
  const m = /s\d+[a-z]?/i.exec(name);
  return m ? m[0].toLowerCase() : null;
};

/** 试运行角色：s079a 镜头的努拉，骨骼动画由全局时间轴驱动 */
const DEMO_ACTOR: SceneAsset = {
  instanceId: 'ue-char-nuola-s079a',
  assetId: 'ue/Char_ShaoNianNvXing_A000C',
  name: '努拉（骨骼动画）',
  code: 'Char_ShaoNianNvXing_A000C',
  kind: 'skeletal',
  url: '/models/s079a/nuola_sk.glb',
  animUrl: '/models/s079a/nuola_rig.json',
  animOffset: 0,
  size: [1.56, 1.72, 0.5],
  color: '#e0b34a',
  position: [2.98, 0, 5.62],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  visible: true,
};

export interface Scenario {
  version: 2;
  savedAt: string;
  currentStageId: string | null;
  /** 棚整体位置偏移（米），可选兼容旧存档 */
  stagePosition?: Vec3;
  /** 置景摆放偏移（米）：布景+演员+预演机位整体平移量，每场次一个，可选兼容旧存档 */
  setOffset?: Vec3;
  /** 方案关联的场次场景（一个场次一个方案） */
  sceneKey: string | null;
  camera: ShotCamera;
  assets: SceneAsset[];
  measurements: Measurement[];
  clearanceThreshold: number;
}

interface SceneState {
  assets: SceneAsset[];
  selectedId: string | null;
  /** 鼠标悬停的构件：视口左下角显示名称，便于辨认场景里是什么元素 */
  hoveredId: string | null;
  hoverAsset: (id: string | null) => void;
  camera: ShotCamera;
  mode: ViewMode;
  gizmo: GizmoMode;
  pendingPoint: Vec3 | null;
  measurements: Measurement[];
  clearanceThreshold: number;
  showFrustum: boolean;
  /** 棚和设备显隐开关（右侧操作面板）：环屏屏体 / 地面网格 / 预演演员 */
  showLedRing: boolean;
  showGrid: boolean;
  showPeople: boolean;
  toggleLedRing: () => void;
  toggleGrid: () => void;
  togglePeople: () => void;
  /** 棚清单（后端扫描 UE 工程得到），形状参数来自 UE，位置可由用户整体调整 */
  stages: StageDef[];
  currentStageId: string | null;
  /** 当前棚的整体位置偏移（米），环心 = 该坐标；切棚时归零 */
  stagePosition: Vec3;
  /** 置景摆放偏移（米）：布景+演员+预演机位整体平移，环屏棚固定在原点不动；随方案保存 */
  setOffset: Vec3;
  /** 置景内容绕环心旋转角（度）：环屏与缺口固定，内容位姿=平移+绕环心旋转（KMOKE-261104 规则四） */
  stageRotationY: number;
  setSetOffset: (offset: Vec3) => void;
  setStageRotationY: (deg: number) => void;
  /** 置景筛选自动应用：交互置景资产默认显示，其余 UE 构件默认隐藏（加载方案/切场次时执行） */
  applySetAssetFilter: () => Promise<void>;
  /** 后端连接状态，用于顶栏提示 */
  serverState: 'connecting' | 'online' | 'offline';
  /** 布景方案（由预演相机动画 + 环屏几何推导，后端生成） */
  setPlan: SetPlanFile | null;
  planScene: string | null;
  showSetPlan: boolean;
  /** 方案库当前选中方案（planId = <scene>-P<n>）；null = 未选方案 */
  activePlanId: string | null;
  /**
   * 方案库形态：'empty' = 尚未生成方案（左侧全量镜头列表 + 中间生成按钮），
   * 'ready' = 方案视图（左侧方案库）。后端有 planList 数据时初始为 ready，
   * 也可用 ?plans=0 进入空态演示。
   */
  planLibraryMode: 'empty' | 'ready';
  /** 空态点击「生成 Techviz 方案」：进入方案视图（模拟生成完成） */
  startPlanGeneration: () => void;
  /**
   * 方案库点击方案：切换场次 + 自动应用该方案的内容位姿（平移/绕环心旋转）
   * 与置景筛选（方案实例集显示、其余隐藏），中间视口即成为该方案预览。
   */
  selectPlan: (planId: string) => void;
  /**
   * 资产 tab 置景管理：把实例加入/移出当前选中方案的置景集，
   * 并同步资产显隐（入置景即显示，移除置景即隐藏）。仅改内存方案数据，不回写 setplan.json。
   */
  togglePlanSetAsset: (instanceId: string, inSet: boolean) => void;
  /** 地台尺寸调整（宽/深 ±，米）：同步方案数据与地台虚拟资产，中心不变 */
  resizePlatform: (deltaW: number, deltaD: number) => void;
  /** 添加基础模型（长方体/球体/圆柱）：默认落在内容原点，可传落点（内容局部坐标） */
  addPrimitive: (kind: 'box' | 'sphere' | 'column', position?: Vec3) => void;
  /** 方案内容有未检查的调整（视口显示「确定」影响检查按钮） */
  adjustDirty: boolean;
  /** AI 影响检查：调整后检查当前方案对其他镜头的穿帮影响 */
  impact: { running: boolean; result: ImpactResult | null };
  runImpactCheck: () => void;
  /** 布景方案里的黄色菱形机位点（各镜首帧机位）是否显示 */
  showShotMarkers: boolean;
  toggleShotMarkers: () => void;

  /** 方案关联的场次场景（一个场次一个方案）；方案管理 UI 已停用，仅随存档保留 */
  sceneKey: string | null;

  /** 全量镜头清单（Kmoke 场记 shot-names.json），左侧镜头树数据源；hasRig = 有 3D 机位数据 */
  shotCatalog: ShotCatalogEntry[] | null;
  /** 场次码 → 场景资产名数组（scene-asset-map.json），镜头树一级分组 */
  sceneAssetMap: Record<string, string[]> | null;
  /** 当前选中的「无 3D 机位数据」镜头：take 小窗照播，机位取景小窗显示占位 */
  activeNoDataShot: ShotCatalogEntry | null;
  selectNoDataShot: (shot: ShotCatalogEntry | null) => void;

  /** 镜头库：activeShotId 为 null 表示「完整场景」 */
  activeShotId: string | null;
  /** 当前镜头用到的资产 id（视锥剔除结果），null 表示不过滤 */
  activeShotUsedIds: string[] | null;
  /**
   * 镜头模式下被用户手工隐藏的元素。
   * 只作用于当前镜头（切镜头清空），优先级高于「本镜头元素强制显示」。
   */
  shotHiddenIds: string[];
  setShotVisibility: (ids: string[], visible: boolean) => void;
  selectShot: (shotId: string | null) => void;
  /**
   * 自由视角跳转请求：确定相机位置与轨道中心（视线前方的落点）。
   * 环屏缺口固定在 +Z，默认视角必须落在环内朝 LED 屏，不能停在缺口外侧。
   */
  viewRequest: { position: Vec3; target: Vec3; nonce: number } | null;
  goToView: (position: Vec3, target: Vec3) => void;
  /** 右下角 take 视频小窗是否展开 */
  takeVisible: boolean;
  toggleTake: () => void;
  /** 右下机位取景画中画：显隐（顶栏开关）与放大/还原 */
  camPipVisible: boolean;
  camPipEnlarged: boolean;
  toggleCamPip: () => void;
  toggleCamPipEnlarged: () => void;
  /** 右下角 take 视频元素：与 3D 环屏共用同一个 video，避免两路播放不同步 */
  takeVideoEl: HTMLVideoElement | null;
  setTakeVideoEl: (el: HTMLVideoElement | null) => void;

  /** 高空俯视视角：播放时从场景上方观察机位如何运动 */
  aerialView: boolean;
  /** 进入高空视角前的操作模式，退出时恢复 */
  aerialPrevMode: ViewMode | null;
  toggleAerialView: () => void;

  /** 第三视角设备视图：斜上方观察轨道机械臂跟随机位运动 */
  rigView: boolean;
  setRigView: (v: boolean) => void;

  /** 预演播放时间线（master 时间码 + 相机关键帧） */
  previz: PrevizTimeline | null;
  /** 机位朝向计算：计算前 / 计算后两组数据（缺口固定朝机位一侧，把视线摆向环屏） */
  shotAim: ShotAimFile | null;
  /** 机位朝向模式：raw = UE 原始数据，led = 摆向环屏（应用每镜修正角 Δ） */
  aimMode: 'raw' | 'led';
  toggleAimMode: () => void;
  /**
   * 整个集合（布景 + 演员 + 机位）绕环屏中心整体旋转的角度，度。
   * 环屏与缺口固定，转集合等价于换一个方向对准 LED，集合内部相对关系不变。
   */
  ensembleYaw: number;
  /** true = 按当前镜头的朝环屏修正角自动转向；false = 手动（一键旋转后进入手动） */
  ensembleAuto: boolean;
  setEnsembleYaw: (deg: number) => void;
  /** 自由拖动转向：设置角度并切到手动，避免切镜头时被自动角度覆盖 */
  setEnsembleYawManual: (deg: number) => void;
  rotateEnsemble: (deltaDeg: number) => void;
  toggleEnsembleAuto: () => void;
  /** 播放头位置，秒 */
  timelineTime: number;
  playing: boolean;
  playbackSpeed: number;
  /** 视口相机是否跟随预演机位 */
  followPreviz: boolean;
  togglePlayback: () => void;
  setTimelineTime: (t: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  toggleFollowPreviz: () => void;
  seekShot: (shotId: string) => void;

  initFromServer: () => Promise<void>;
  /** 从后端拉取 UE 祈祷室场景快照并替换当前布景，返回错误信息（null 表示成功） */
  importUeScene: () => Promise<string | null>;
  loadSetPlan: () => Promise<string | null>;
  setPlanScene: (scene: string) => void;
  toggleSetPlan: () => void;
  setStage: (id: string) => void;
  setStagePosition: (pos: Vec3) => void;
  /** 棚位置拖拽编辑模式（视口中环心显示移动 gizmo），不随方案保存 */
  stagePosEditing: boolean;
  setStagePosEditing: (v: boolean) => void;
  /** 集合旋转锚点（世界坐标）：整个内容集合围绕该点转向，默认环心 */
  ensemblePivot: Vec3;
  setEnsemblePivot: (p: Vec3) => void;
  /** 锚点拖拽编辑模式（点击锚点进入，拖 gizmo 移动，点空白退出） */
  pivotEditing: boolean;
  setPivotEditing: (v: boolean) => void;
  updateAsset: (id: string, patch: Partial<SceneAsset>) => void;
  /** 批量显隐，一次 set 只触发一次自动保存 */
  setAssetVisibility: (ids: string[], visible: boolean) => void;
  removeAsset: (id: string) => void;
  duplicateAsset: (id: string) => void;
  selectAsset: (id: string | null) => void;
  setMode: (mode: ViewMode) => void;
  setGizmo: (gizmo: GizmoMode) => void;
  patchCamera: (patch: Partial<ShotCamera>) => void;
  addMeasurePoint: (point: Vec3) => void;
  clearMeasurement: () => void;
  removeMeasurement: (id: string) => void;
  setClearanceThreshold: (value: number) => void;
  toggleFrustum: () => void;
  resetDemo: () => void;
  loadScenario: (raw: unknown) => string | null;
  buildScenario: () => Scenario;
}


export const useScene = create<SceneState>((set, get) => ({
  assets: demoAssets(),
  selectedId: null,
  hoveredId: null,
  hoverAsset: (id) => set({ hoveredId: id }),
  camera: { ...DEMO_SHOT },
  mode: 'orbit',
  gizmo: 'translate',
  pendingPoint: null,
  measurements: [],
  clearanceThreshold: 1,
  showFrustum: true,
  showLedRing: true,
  showGrid: true,
  showPeople: true,
  stages: [],
  currentStageId: null,
  stagePosition: [0, 0, 0],
  stagePosEditing: false,
  setOffset: [0, 0, 0],
  ensemblePivot: [0, 0, 0],
  pivotEditing: false,
  stageRotationY: 0,
  serverState: 'connecting',
  setPlan: null,
  planScene: null,
  showSetPlan: false,
  // 默认打开空态（左侧全量镜头列表 + 中间生成按钮），点击「生成 Techviz 方案」后进入方案视图
  planLibraryMode: 'empty',
  showShotMarkers: true,
  sceneKey: null,
  shotCatalog: null,
  sceneAssetMap: null,
  activeNoDataShot: null,
  activeShotId: null,
  activeShotUsedIds: null,
  shotHiddenIds: [],
  // 默认视角：站在环内石拱通道里、朝对面的 LED 屏取景
  // （棚中央是石拱布景，正对 -Z 的平视会被布景挡住，所以沿用预演机位略仰的取景方向）
  viewRequest: {
    position: [-2.4, 2.2, 5.6],
    target: [-0.1, 5.0, -5.9],
    nonce: 0,
  },
  takeVisible: true,
  adjustDirty: false,
  impact: { running: false, result: null },
  camPipVisible: false,
  camPipEnlarged: false,
  takeVideoEl: null,
  setTakeVideoEl: (el) => set({ takeVideoEl: el }),
  aerialView: false,
  aerialPrevMode: null,
  rigView: false,
  previz: null,
  shotAim: null,
  aimMode: 'led',
  ensembleYaw: 0,
  // 默认不自动转向：机位取景不带集合旋转角，保持 0°，需要时手动旋转或开启自动
  ensembleAuto: false,
  timelineTime: 0,
  playing: false,
  playbackSpeed: 1,
  followPreviz: false,

  initFromServer: async () => {
    try {
      const [stagesRes, sceneRes] = await Promise.all([
        apiFetch('/api/stages'),
        apiFetch('/api/scene'),
      ]);
      // 未登录的 401 由 apiFetch 统一处理（清理登录态并回到登录页）
      if (stagesRes.status === 401 || sceneRes.status === 401) {
        set({ serverState: 'offline' });
        return;
      }
      const stagesJson = await stagesRes.json();
      const sceneJson = await sceneRes.json();
      const stages: StageDef[] = stagesJson?.data ?? [];
      const saved = sceneJson?.data as Partial<Scenario> | null;
      const patch: Partial<SceneState> = { stages, serverState: 'online' };
      patch.sceneKey = saved?.sceneKey ?? null;
      if (saved && Array.isArray(saved.assets)) {
        // 已存档的骨骼角色：以最新导出参数为准，但保留用户手动调整过的位置与缩放
        patch.assets = saved.assets.some((a) => a.kind === 'skeletal')
          ? saved.assets.map((a) => {
              if (a.kind !== 'skeletal') return a;
              const isOldDefault =
                (JSON.stringify(a.position) === JSON.stringify([0, 0, 3]) &&
                  JSON.stringify(a.scale) === JSON.stringify([1, 1, 1])) ||
                // 2.6 是旧网格渲染时代的默认缩放，预演小人按真人比例渲染，一并迁移
                JSON.stringify(a.scale) === JSON.stringify([2.6, 2.6, 2.6]);
              return isOldDefault
                ? { ...DEMO_ACTOR, rotation: a.rotation, visible: a.visible }
                : {
                    ...DEMO_ACTOR,
                    position: a.position,
                    rotation: a.rotation,
                    scale: a.scale,
                    visible: a.visible,
                  };
            })
          : [DEMO_ACTOR, ...saved.assets];
        patch.camera = { ...DEMO_SHOT, ...saved.camera };
        patch.measurements = Array.isArray(saved.measurements) ? saved.measurements : [];
        patch.clearanceThreshold =
          typeof saved.clearanceThreshold === 'number' ? saved.clearanceThreshold : 1;
      }
      // 恢复棚选择与棚位置；无存档时默认第一个棚、原点
      const savedStage = saved?.currentStageId;
      patch.currentStageId = stages.some((s) => s.id === savedStage)
        ? (savedStage as string)
        : (stages[0]?.id ?? null);
      patch.stagePosition =
        Array.isArray(saved?.stagePosition) && saved.stagePosition.length === 3
          ? saved.stagePosition
          : [0, 0, 0];
      set(patch);
      hydrated = true;
      // 布景方案为可选数据：静默加载，缺失不影响工作台
      try {
        const planRes = await apiFetch('/api/setplan');
        if (planRes.ok) {
          const planJson = await planRes.json();
          const plan = planJson?.data as SetPlanFile | null;
          if (plan?.plans && Object.keys(plan.plans).length > 0) {
            const first = Object.keys(plan.plans)[0];
            const { planScene } = get();
            // 优先用当前方案关联的场次，避免停在第一个场次的置景清单上
            const preferred =
              (planScene && plan.plans[planScene] ? planScene : null) ??
              (patch.sceneKey && plan.plans[patch.sceneKey] ? patch.sceneKey : null) ??
              first;
            set({
              setPlan: plan,
              planScene: preferred,
              showSetPlan: true,
              // 默认空态：即使有方案数据也不自动进入方案视图，由用户点击「生成」进入；
              // 恢复自动进入时取消下一行注释
              // ...(forceEmptyPlans ? {} : { planLibraryMode: 'ready' as const }),
            });
            // 置景筛选自动生效：只默认显示与人物有交互的置景资产
            await get().applySetAssetFilter();
          } else if (!forceEmptyPlans) {
            // 后端尚无任何方案：进入空态（左侧全量镜头列表 + 中间生成按钮）
            set({ planLibraryMode: 'empty' });
          }
        }
      } catch {
        /* 无布景方案时忽略 */
      }
      // 预演时间线为可选数据：有则启用底部播放条
      try {
        const tlRes = await apiFetch('/api/previz/timeline');
        if (tlRes.ok) {
          const tlJson = await tlRes.json();
          const previz = tlJson?.data as PrevizTimeline | null;
          if (previz?.shots?.length) set({ previz, timelineTime: 0 });
        }
      } catch {
        /* 无预演时间线时忽略 */
      }
      // 机位朝向计算（可选）：提供计算前 / 计算后两组覆盖率
      try {
        const aimRes = await apiFetch('/api/previz/shot-aim');
        if (aimRes.ok) {
          const aimJson = await aimRes.json();
          const shotAim = aimJson?.data as ShotAimFile | null;
          if (shotAim?.shots?.length) set({ shotAim });
        }
      } catch {
        /* 无机位朝向数据时忽略 */
      }
      // 全量镜头清单 + 场次场景映射（可选）：左侧三级分组镜头树的数据源
      try {
        const [namesRes, mapRes] = await Promise.all([
          apiFetch('/api/shot-names'),
          apiFetch('/api/scene-asset-map'),
        ]);
        if (namesRes.ok && mapRes.ok) {
          const namesJson = await namesRes.json();
          const mapJson = await mapRes.json();
          const record = (namesJson?.data?.shots ?? {}) as Record<string, ShotNameMeta>;
          // 预演时间线里的镜头（按 file_name 同源键匹配）才有 3D 机位数据
          const rigKeys = new Set((get().previz?.shots ?? []).map((s) => s.name));
          const catalog: ShotCatalogEntry[] = Object.entries(record).map(([key, meta]) => ({
            key,
            short: meta.short || key,
            take: typeof meta.take === 'number' ? meta.take : null,
            videoUrl: meta.videoUrl ?? null,
            thumbnailUrl: meta.thumbnailUrl ?? null,
            durationSec: typeof meta.durationSec === 'number' ? meta.durationSec : 0,
            scene: parseSceneCode(meta.short || key),
            hasRig: rigKeys.has(key),
          }));
          set({
            shotCatalog: catalog,
            sceneAssetMap: (mapJson?.data ?? {}) as Record<string, string[]>,
          });
        }
      } catch {
        /* 缺失时镜头树为空，不影响其他功能 */
      }
      // 默认视角：取本场第一镜的机位，并把整个集合按该镜头的朝环屏角度整体转向。
      // 棚中央是石拱布景，随便放一个自由机位很容易被布景挡死或正对缺口，
      // 直接用真实预演机位取景，保证打开页面就朝 LED 环屏。
      {
        const state = get();
        const first =
          state.previz?.shots.find((s) => s.scene === state.sceneKey) ?? state.previz?.shots[0];
        if (first) {
          const aim = state.shotAim?.shots.find((row) => row.id === first.id) ?? null;
          const turn = state.aimMode === 'led' && aim ? aim.deltaDeg : 0;
          const yawDeg = state.ensembleAuto ? turn : state.ensembleYaw;
          set({ ensembleYaw: yawDeg });
          const raw = shotPoseAt(first, first.start);
          const pose = raw ? rotatePoseY(raw, yawDeg) : null;
          if (pose) {
            const yaw = (pose.yaw * Math.PI) / 180;
            const pitch = (pose.pitch * Math.PI) / 180;
            const cp = Math.cos(pitch);
            state.goToView(pose.position, [
              pose.position[0] - Math.sin(yaw) * cp * 6,
              pose.position[1] + Math.sin(pitch) * 6,
              pose.position[2] - Math.cos(yaw) * cp * 6,
            ]);
          }
        }
      }
    } catch {
      set({ serverState: 'offline' });
    }
  },

  selectShot: (shotId) => {
    const { previz, assets, shotAim, aimMode, ensembleAuto, ensembleYaw } = get();
    if (!shotId) {
      set({
        activeShotId: null,
        activeShotUsedIds: null,
        shotHiddenIds: [],
        activeNoDataShot: null,
        playing: false,
        followPreviz: false,
      });
      return;
    }
    const shot = previz?.shots.find((s) => s.id === shotId);
    if (!shot) return;
    // 本镜头用到的元素：24 帧采样视锥并集，其余元素不渲染。
    // 只做元素剔除，不改操作模式；视口摆到该镜头首帧，
    // 并把「整个集合」按该镜头的朝环屏角度整体转向（机位与演员相对关系不变）。
    const ids = usedAssetIds(buildBoxes(assets), shot);
    const aim = aimMode === 'led' ? (shotAim?.shots.find((row) => row.id === shot.id) ?? null) : null;
    const yawDeg = ensembleAuto ? (aim?.deltaDeg ?? 0) : ensembleYaw;
    set({
      activeShotId: shot.id,
      activeShotUsedIds: ids,
      // 换镜头即恢复默认：上个镜头里手工隐藏的元素不应影响这一镜
      shotHiddenIds: [],
      activeNoDataShot: null,
      timelineTime: shot.start,
      playing: false,
      followPreviz: false,
      ensembleYaw: yawDeg,
    });
    // 置景清单按场次维护：切到其他场次的镜头时，跟随切换置景筛选
    const planScene = get().planScene;
    if (shot.scene && shot.scene !== planScene && get().setPlan?.plans[shot.scene]) {
      get().setPlanScene(shot.scene);
    }
    const raw = shotPoseAt(shot, shot.start);
    // 高空视角由 AerialRig 接管相机，跳转会打断俯视观察
    if (raw && !get().aerialView) {
      const pose = rotatePoseY(raw, yawDeg);
      const yaw = (pose.yaw * Math.PI) / 180;
      const pitch = (pose.pitch * Math.PI) / 180;
      const cp = Math.cos(pitch);
      get().goToView(pose.position, [
        pose.position[0] - Math.sin(yaw) * cp * 6,
        pose.position[1] + Math.sin(pitch) * 6,
        pose.position[2] - Math.cos(yaw) * cp * 6,
      ]);
    }
  },

  goToView: (position, target) =>
    set((state) => ({
      viewRequest: { position, target, nonce: (state.viewRequest?.nonce ?? 0) + 1 },
    })),

  /**
   * 选中无 3D 机位数据的镜头：3D 视口不摆机位（保持自由视角），
   * take 小窗照播该镜头视频，机位取景画中画显示占位。
   */
  selectNoDataShot: (shot) =>
    set({
      activeNoDataShot: shot,
      activeShotId: null,
      activeShotUsedIds: null,
      shotHiddenIds: [],
      playing: false,
      followPreviz: false,
    }),

  toggleTake: () => set((state) => ({ takeVisible: !state.takeVisible })),

  toggleCamPip: () => set((state) => ({ camPipVisible: !state.camPipVisible })),

  toggleCamPipEnlarged: () => set((state) => ({ camPipEnlarged: !state.camPipEnlarged })),

  toggleAerialView: () =>
    set((state) =>
      state.aerialView
        ? // 退出高空：恢复进入前的操作模式
          { aerialView: false, mode: state.aerialPrevMode ?? 'orbit', aerialPrevMode: null }
        : // 进入高空：不跟随镜头，记录原模式后切到自由视角；第三视角互斥自动关闭
          {
            aerialView: true,
            followPreviz: false,
            aerialPrevMode: state.mode,
            mode: 'orbit',
            rigView: false,
          },
    ),

  setRigView: (v) => {
    const state = get();
    if (v === state.rigView) return;
    if (!v) {
      // 关闭第三视角：RigViewRig 负责恢复进入前的相机位姿
      set({ rigView: false });
      return;
    }
    // 开启第三视角：俯视互斥自动关，退出机位取景/测量回到自由视角交给 RigViewRig 接管相机
    set({
      rigView: true,
      aerialView: false,
      aerialPrevMode: null,
      followPreviz: false,
      mode: 'orbit',
    });
  },

  setEnsembleYaw: (deg) => set({ ensembleYaw: normDeg(deg) }),

  setEnsembleYawManual: (deg) => set({ ensembleYaw: normDeg(deg), ensembleAuto: false }),

  /** 一键把整个集合在环屏内转向（集合内部相对关系不变） */
  rotateEnsemble: (deltaDeg) =>
    set((state) => ({ ensembleYaw: normDeg(state.ensembleYaw + deltaDeg), ensembleAuto: false })),
  setEnsemblePivot: (p) => set({ ensemblePivot: [...p] as Vec3 }),
  setPivotEditing: (v) => set({ pivotEditing: v }),

  toggleEnsembleAuto: () => {
    const state = get();
    if (state.ensembleAuto) {
      set({ ensembleAuto: false });
      return;
    }
    const shot = state.activeShotId
      ? (state.previz?.shots.find((s) => s.id === state.activeShotId) ?? null)
      : null;
    const aim = shot ? (state.shotAim?.shots.find((row) => row.id === shot.id) ?? null) : null;
    set({
      ensembleAuto: true,
      ensembleYaw: state.aimMode === 'led' && aim ? normDeg(aim.deltaDeg) : 0,
    });
  },

  toggleAimMode: () => {
    const state = get();
    const aimMode = state.aimMode === 'raw' ? 'led' : 'raw';
    const shot = state.activeShotId
      ? (state.previz?.shots.find((s) => s.id === state.activeShotId) ?? null)
      : null;
    const aim = shot ? (state.shotAim?.shots.find((row) => row.id === shot.id) ?? null) : null;
    set({
      aimMode,
      // 自动模式下跟着切换集合朝向；手动模式保留用户自己转的角度
      ...(state.ensembleAuto
        ? { ensembleYaw: aimMode === 'led' && aim ? normDeg(aim.deltaDeg) : 0 }
        : {}),
    });
  },

  togglePlayback: () => {
    const { playing, previz, timelineTime, activeShotId } = get();
    if (!previz) return;
    const shot = activeShotId ? previz.shots.find((s) => s.id === activeShotId) : null;
    if (shot) {
      // 镜头内播放：播完回到本镜头入点；播放时跟随机位，暂停回到自由视角
      if (playing) {
        set({ playing: false, followPreviz: false });
      } else {
        const atEnd = timelineTime < shot.start || timelineTime >= shot.end - 0.05;
        // 高空视角下播放不抢相机，保持俯视观察机位运动
        set({
          timelineTime: atEnd ? shot.start : timelineTime,
          playing: true,
          followPreviz: !get().aerialView,
        });
      }
      return;
    }
    // 播放到末尾再按播放：从头开始
    if (!playing && timelineTime >= previz.duration - 0.05) set({ timelineTime: 0, playing: true });
    else set({ playing: !playing });
  },

  setTimelineTime: (t) => {
    const { previz } = get();
    const max = previz?.duration ?? 0;
    set({ timelineTime: Math.max(0, Math.min(max, t)) });
  },

  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

  toggleFollowPreviz: () =>
    set((state) => {
      const followPreviz = !state.followPreviz;
      // 跟随机位与高空视角互斥
      return { followPreviz, aerialView: followPreviz ? false : state.aerialView };
    }),

  seekShot: (shotId) => {
    const shot = get().previz?.shots.find((s) => s.id === shotId);
    if (shot) set({ timelineTime: shot.start });
  },

  importUeScene: async () => {
    try {
      const res = await apiFetch('/api/ue/prayer-room');
      if (!res.ok) return `UE 场景数据不可用（HTTP ${res.status}）`;
      const json = await res.json();
      const data = json?.data as { assets?: SceneAsset[]; lights?: SceneAsset[]; stageId?: string } | null;
      if (!data || !Array.isArray(data.assets) || data.assets.length === 0) {
        return 'UE 场景数据为空，请先在 UE 中打开祈祷室关卡后重新采集';
      }
      const { stages, currentStageId } = get();
      const stageId =
        data.stageId && stages.some((s) => s.id === data.stageId) ? data.stageId : currentStageId;
      set({
        // 灯光作为 kind 'light' 的资产与布景一起进入场景（视口画灯位标记，大纲列出）
        assets: [...data.assets, ...(Array.isArray(data.lights) ? data.lights : [])],
        currentStageId: stageId,
        selectedId: null,
        measurements: [],
        pendingPoint: null,
        activeShotId: null,
        activeShotUsedIds: null,
        shotHiddenIds: [],
        mode: 'orbit',
      });
      return null;
    } catch {
      return '导入失败：后端不可达';
    }
  },

  setStage: (id) => set({ currentStageId: id, stagePosition: [0, 0, 0], stagePosEditing: false }),

  setStagePosition: (pos) => set({ stagePosition: [...pos] as Vec3 }),

  setStagePosEditing: (v) => set({ stagePosEditing: v }),

  setSetOffset: (offset) => set({ setOffset: [...offset] as Vec3 }),
  setStageRotationY: (deg) => set({ stageRotationY: deg }),

  applySetAssetFilter: async () => {
    const st = get();
    const scene = st.planScene;
    let plan = st.setPlan && scene ? st.setPlan.plans[scene] : null;
    if (!plan) return;
    if (!plan.setInstanceIds) {
      // 旧版布景方案没有实例级置景清单：拉取最新方案后重试一次
      const err = await st.loadSetPlan();
      if (err) return;
      plan = get().setPlan && scene ? get().setPlan!.plans[scene] : null;
      if (!plan?.setInstanceIds) return;
    }
    const keep = new Set(plan.setInstanceIds);
    set({
      assets: get().assets.map((a) => (a.kind === 'ue' ? { ...a, visible: keep.has(a.instanceId) } : a)),
    });
  },

  loadSetPlan: async () => {
    try {
      const res = await apiFetch('/api/setplan');
      if (!res.ok) return `布景方案数据不可用（HTTP ${res.status}）`;
      const json = await res.json();
      const data = json?.data as SetPlanFile | null;
      if (!data || !data.plans || Object.keys(data.plans).length === 0) {
        return '尚无布景方案，请先在 UE 工程侧完成预演相机数据采集';
      }
      const scenes = Object.keys(data.plans);
      const { planScene, sceneKey } = get();
      // 优先保持当前场次，其次方案关联场次，最后第一个
      const next =
        (planScene && data.plans[planScene] ? planScene : null) ??
        (sceneKey && data.plans[sceneKey] ? sceneKey : null) ??
        scenes[0];
      set({ setPlan: data, planScene: next, showSetPlan: true });
      await get().applySetAssetFilter();
      return null;
    } catch {
      return '布景方案加载失败：后端不可达';
    }
  },

  setPlanScene: (scene) => {
    set({ planScene: scene });
    get().applySetAssetFilter();
  },

  activePlanId: null,
  // 空态点击「生成 Techviz 方案」：模拟生成完成，切回方案视图
  startPlanGeneration: () => set({ planLibraryMode: 'ready' }),
  selectPlan: (planId) => {
    const st = get();
    const data = st.setPlan;
    if (!data) return;
    let scene: string | null = null;
    let plan: {
      offset: Vec3;
      rotationDeg?: number;
      setInstanceIds: string[];
      platform?: { position: Vec3; size: Vec3 } | null;
    } | null = null;
    for (const [sc, entry] of Object.entries(data.plans)) {
      const hit = entry.planList?.find((p) => p.planId === planId);
      if (hit) {
        scene = sc;
        plan = hit;
        break;
      }
    }
    if (!scene || !plan) return;
    // 应用该方案内容位姿：平移（解算值是环心偏移，取反作用到集合）+ 绕环心旋转
    st.setSetOffset([-plan.offset[0], -plan.offset[1], -plan.offset[2]]);
    st.setStageRotationY(plan.rotationDeg ?? 0);
    // 方案置景筛选：方案实例集显示，其余置景隐藏
    const keep = new Set(plan.setInstanceIds);
    // 地台虚拟资产（box 代理渲染）：随方案注入资产列表，可显隐、不参与置景管理
    const platformAsset: SceneAsset | null = plan.platform
      ? {
          instanceId: 'platform-main',
          assetId: 'platform/main',
          name: '表演区地台',
          code: 'DITAI_01',
          kind: 'box',
          url: '',
          size: plan.platform.size,
          color: '#2f7fae',
          position: plan.platform.position,
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          visible: true,
        }
      : null;
    set({
      activePlanId: planId,
      planScene: scene,
      // 切换方案：调整与影响检查结果一并重置
      adjustDirty: false,
      impact: { running: false, result: null },
      assets: get()
        .assets.filter((a) => a.instanceId !== 'platform-main')
        .map((a) => (a.kind === 'ue' ? { ...a, visible: keep.has(a.instanceId) } : a))
        .concat(platformAsset ? [platformAsset] : []),
    });
  },

  /** AI 影响检查：对当前方案覆盖的镜头逐镜做穿帮规则判定 */
  runImpactCheck: () => {
    set({ impact: { running: true, result: null } });
    setTimeout(() => {
      const st = get();
      const entry = st.setPlan && st.planScene ? st.setPlan.plans[st.planScene] : null;
      const plan = st.activePlanId && entry
        ? entry.planList?.find((p) => p.planId === st.activePlanId)
        : null;
      const ids = new Set(plan?.coveredShotIds ?? []);
      const shots = (st.previz?.shots ?? []).filter((s) => ids.has(s.id));
      const stage = st.stages.find((s) => s.id === st.currentStageId) ?? null;
      const ring = stage
        ? { radius: stage.diameter / 2, height: stage.height, arc: stage.arc }
        : null;
      const result = analyzeShotImpacts({
        shots,
        assets: st.assets,
        platform: plan?.platform ?? null,
        ring,
        ensembleYaw: st.ensembleYaw,
        // 锚点转向：绕锚点旋转等价于绕环心旋转 + 等效平移
        setOffset: pivotShift(st.setOffset, st.ensemblePivot, st.ensembleYaw),
        stageRotationY: st.stageRotationY,
      });
      set({ impact: { running: false, result }, adjustDirty: false });
    }, 600);
  },

  toggleSetPlan: () => set((state) => ({ showSetPlan: !state.showSetPlan })),

  /** 地台尺寸调整（宽/深 ±）：同步改方案 platform 数据与地台虚拟资产 */
  resizePlatform: (deltaW, deltaD) => {
    const st = get();
    const planId = st.activePlanId;
    const data = st.setPlan;
    if (!planId || !data) return;
    let newSize: Vec3 | null = null;
    for (const entry of Object.values(data.plans)) {
      const plan = entry.planList?.find((p) => p.planId === planId);
      if (plan?.platform) {
        const s = plan.platform.size;
        newSize = [
          Math.max(1, Math.round((s[0] + deltaW) * 10) / 10),
          s[1],
          Math.max(1, Math.round((s[2] + deltaD) * 10) / 10),
        ];
        plan.platform.size = newSize;
        break;
      }
    }
    if (!newSize) return;
    set({
      setPlan: { ...data, plans: { ...data.plans } },
      assets: get().assets.map((a) =>
        a.instanceId === 'platform-main' ? { ...a, size: newSize! } : a,
      ),
      adjustDirty: true,
    });
  },

  /** 添加基础模型：默认落在内容原点（随方案位姿），拖拽落点传内容局部坐标 */
  addPrimitive: (kind, position) => {
    const names = { box: '长方体', sphere: '球体', column: '圆柱' };
    const codes = { box: 'BOX', sphere: 'QIUTI', column: 'YUANZHU' };
    const asset: SceneAsset = {
      instanceId: `prim-${kind}-${uid('n')}`,
      assetId: `prim/${kind}`,
      name: names[kind],
      code: codes[kind],
      kind,
      url: '',
      size: kind === 'column' ? [1, 2, 1] : [1, 1, 1],
      color: '#5b8bd0',
      position: position ?? [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
    };
    set({ assets: [...get().assets, asset], selectedId: asset.instanceId, adjustDirty: true });
  },

  /** 资产 tab 置景管理：加入/移出当前方案的置景集，并同步该资产显隐 */
  togglePlanSetAsset: (instanceId, inSet) => {
    const st = get();
    const planId = st.activePlanId;
    const data = st.setPlan;
    if (!planId || !data) return;
    let hit: { offset: Vec3; rotationDeg?: number; setInstanceIds: string[] } | null = null;
    for (const entry of Object.values(data.plans)) {
      const plan = entry.planList?.find((p) => p.planId === planId);
      if (plan) {
        hit = plan;
        break;
      }
    }
    if (!hit || hit.setInstanceIds.includes(instanceId) === inSet) return;
    hit.setInstanceIds = inSet
      ? [...hit.setInstanceIds, instanceId]
      : hit.setInstanceIds.filter((id) => id !== instanceId);
    set({
      // 换新对象引用触发订阅方重算
      setPlan: { ...data, plans: { ...data.plans } },
      // 入置景即显示，移除置景即隐藏
      assets: get().assets.map((a) =>
        a.instanceId === instanceId && a.kind === 'ue' ? { ...a, visible: inSet } : a,
      ),
    });
  },

  updateAsset: (id, patch) =>
    set((state) => ({
      assets: state.assets.map((a) => (a.instanceId === id ? { ...a, ...patch } : a)),
      // 内容被移动/旋转/缩放：标记有待影响检查
      adjustDirty: true,
    })),

  setAssetVisibility: (ids, visible) => {
    const targets = new Set(ids);
    set((state) => ({
      assets: state.assets.map((a) => (targets.has(a.instanceId) ? { ...a, visible } : a)),
    }));
  },

  /** 镜头模式下的手工显隐：visible=true 表示从隐藏覆盖里移除，恢复本镜头默认可见 */
  setShotVisibility: (ids, visible) =>
    set((state) => {
      const next = new Set(state.shotHiddenIds);
      for (const id of ids) {
        if (visible) next.delete(id);
        else next.add(id);
      }
      return { shotHiddenIds: [...next] };
    }),

  removeAsset: (id) =>
    set((state) => ({
      assets: state.assets.filter((a) => a.instanceId !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
      shotHiddenIds: state.shotHiddenIds.filter((item) => item !== id),
    })),

  duplicateAsset: (id) => {
    const { assets } = get();
    const source = assets.find((a) => a.instanceId === id);
    if (!source) return;
    const copy: SceneAsset = {
      ...source,
      instanceId: uid('inst'),
      name: `${source.name} 副本`,
      position: [source.position[0] + 0.8, source.position[1], source.position[2] + 0.8],
    };
    set({ assets: [...assets, copy], selectedId: copy.instanceId });
  },

  selectAsset: (id) => set({ selectedId: id }),

  setMode: (mode) =>
    set({
      mode,
      pendingPoint: null,
      ...(mode === 'measure' ? { selectedId: null } : {}),
    }),

  setGizmo: (gizmo) => set({ gizmo }),

  patchCamera: (patch) => set((state) => ({ camera: { ...state.camera, ...patch } })),

  addMeasurePoint: (point) => {
    const { pendingPoint, measurements } = get();
    if (!pendingPoint) {
      set({ pendingPoint: point });
      return;
    }
    const [ax, ay, az] = pendingPoint;
    const [bx, by, bz] = point;
    const measurement: Measurement = {
      id: uid('m'),
      a: pendingPoint,
      b: point,
      distance: Math.hypot(bx - ax, by - ay, bz - az),
      deltaY: Math.abs(by - ay),
      deltaXZ: Math.hypot(bx - ax, bz - az),
    };
    set({ measurements: [measurement, ...measurements].slice(0, 12), pendingPoint: null });
  },

  clearMeasurement: () => set({ pendingPoint: null, measurements: [] }),

  removeMeasurement: (id) =>
    set((state) => ({ measurements: state.measurements.filter((m) => m.id !== id) })),

  setClearanceThreshold: (value) =>
    set({ clearanceThreshold: Math.max(0, Math.min(10, value)) }),

  toggleFrustum: () => set((state) => ({ showFrustum: !state.showFrustum })),

  toggleShotMarkers: () => set((state) => ({ showShotMarkers: !state.showShotMarkers })),
  toggleLedRing: () => set((state) => ({ showLedRing: !state.showLedRing })),
  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
  togglePeople: () => set((state) => ({ showPeople: !state.showPeople })),

  resetDemo: () =>
    set({
      assets: demoAssets(),
      camera: { ...DEMO_SHOT },
      selectedId: null,
      measurements: [],
      pendingPoint: null,
      mode: 'orbit',
    }),

  buildScenario: () => {
    const { camera, assets, measurements, clearanceThreshold, currentStageId, stagePosition, setOffset, sceneKey } = get();
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      currentStageId,
      stagePosition,
      setOffset,
      sceneKey,
      camera,
      assets,
      measurements,
      clearanceThreshold,
    };
  },

  loadScenario: (raw) => {
    try {
      const data = raw as Partial<Scenario>;
      if (!data || !Array.isArray(data.assets) || !data.camera) {
        return '文件格式不正确：缺少 assets 或 camera';
      }
      set({
        assets: data.assets,
        camera: { ...DEMO_SHOT, ...data.camera },
        sceneKey: typeof data.sceneKey === 'string' ? data.sceneKey : null,
        measurements: Array.isArray(data.measurements) ? data.measurements : [],
        clearanceThreshold: typeof data.clearanceThreshold === 'number' ? data.clearanceThreshold : 1,
        currentStageId:
          typeof data.currentStageId === 'string' && get().stages.some((s) => s.id === data.currentStageId)
            ? data.currentStageId
            : get().currentStageId,
        stagePosition:
          Array.isArray(data.stagePosition) && data.stagePosition.length === 3
            ? data.stagePosition
            : [0, 0, 0],
        setOffset:
          Array.isArray(data.setOffset) && data.setOffset.length === 3 ? data.setOffset : [0, 0, 0],
        selectedId: null,
        pendingPoint: null,
        activeShotId: null,
        activeShotUsedIds: null,
        shotHiddenIds: [],
      });
      return null;
    } catch {
      return '解析失败：不是合法的 Techviz 方案文件';
    }
  },
}));

/**
 * 自动保存：任何数据变更后 800ms 落盘到后端（后端写 SQLite 持久化）。
 * 只监听数据字段，忽略 selectedId/mode 等纯 UI 状态。
 */
useScene.subscribe((state, prev) => {
  if (!hydrated) return;
  if (
    state.assets === prev.assets &&
    state.camera === prev.camera &&
    state.measurements === prev.measurements &&
    state.clearanceThreshold === prev.clearanceThreshold &&
    state.currentStageId === prev.currentStageId &&
    state.stagePosition === prev.stagePosition &&
    state.setOffset === prev.setOffset &&
    state.sceneKey === prev.sceneKey
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const { camera, assets, measurements, clearanceThreshold, currentStageId, stagePosition, setOffset, sceneKey } =
      useScene.getState();
    apiFetch('/api/scene', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        currentStageId,
        stagePosition,
        setOffset,
        sceneKey,
        camera,
        assets,
        measurements,
        clearanceThreshold,
      }),
    })
      .then(() => {
        /* 401 由 apiFetch 统一处理 */
      })
      .catch(() => {
        useScene.setState({ serverState: 'offline' });
      });
  }, 800);
});
