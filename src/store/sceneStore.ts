import { create } from 'zustand';
import { DEMO_SHOT, demoAssets } from '../data/mockData';
import { apiFetch } from '../lib/api';
import { buildBoxes, usedAssetIds } from '../lib/shotFilter';
import type {
  GizmoMode,
  Measurement,
  PlanMeta,
  SceneAsset,
  SetPlanFile,
  ShotCamera,
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

/** 是否已从后端恢复过数据；恢复完成后才开启自动保存，避免用 demo 数据覆盖存档 */
let hydrated = false;

export interface Scenario {
  version: 2;
  savedAt: string;
  currentStageId: string | null;
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
  camera: ShotCamera;
  mode: ViewMode;
  gizmo: GizmoMode;
  pendingPoint: Vec3 | null;
  measurements: Measurement[];
  clearanceThreshold: number;
  showFrustum: boolean;
  /** 棚清单（后端扫描 UE 工程得到），棚固定于原点，仅可切换 */
  stages: StageDef[];
  currentStageId: string | null;
  /** 后端连接状态，用于顶栏提示 */
  serverState: 'connecting' | 'online' | 'offline';
  /** 布景方案（由预演相机动画 + 环屏几何推导，后端生成） */
  setPlan: SetPlanFile | null;
  planScene: string | null;
  showSetPlan: boolean;

  /** 方案管理：后端按用户隔离的方案列表、当前方案、关联场次 */
  plans: PlanMeta[];
  planName: string | null;
  sceneKey: string | null;
  refreshPlans: () => Promise<void>;
  /** 以场次新建方案（同名/同场次已存在时返回错误信息） */
  createPlan: (scene: string) => Promise<string | null>;
  switchPlan: (name: string) => Promise<string | null>;
  deletePlan: (name: string) => Promise<string | null>;
  loadCurrentScene: () => Promise<void>;

  /** 镜头库：activeShotId 为 null 表示「完整场景」 */
  activeShotId: string | null;
  /** 当前镜头用到的资产 id（视锥剔除结果），null 表示不过滤 */
  activeShotUsedIds: string[] | null;
  selectShot: (shotId: string | null) => void;
  /** 右下角 take 视频小窗是否展开 */
  takeVisible: boolean;
  toggleTake: () => void;

  /** 高空俯视视角：播放时从场景上方观察机位如何运动 */
  aerialView: boolean;
  toggleAerialView: () => void;

  /** 预演播放时间线（master 时间码 + 相机关键帧） */
  previz: PrevizTimeline | null;
  /** 机位朝向计算：计算前 / 计算后两组数据（缺口固定朝机位一侧，把视线摆向环屏） */
  shotAim: ShotAimFile | null;
  /** 机位朝向模式：raw = UE 原始数据，led = 摆向环屏（应用每镜修正角 Δ） */
  aimMode: 'raw' | 'led';
  toggleAimMode: () => void;
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
  camera: { ...DEMO_SHOT },
  mode: 'orbit',
  gizmo: 'translate',
  pendingPoint: null,
  measurements: [],
  clearanceThreshold: 1,
  showFrustum: true,
  stages: [],
  currentStageId: null,
  serverState: 'connecting',
  setPlan: null,
  planScene: null,
  showSetPlan: false,
  plans: [],
  planName: null,
  sceneKey: null,
  activeShotId: null,
  activeShotUsedIds: null,
  takeVisible: true,
  aerialView: false,
  previz: null,
  shotAim: null,
  aimMode: 'raw',
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
        patch.assets = saved.assets;
        patch.camera = { ...DEMO_SHOT, ...saved.camera };
        patch.measurements = Array.isArray(saved.measurements) ? saved.measurements : [];
        patch.clearanceThreshold =
          typeof saved.clearanceThreshold === 'number' ? saved.clearanceThreshold : 1;
      }
      // 恢复棚选择；无存档时默认第一个棚
      const savedStage = saved?.currentStageId;
      patch.currentStageId = stages.some((s) => s.id === savedStage)
        ? (savedStage as string)
        : (stages[0]?.id ?? null);
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
            set({
              setPlan: plan,
              planScene: planScene && plan.plans[planScene] ? planScene : first,
              showSetPlan: true,
            });
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
      // 方案列表：与场次关联，供左侧方案管理使用
      await get().refreshPlans();
    } catch {
      set({ serverState: 'offline' });
    }
  },

  refreshPlans: async () => {
    try {
      const res = await apiFetch('/api/scenes');
      if (!res.ok) return;
      const json = await res.json();
      set({
        plans: (json?.data ?? []) as PlanMeta[],
        planName: typeof json?.current === 'string' ? json.current : get().planName,
      });
    } catch {
      /* 后端不可达时保留现有列表 */
    }
  },

  loadCurrentScene: async () => {
    try {
      const res = await apiFetch('/api/scene');
      if (!res.ok) return;
      const json = await res.json();
      const saved = json?.data as Partial<Scenario> | null;
      if (!saved || !Array.isArray(saved.assets)) return;
      set({
        assets: saved.assets,
        camera: { ...DEMO_SHOT, ...saved.camera },
        measurements: Array.isArray(saved.measurements) ? saved.measurements : [],
        clearanceThreshold:
          typeof saved.clearanceThreshold === 'number' ? saved.clearanceThreshold : 1,
        currentStageId: saved.currentStageId ?? get().currentStageId,
        sceneKey: saved.sceneKey ?? null,
        selectedId: null,
        pendingPoint: null,
        activeShotId: null,
        activeShotUsedIds: null,
        playing: false,
        followPreviz: false,
        mode: 'orbit',
      });
    } catch {
      /* 后端不可达时保留当前数据 */
    }
  },

  createPlan: async (scene) => {
    try {
      const res = await apiFetch('/api/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) return json?.message ?? '新建方案失败';
      await get().loadCurrentScene();
      await get().refreshPlans();
      return null;
    } catch {
      return '新建方案失败：后端不可达';
    }
  },

  switchPlan: async (name) => {
    try {
      const res = await apiFetch('/api/scenes/current', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        return json?.message ?? '切换方案失败';
      }
      await get().loadCurrentScene();
      await get().refreshPlans();
      return null;
    } catch {
      return '切换方案失败：后端不可达';
    }
  },

  deletePlan: async (name) => {
    try {
      const res = await apiFetch(`/api/scenes/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        return json?.message ?? '删除方案失败';
      }
      await get().loadCurrentScene();
      await get().refreshPlans();
      return null;
    } catch {
      return '删除方案失败：后端不可达';
    }
  },

  selectShot: (shotId) => {
    const { previz, assets } = get();
    if (!shotId) {
      set({
        activeShotId: null,
        activeShotUsedIds: null,
        playing: false,
        followPreviz: false,
      });
      return;
    }
    const shot = previz?.shots.find((s) => s.id === shotId);
    if (!shot) return;
    // 本镜头用到的元素：24 帧采样视锥并集，其余元素不渲染。
    // 只做元素剔除，不改机位/操作模式，环屏与场景操作保持可用。
    const ids = usedAssetIds(buildBoxes(assets), shot);
    set({
      activeShotId: shot.id,
      activeShotUsedIds: ids,
      timelineTime: shot.start,
      playing: false,
      followPreviz: false,
    });
  },

  toggleTake: () => set((state) => ({ takeVisible: !state.takeVisible })),

  toggleAerialView: () =>
    set((state) => ({
      aerialView: !state.aerialView,
      // 高空视角不跟随镜头，且必须处于自由视角才能操作相机
      followPreviz: false,
      mode: state.aerialView ? state.mode : 'orbit',
    })),

  toggleAimMode: () =>
    set((state) => ({ aimMode: state.aimMode === 'raw' ? 'led' : 'raw' })),

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
      const data = json?.data as { assets?: SceneAsset[]; stageId?: string } | null;
      if (!data || !Array.isArray(data.assets) || data.assets.length === 0) {
        return 'UE 场景数据为空，请先在 UE 中打开祈祷室关卡后重新采集';
      }
      const { stages, currentStageId } = get();
      const stageId =
        data.stageId && stages.some((s) => s.id === data.stageId) ? data.stageId : currentStageId;
      set({
        assets: data.assets,
        currentStageId: stageId,
        selectedId: null,
        measurements: [],
        pendingPoint: null,
        activeShotId: null,
        activeShotUsedIds: null,
        mode: 'orbit',
      });
      return null;
    } catch {
      return '导入失败：后端不可达';
    }
  },

  setStage: (id) => set({ currentStageId: id }),

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
      const { planScene } = get();
      const next = planScene && data.plans[planScene] ? planScene : scenes[0];
      set({ setPlan: data, planScene: next, showSetPlan: true });
      return null;
    } catch {
      return '布景方案加载失败：后端不可达';
    }
  },

  setPlanScene: (scene) => set({ planScene: scene }),

  toggleSetPlan: () => set((state) => ({ showSetPlan: !state.showSetPlan })),

  updateAsset: (id, patch) =>
    set((state) => ({
      assets: state.assets.map((a) => (a.instanceId === id ? { ...a, ...patch } : a)),
    })),

  setAssetVisibility: (ids, visible) => {
    const targets = new Set(ids);
    set((state) => ({
      assets: state.assets.map((a) => (targets.has(a.instanceId) ? { ...a, visible } : a)),
    }));
  },

  removeAsset: (id) =>
    set((state) => ({
      assets: state.assets.filter((a) => a.instanceId !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
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
    const { camera, assets, measurements, clearanceThreshold, currentStageId, sceneKey } = get();
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      currentStageId,
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
        selectedId: null,
        pendingPoint: null,
        activeShotId: null,
        activeShotUsedIds: null,
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
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useScene.subscribe((state, prev) => {
  if (!hydrated) return;
  if (
    state.assets === prev.assets &&
    state.camera === prev.camera &&
    state.measurements === prev.measurements &&
    state.clearanceThreshold === prev.clearanceThreshold &&
    state.currentStageId === prev.currentStageId &&
    state.sceneKey === prev.sceneKey
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const { camera, assets, measurements, clearanceThreshold, currentStageId, sceneKey } =
      useScene.getState();
    apiFetch('/api/scene', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        currentStageId,
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
