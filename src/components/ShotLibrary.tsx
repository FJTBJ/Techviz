import { useMemo, useState } from 'react';
import { computeShotUsage } from '../lib/shotFilter';
import { shotLabel } from '../lib/previz';
import { useScene } from '../store/sceneStore';
import { Panel } from './ui';

/**
 * 左侧栏：方案管理 + 镜头库。
 * 一个场次场景对应一个方案；镜头库首项是「完整场景」，
 * 其余镜头点击后只展示该镜头视锥内用到的 UE 元素。
 */
export function ShotLibrary() {
  const plans = useScene((s) => s.plans);
  const planName = useScene((s) => s.planName);
  const sceneKey = useScene((s) => s.sceneKey);
  const previz = useScene((s) => s.previz);
  const assets = useScene((s) => s.assets);
  const activeShotId = useScene((s) => s.activeShotId);
  const selectShot = useScene((s) => s.selectShot);
  const createPlan = useScene((s) => s.createPlan);
  const switchPlan = useScene((s) => s.switchPlan);
  const deletePlan = useScene((s) => s.deletePlan);
  const revisions = useScene((s) => s.revisions);
  const loadRevisions = useScene((s) => s.loadRevisions);
  const restoreRevision = useScene((s) => s.restoreRevision);

  const [newScene, setNewScene] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const sceneList = previz?.scenes ?? [];
  /** 已被方案占用的场次不再列出（一个场次只建一个方案） */
  const availableScenes = sceneList.filter((item) => !plans.some((plan) => plan.scene === item.scene));

  const shots = useMemo(() => {
    if (!previz) return [];
    return sceneKey ? previz.shots.filter((shot) => shot.scene === sceneKey) : previz.shots;
  }, [previz, sceneKey]);

  const usage = useMemo(() => computeShotUsage(assets, shots), [assets, shots]);

  const run = async (task: () => Promise<string | null>, ok: string) => {
    setBusy(true);
    const error = await task();
    setBusy(false);
    setMsg(error ?? ok);
    setTimeout(() => setMsg(null), 2600);
  };

  return (
    <aside className="sidebar">
      <Panel title="方案管理" extra={<span className="count">{plans.length}</span>}>
        {plans.length > 0 ? (
          <label className="field">
            <span>当前方案{sceneKey ? ` · 场次 ${sceneKey}` : ' · 未关联场次'}</span>
            <div className="input-wrap">
              <select
                value={planName ?? ''}
                disabled={busy}
                onChange={(e) => void run(() => switchPlan(e.target.value), '已切换方案')}
              >
                {plans.map((plan) => (
                  <option key={plan.name} value={plan.name}>
                    {plan.name}
                    {plan.scene ? ` · ${plan.scene}` : ''}
                  </option>
                ))}
              </select>
            </div>
          </label>
        ) : (
          <p className="hint">后端未返回方案列表</p>
        )}

        {availableScenes.length > 0 && (
          <div className="plan-new">
            <select
              value={newScene}
              disabled={busy}
              onChange={(e) => setNewScene(e.target.value)}
              title="选择要关联的场次"
            >
              <option value="">选择场次…</option>
              {availableScenes.map((item) => (
                <option key={item.scene} value={item.scene}>
                  {item.scene} · {item.shotCount} 镜
                </option>
              ))}
            </select>
            <button
              className="btn tiny"
              disabled={busy || !newScene}
              onClick={() => void run(() => createPlan(newScene), '已新建方案')}
            >
              新建
            </button>
          </div>
        )}

        <button
          className="btn ghost block"
          disabled={busy || plans.length <= 1 || !planName}
          onClick={() => planName && void run(() => deletePlan(planName), '已删除方案')}
        >
          删除当前方案
        </button>

        <button
          className="btn ghost block"
          disabled={busy}
          onClick={() => {
            const next = !historyOpen;
            setHistoryOpen(next);
            if (next) void loadRevisions();
          }}
        >
          {historyOpen ? '收起历史版本' : `历史版本 · ${revisions.length}`}
        </button>

        {historyOpen && (
          <div className="revision-list">
            {revisions.length === 0 ? (
              <p className="hint">暂无历史版本，改动后会自动生成</p>
            ) : (
              revisions.map((rev) => (
                <div className="revision-row" key={rev.id}>
                  <span className="revision-time">
                    {new Date(rev.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </span>
                  <span className="hint">{Math.max(1, Math.round(rev.size / 1024))} KB</span>
                  <button
                    className="btn tiny"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm('恢复到该版本？当前状态会先存为一条历史版本。')) return;
                      void run(() => restoreRevision(rev.id), '已恢复到该版本');
                    }}
                  >
                    恢复
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {msg && <p className={msg.startsWith('已') ? 'ok' : 'alert'}>{msg}</p>}
        <p className="hint">一个场次对应一个方案，新方案复制当前布景数据。</p>
      </Panel>

      <Panel title="镜头库" extra={<span className="count">{shots.length}</span>}>
        <div className="shot-list">
          <button
            className={`shot-card complete ${activeShotId ? '' : 'active'}`}
            onClick={() => selectShot(null)}
            title="显示场景全部元素"
          >
            <span className="shot-index">全</span>
            <span className="shot-meta">
              <strong>完整场景</strong>
              <em>{assets.length} 个元素 · 全部显示</em>
            </span>
            {!activeShotId && <span className="shot-state">当前</span>}
          </button>

          {shots.map((shot, index) => {
            const used = usage[shot.id]?.count ?? 0;
            const active = activeShotId === shot.id;
            return (
              <button
                key={shot.id}
                className={`shot-card ${active ? 'active' : ''}`}
                onClick={() => selectShot(shot.id)}
                title={`${shot.id} · 入点 ${shot.start.toFixed(2)}s`}
              >
                <span className="shot-index mono">{String(index + 1).padStart(2, '0')}</span>
                <span className="shot-meta">
                  <strong>{shotLabel(shot)}</strong>
                  <em>
                    {shot.durationSec.toFixed(1)}s · 用到 {used} / {assets.length}
                  </em>
                </span>
                <span className="shot-used mono">
                  {Math.round((used / Math.max(1, assets.length)) * 100)}%
                </span>
              </button>
            );
          })}
        </div>

        {!previz && <p className="empty">后端无预演时间线数据</p>}
        {previz && shots.length === 0 && <p className="empty">该场次没有镜头</p>}
        <p className="hint">
          点击镜头：只渲染该镜头视锥内用到的 UE 元素；环屏与视角操作不受影响。
        </p>
      </Panel>
    </aside>
  );
}
