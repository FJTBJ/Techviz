import { useEffect, useState } from 'react';
import { PROJECT_INFO } from './data/mockData';
import { useScene } from './store/sceneStore';
import { ShotLibrary } from './components/ShotLibrary';
import { Viewport } from './components/Viewport';
import { ShotPanel } from './components/ShotPanel';
import { SceneOutline } from './components/SceneOutline';
import { MeasurePanel } from './components/MeasurePanel';
import { SetPlanPanel } from './components/SetPlanPanel';
import { ExportPanel } from './components/ExportPanel';
import { Timeline } from './components/Timeline';
import { LoginView } from './components/LoginView';
import { GizmoMode, ViewMode } from './types';
import { clearAuth, getStoredUser, getToken, toAuthUser, type AuthUser } from './lib/auth';
import { setUnauthorizedHandler } from './lib/api';
import {
  fetchAuthPublicConfig,
  fetchCurrentUser,
  markExplicitLogout,
  requestLogout,
} from './lib/oidc';

/**
 * 一键把整个集合（布景 + 演员 + 机位）绕环屏中心整体转向。
 * 环屏与缺口固定不动，集合内部相对关系不变，只是换个方向对准 LED。
 */
function EnsembleTurnControl() {
  const yaw = useScene((s) => s.ensembleYaw);
  const auto = useScene((s) => s.ensembleAuto);
  const rotate = useScene((s) => s.rotateEnsemble);
  const setYaw = useScene((s) => s.setEnsembleYaw);
  const toggleAuto = useScene((s) => s.toggleEnsembleAuto);

  return (
    <div
      className="segmented subtle"
      title="整个集合绕环屏中心转向：布景 / 演员 / 机位一起转，集合内相对关系不变；环屏与缺口固定"
    >
      <button onClick={() => rotate(-15)} title="逆时针转 15°">
        ↺15°
      </button>
      <button onClick={() => setYaw(0)} title="集合朝向归零（UE 原始方位）">
        <span className="mono">{Math.round(yaw)}°</span>
      </button>
      <button onClick={() => rotate(15)} title="顺时针转 15°">
        ↻15°
      </button>
      <button
        className={auto ? 'active' : ''}
        onClick={toggleAuto}
        title={auto ? '自动：跟随当前镜头的朝环屏角度' : '手动：保留当前转向角度'}
      >
        {auto ? '自动' : '手动'}
      </button>
    </div>
  );
}

/** 棚切换器：数据来自后端扫描 UE 工程，棚固定于原点 */
function StageSwitcher() {
  const stages = useScene((s) => s.stages);
  const currentStageId = useScene((s) => s.currentStageId);
  const setStage = useScene((s) => s.setStage);
  const current = stages.find((s) => s.id === currentStageId);

  if (stages.length === 0) {
    return <span className="stage-switcher empty">未发现 UE 棚数据</span>;
  }

  return (
    <label className="stage-switcher" title={current ? `UE: ${current.uePath}` : ''}>
      <span className="stage-label">棚</span>
      <select value={currentStageId ?? ''} onChange={(e) => setStage(e.target.value)}>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {s.diameter}m / {s.arc}° / {s.panels}块
          </option>
        ))}
      </select>
    </label>
  );
}

/** UE 场景导入：把后端保存的祈祷室场景快照覆盖到当前布景 */
function UeImportButton() {
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
  { key: 'camera', label: '机位取景' },
  { key: 'measure', label: '测量' },
];

/** 顶栏用户区：显示当前登录人；需登录模式下提供退出 */
function UserBadge({
  user,
  canLogout,
  onLogout,
}: {
  user: AuthUser | null;
  canLogout: boolean;
  onLogout: () => void;
}) {
  if (!user) return null;
  return (
    <span className="user-badge" title={user.role || undefined}>
      <span className="user-name">{user.displayName}</span>
      {canLogout && (
        <button className="user-logout" onClick={onLogout}>
          退出
        </button>
      )}
    </span>
  );
}

const GIZMOS: { key: GizmoMode; label: string }[] = [
  { key: 'translate', label: '移动' },
  { key: 'rotate', label: '旋转' },
  { key: 'scale', label: '缩放' },
];

const TABS = [
  { key: 'shot', label: '机位' },
  { key: 'scene', label: '场景' },
  { key: 'setplan', label: '布景方案' },
  { key: 'measure', label: '测量' },
  { key: 'export', label: '交付' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function App() {
  const mode = useScene((s) => s.mode);
  const setMode = useScene((s) => s.setMode);
  const gizmo = useScene((s) => s.gizmo);
  const setGizmo = useScene((s) => s.setGizmo);
  const showFrustum = useScene((s) => s.showFrustum);
  const toggleFrustum = useScene((s) => s.toggleFrustum);
  const serverState = useScene((s) => s.serverState);
  const initFromServer = useScene((s) => s.initFromServer);
  const activeShotId = useScene((s) => s.activeShotId);
  const selectedId = useScene((s) => s.selectedId);
  const [tab, setTab] = useState<TabKey>('shot');
  const [sidebarHidden, setSidebarHidden] = useState(false);

  useEffect(() => {
    if (mode === 'measure') setTab('measure');
  }, [mode]);

  // 视口里点中场景元素后，右侧自动切到「场景」页，大纲会高亮并滚动到该元素
  useEffect(() => {
    if (selectedId) setTab('scene');
  }, [selectedId]);

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

  const handleLogout = async () => {
    markExplicitLogout();
    let logoutUrl: string | null = null;
    try {
      logoutUrl = await requestLogout();
    } catch (error) {
      console.warn('服务端会话注销失败，仅清理本地登录态：', error);
    }
    clearAuth();
    window.location.replace(logoutUrl || new URL('/', window.location.origin).toString());
  };

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
          <EnsembleTurnControl />
          <UeImportButton />
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

          {mode === 'orbit' && (
            <div className="segmented subtle">
              {GIZMOS.map((item) => (
                <button
                  key={item.key}
                  className={gizmo === item.key ? 'active' : ''}
                  onClick={() => setGizmo(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}

          <label className="toggle">
            <input type="checkbox" checked={showFrustum} onChange={toggleFrustum} />
            显示视锥
          </label>

          <button
            className={`sidebar-toggle ${sidebarHidden ? 'on' : ''}`}
            onClick={() => setSidebarHidden((v) => !v)}
            title={sidebarHidden ? '显示镜头库侧栏' : '隐藏镜头库侧栏'}
          >
            {sidebarHidden ? '▏▏ 侧栏' : '▕ 隐藏侧栏'}
          </button>
        </div>

        <span
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
        <span className="dept">{PROJECT_INFO.department}</span>
      </header>

      <main className={`layout ${sidebarHidden ? 'no-sidebar' : ''}`}>
        {!sidebarHidden && <ShotLibrary />}
        <Viewport />
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
            {tab === 'shot' && <ShotPanel />}
            {tab === 'scene' && <SceneOutline />}
            {tab === 'setplan' && <SetPlanPanel />}
            {tab === 'measure' && <MeasurePanel />}
            {tab === 'export' && <ExportPanel />}
          </div>
        </aside>
      </main>

      {/* 时间线只服务单个镜头；完整场景不显示 */}
      {activeShotId && <Timeline />}
    </div>
  );
}
