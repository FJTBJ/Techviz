import { useEffect, useState } from 'react';
import { PROJECT_INFO } from './data/mockData';
import { useScene } from './store/sceneStore';
import { AssetLibrary } from './components/AssetLibrary';
import { Viewport } from './components/Viewport';
import { ShotPanel } from './components/ShotPanel';
import { SceneOutline } from './components/SceneOutline';
import { MeasurePanel } from './components/MeasurePanel';
import { SetPlanPanel } from './components/SetPlanPanel';
import { ExportPanel } from './components/ExportPanel';
import { Timeline } from './components/Timeline';
import { GizmoMode, ViewMode } from './types';

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

/** 顶栏用户区：已登录显示用户名+退出；OIDC 模式未登录（401）时显示登录入口；后端不可达时不打扰 */
function UserBadge() {
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        if (res.ok) {
          const payload: { user?: { name?: string; role?: string } } = await res.json();
          setUser({ name: payload?.user?.name ?? '已登录', role: payload?.user?.role ?? '' });
        } else if (res.status === 401) {
          setNeedLogin(true);
        }
      })
      .catch(() => {
        /* 后端不可达时不显示登录入口 */
      });
  }, []);

  const logout = () => {
    fetch('/api/auth/logout', { method: 'POST' }).finally(() => window.location.reload());
  };

  if (needLogin) {
    return (
      <button className="user-badge login" onClick={() => (window.location.href = '/api/auth/login')}>
        登录
      </button>
    );
  }
  if (!user) return null;
  return (
    <span className="user-badge" title={user.role || undefined}>
      <span className="user-name">{user.name}</span>
      <button className="user-logout" onClick={logout}>
        退出
      </button>
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
  const [tab, setTab] = useState<TabKey>('shot');
  const [sidebarHidden, setSidebarHidden] = useState(false);

  useEffect(() => {
    if (mode === 'measure') setTab('measure');
  }, [mode]);

  // 启动即从后端恢复数据（后端从 UE 工程取棚清单）
  useEffect(() => {
    void initFromServer();
  }, [initFromServer]);

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
            title={sidebarHidden ? '显示资产库侧栏' : '隐藏资产库侧栏'}
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
        <UserBadge />
        <span className="dept">{PROJECT_INFO.department}</span>
      </header>

      <main className={`layout ${sidebarHidden ? 'no-sidebar' : ''}`}>
        {!sidebarHidden && <AssetLibrary />}
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

      <Timeline />
    </div>
  );
}
