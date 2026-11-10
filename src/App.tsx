import { useEffect, useState } from 'react';
import { PROJECT_INFO } from './data/mockData';
import { useScene } from './store/sceneStore';
import { ShotLibrary } from './components/ShotLibrary';
import { Viewport } from './components/Viewport';
  // import { ShotPanel } from './components/ShotPanel';
import { SceneOutline } from './components/SceneOutline';
import { StudioPanel } from './components/StudioPanel';
import { AnalysisPanel } from './components/AnalysisPanel';
// 布景方案/测量面板随 tab 一并停用（恢复时取消注释）
// import { SetPlanPanel } from './components/SetPlanPanel';
// import { MeasurePanel } from './components/MeasurePanel';
// 交付面板随 tab 一并停用（恢复时取消注释）
// import { ExportPanel } from './components/ExportPanel';
import { Timeline } from './components/Timeline';
import { LoginView } from './components/LoginView';
// GizmoMode 已随 gizmo 切换一起停用（仅展示页），恢复时取消注释
// import { GizmoMode, ViewMode } from './types';
import type { ViewMode } from './types';
import { clearAuth, getStoredUser, getToken, toAuthUser, type AuthUser } from './lib/auth';
import { setUnauthorizedHandler } from './lib/api';
import {
  fetchAuthPublicConfig,
  fetchCurrentUser,
  // 仅展示页：顶栏用户徽标已隐藏，退出登录逻辑一并停用，恢复时取消注释
  // markExplicitLogout,
  // requestLogout,
} from './lib/oidc';

/**
 * 集合转向控制（EnsembleTurnControl）已移入 StudioPanel「工具」tab（绕锚点转向）。
 */

/** 棚切换器：形状参数来自后端扫描 UE 工程；「位置」拖拽模式审阅场景暂不显示（代码保留，恢复时把下方按钮块取消注释） */
function StageSwitcher() {
  const stages = useScene((s) => s.stages);
  const currentStageId = useScene((s) => s.currentStageId);
  const setStage = useScene((s) => s.setStage);
  // 仅展示页：棚悬停提示（UE 路径）已移除，恢复时加回 current 并在 label 上挂 title
  // const current = stages.find((s) => s.id === currentStageId);

  if (stages.length === 0) {
    return <span className="stage-switcher empty">未发现 UE 棚数据</span>;
  }

  return (
    <label className="stage-switcher">
      <span className="stage-label">棚</span>
      <select value={currentStageId ?? ''} onChange={(e) => setStage(e.target.value)}>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {/* <button
        className={stagePosEditing ? 'active' : ''}
        onClick={(e) => {
          e.preventDefault();
          setStagePosEditing(!stagePosEditing);
        }}
        title="进入/退出棚位置拖拽模式（视口中拖动箭头整体移动棚）"
      >
        {stagePosEditing ? '退出位置' : '位置'}
      </button> */}
    </label>
  );
}

/** UE 场景导入：把后端保存的祈祷室场景快照覆盖到当前布景 */
export function UeImportButton() {
  const importUeScene = useScene((s) => s.importUeScene);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    const err = await importUeScene();
    setBusy(false);
    setMsg(err ?? '已导入祈祷室');
    setTimeout(() => setMsg(null), 2600);
  };

  return (
    <button
      className={`ue-import ${msg ? (msg.startsWith('已导入') ? 'ok' : 'err') : ''}`}
      onClick={run}
      disabled={busy}
      title="用 UE 工程采集的祈祷室场景覆盖当前布景"
    >
      {busy ? '导入中…' : (msg ?? '导入祈祷室场景')}
    </button>
  );
}

const MODES: { key: ViewMode; label: string }[] = [
  { key: 'orbit', label: '自由视角' },
  // 「机位取景」已改为右下画中画小窗（store.camPipVisible），主视口始终自由视角；
  // mode==='camera' 的渲染逻辑保留在代码里，如需恢复主视口机位模式补回：
  // { key: 'camera', label: '机位取景' },
  // 测量模式对审阅场景暂不开放，如需恢复补回 { key: 'measure', label: '测量' }
];

/** 顶栏用户区：仅展示页已隐藏，恢复时取消注释并在 header 中挂回 <UserBadge /> */
// function UserBadge({
//   user,
//   canLogout,
//   onLogout,
// }: {
//   user: AuthUser | null;
//   canLogout: boolean;
//   onLogout: () => void;
// }) {
//   if (!user) return null;
//   return (
//     <span className="user-badge" title={user.role || undefined}>
//       <span className="user-name">{user.displayName}</span>
//       {canLogout && (
//         <button className="user-logout" onClick={onLogout}>
//           退出
//         </button>
//       )}
//     </span>
//   );
// }

// 移动/旋转/缩放 gizmo 切换审阅场景暂不显示（仅展示页），恢复时取消注释并挂回工具栏
// const GIZMOS: { key: GizmoMode; label: string }[] = [
//   { key: 'translate', label: '移动' },
//   { key: 'rotate', label: '旋转' },
//   { key: 'scale', label: '缩放' },
// ];

const TABS = [
  // 机位参数 tab 已隐藏（机位先隐藏，恢复时取消注释，并把下方默认 tab 改回 'shot'）
  // { key: 'shot', label: '机位' },
  { key: 'analysis', label: 'AI分析' },
  { key: 'scene', label: '资产' },
  { key: 'devices', label: '工具' },
  // 仅展示页：布景方案/测量/交付 tab 隐藏（方案库已移到左侧方案库面板），恢复时取消注释
  // { key: 'setplan', label: '布景方案' },
  // { key: 'measure', label: '测量' },
  // { key: 'export', label: '交付' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function App() {
  const mode = useScene((s) => s.mode);
  const setMode = useScene((s) => s.setMode);
  // gizmo 切换已隐藏（仅展示页）；gizmo 状态保留在 store，恢复时还原这两行
  // const gizmo = useScene((s) => s.gizmo);
  // const setGizmo = useScene((s) => s.setGizmo);
  const showFrustum = useScene((s) => s.showFrustum);
  const toggleFrustum = useScene((s) => s.toggleFrustum);
  // 机位取景开关按钮已隐藏，hook 暂不订阅（恢复按钮时取消注释）
  // const camPipVisible = useScene((s) => s.camPipVisible);
  // const toggleCamPip = useScene((s) => s.toggleCamPip);
  // 仅展示页：顶栏持久化状态徽标已隐藏，恢复时取消注释
  // const serverState = useScene((s) => s.serverState);
  const initFromServer = useScene((s) => s.initFromServer);
  const activeShotId = useScene((s) => s.activeShotId);
  const selectedId = useScene((s) => s.selectedId);
  // 方案库形态：empty = 尚无方案（左侧全量镜头 + 中间生成按钮），ready = 方案视图
  const planLibraryMode = useScene((s) => s.planLibraryMode);
  const [tab, setTab] = useState<TabKey>('devices');
  // 侧栏/数据面板开关按钮已隐藏（仅展示页）；状态保留供 layout 类名与渲染条件使用
  // 数据面板默认显示（inspectorHidden=false）
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [inspectorHidden] = useState(false);
  void setSidebarHidden;

  // 测量 tab 已隐藏，测量模式切换跳转随之停用（恢复时取消注释）
  // useEffect(() => {
  //   if (mode === 'measure') setTab('measure');
  // }, [mode]);

  // 视口里点中场景元素后，右侧自动切到「场景」页，大纲会高亮并滚动到该元素
  useEffect(() => {
    if (selectedId) setTab('scene');
  }, [selectedId]);

  // AI 影响检查完成后自动切到「AI分析」tab 展示结果
  const impactResult = useScene((s) => s.impact.result);
  useEffect(() => {
    if (impactResult) setTab('analysis');
  }, [impactResult]);

  // 登录态：本地缓存仅作初始值，启动时向后端校验一次
  const [auth, setAuth] = useState<{ loading: boolean; required: boolean; user: AuthUser | null }>(
    () => ({ loading: true, required: false, user: getStoredUser() }),
  );

  // 任意接口返回 401：清掉登录态并回到登录页
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuth((state) => (state.required ? { ...state, user: null } : state));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      let required = false;
      try {
        const config = await fetchAuthPublicConfig();
        required = config.login_required;
      } catch (error) {
        console.warn('读取登录配置失败，按免登录模式继续：', error);
      }
      if (cancelled) return;

      if (!required) {
        // 免登录（本地开发）模式：取后端注入的匿名用户用于展示
        let user = getStoredUser();
        try {
          const result = await fetchCurrentUser();
          user = toAuthUser(result.user_info);
        } catch {
          /* 后端不可达时保持空用户 */
        }
        if (!cancelled) setAuth({ loading: false, required: false, user });
        return;
      }

      if (getToken()) {
        try {
          const result = await fetchCurrentUser();
          if (!cancelled) {
            setAuth({ loading: false, required: true, user: toAuthUser(result.user_info) });
          }
          return;
        } catch (error) {
          console.warn('本地登录态已失效：', error);
          clearAuth();
        }
      }
      if (!cancelled) setAuth({ loading: false, required: true, user: null });
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  // 登录态就绪后才拉业务数据，避免未登录时产生大量 401
  const sessionReady = !auth.loading && (!auth.required || Boolean(auth.user));

  useEffect(() => {
    if (!sessionReady) return;
    void initFromServer();
  }, [sessionReady, initFromServer]);

  // 仅展示页：退出登录入口已隐藏，恢复时取消注释并挂回 UserBadge 的 onLogout
  // const handleLogout = async () => {
  //   markExplicitLogout();
  //   let logoutUrl: string | null = null;
  //   try {
  //     logoutUrl = await requestLogout();
  //   } catch (error) {
  //     console.warn('服务端会话注销失败，仅清理本地登录态：', error);
  //   }
  //   clearAuth();
  //   window.location.replace(logoutUrl || new URL('/', window.location.origin).toString());
  // };

  if (auth.loading) {
    return (
      <div className="login-screen">
        <div className="login-hint">正在校验登录态…</div>
      </div>
    );
  }

  if (auth.required && !auth.user) {
    return (
      <LoginView
        onAuthenticated={(info) =>
          setAuth({ loading: false, required: true, user: toAuthUser(info) })
        }
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">TECHVIZ</span>
          <span className="project">
            {PROJECT_INFO.projectName} · {PROJECT_INFO.episode}
          </span>
        </div>

        <div className="toolbar">
          <StageSwitcher />
          {/* 集合转向控制已移入 StudioPanel「工具」tab（EnsembleTurnControl，绕锚点转向） */}
          {/* UE 场景导入按钮审阅场景暂不显示，如需恢复挂回 <UeImportButton />（组件已导出） */}
          <div className="segmented">
            {MODES.map((item) => (
              <button
                key={item.key}
                className={mode === item.key ? 'active' : ''}
                onClick={() => setMode(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* 移动/旋转/缩放 gizmo 切换已隐藏（仅展示页），恢复时挂回 GIZMOS 渲染块 */}

          <label className="toggle">
            <input type="checkbox" checked={showFrustum} onChange={toggleFrustum} />
            显示视锥
          </label>

          {/* 机位取景开关已隐藏（仅展示页，右下角胶囊按钮仍可展开/收起），恢复时取消注释
          <button
            className={`sidebar-toggle ${camPipVisible ? 'on' : ''}`}
            onClick={toggleCamPip}
            title="右下角画中画：当前选中镜头的机位取景画面（可放大）"
          >
            机位取景
          </button>
          */}

          {/* 仅展示页：侧栏/数据面板开关已隐藏，恢复时取消注释
          <button
            className={`sidebar-toggle ${sidebarHidden ? 'on' : ''}`}
            onClick={() => setSidebarHidden((v) => !v)}
            title={sidebarHidden ? '显示方案库侧栏' : '隐藏方案库侧栏'}
          >
            {sidebarHidden ? '▏▏ 侧栏' : '▕ 隐藏侧栏'}
          </button>

          <button
            className={`sidebar-toggle ${!inspectorHidden ? 'on' : ''}`}
            onClick={() => setInspectorHidden((v) => !v)}
            title={inspectorHidden ? '显示右侧数据面板' : '隐藏右侧数据面板'}
          >
            数据面板
          </button>
          */}
        </div>

        {/* 仅展示页：顶栏右侧三个徽标（持久化状态/用户/部门）已隐藏，恢复时取消注释 */}
        {/* <span
          className={`server-state ${serverState}`}
          title={
            serverState === 'online'
              ? '数据自动保存到后端'
              : serverState === 'connecting'
                ? '正在连接后端'
                : '后端未连接，数据仅在本页内存'
          }
        >
          {serverState === 'online' ? '● 已持久化' : serverState === 'connecting' ? '○ 连接中' : '○ 离线'}
        </span>
        <UserBadge user={auth.user} canLogout={auth.required} onLogout={handleLogout} />
        <span className="dept">{PROJECT_INFO.department}</span> */}
      </header>

      <main
        className={`layout ${sidebarHidden ? 'no-sidebar' : ''} ${inspectorHidden ? 'no-inspector' : ''}`}
      >
        {!sidebarHidden && <ShotLibrary />}
        <Viewport />
        {/* 空态（尚无方案）只保留左侧镜头列表 + 中间生成按钮，右侧数据面板不展示 */}
        {!inspectorHidden && planLibraryMode === 'ready' && (
        <aside className="inspector">
          <div className="tabbar">
            {TABS.map((item) => (
              <button
                key={item.key}
                className={tab === item.key ? 'active' : ''}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="tab-body">
            {/* 机位参数 tab 已隐藏（机位先隐藏），恢复时与 TABS 定义一并取消注释 */}
            {/* {tab === 'shot' && <ShotPanel />} */}
            {tab === 'devices' && <StudioPanel />}
            {tab === 'analysis' && <AnalysisPanel />}
            {tab === 'scene' && <SceneOutline />}
            {/* 布景方案/测量/交付 tab 已隐藏，恢复时与 TABS 定义一并取消注释 */}
            {/* {tab === 'setplan' && <SetPlanPanel />} */}
            {/* {tab === 'measure' && <MeasurePanel />} */}
            {/* {tab === 'export' && <ExportPanel />} */}
          </div>
        </aside>
        )}
      </main>

      {/* 时间线只服务单个镜头；完整场景不显示 */}
      {activeShotId && <Timeline />}
    </div>
  );
}
