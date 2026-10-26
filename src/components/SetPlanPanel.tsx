import { useMemo, useState } from 'react';
import { useScene } from '../store/sceneStore';
import { Panel } from './ui';

const CATEGORY_LABEL: Record<string, string> = {
  platform: '地台',
  topSkirt: '屏顶遮光',
  backing: '背景板',
};

/** 后端 coverage 已经是百分数（0–100） */
const pct = (n: number) => `${Math.round(n)}%`;

export function SetPlanPanel() {
  const setPlan = useScene((s) => s.setPlan);
  const planScene = useScene((s) => s.planScene);
  const showSetPlan = useScene((s) => s.showSetPlan);
  const loadSetPlan = useScene((s) => s.loadSetPlan);
  const setPlanScene = useScene((s) => s.setPlanScene);
  const toggleSetPlan = useScene((s) => s.toggleSetPlan);
  const shotAim = useScene((s) => s.shotAim);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const scenes = useMemo(() => (setPlan ? Object.keys(setPlan.plans) : []), [setPlan]);
  const current = planScene ? (setPlan?.plans[planScene] ?? null) : null;

  /** 本场次的机位朝向计算（计算前 / 计算后两组数据） */
  const aimShots = useMemo(
    () => (shotAim && planScene ? shotAim.shots.filter((row) => row.scene === planScene) : []),
    [shotAim, planScene],
  );

  const run = async () => {
    setBusy(true);
    const err = await loadSetPlan();
    setBusy(false);
    setMsg(err ?? '布景方案已生成');
    setTimeout(() => setMsg(null), 2600);
  };

  return (
    <Panel
      title="布景方案"
      extra={
        <button className={`btn tiny ${showSetPlan ? 'active' : ''}`} onClick={toggleSetPlan} disabled={!current}>
          {showSetPlan ? '隐藏体块' : '显示体块'}
        </button>
      }
    >
      <button className="btn ghost block" onClick={run} disabled={busy}>
        {busy ? '读取中…' : current ? '刷新布景方案' : '生成布景方案'}
      </button>

      {msg && <p className={msg.startsWith('布景方案已') ? 'ok' : 'alert'}>{msg}</p>}

      {!current && !msg && (
        <p className="empty">
          由预演相机动画 + 环屏几何自动推导布景，需后端已有预演数据（/api/setplan）
        </p>
      )}

      {scenes.length > 0 && (
        <label className="field">
          <span>场次</span>
          <div className="input-wrap">
            <select value={planScene ?? ''} onChange={(e) => setPlanScene(e.target.value)}>
              {scenes.map((scene) => (
                <option key={scene} value={scene}>
                  {scene} · {setPlan?.plans[scene]?.shots.length ?? 0} 镜
                </option>
              ))}
            </select>
          </div>
        </label>
      )}

      {current && (
        <>
          <div className="setplan-chips">
            <span className="chip">镜头 {current.summary.shotCount}</span>
            <span className="chip good">LED {pct(current.summary.led)}</span>
            <span className="chip">地面 {pct(current.summary.ground)}</span>
            <span className={`chip ${current.summary.open > 30 ? 'warn' : ''}`}>
              无覆盖 {pct(current.summary.open)}
            </span>
            <span className="chip">布景 {current.summary.setPieceCount}</span>
          </div>
          <p className="setplan-meta mono">
            环屏 {current.ring.diameter.toFixed(1)}m / 高 {current.ring.height.toFixed(1)}m /{' '}
            {current.ring.arc}° · 缺口 {current.ring.gapDeg.toFixed(0)}° · 样本{' '}
            {current.summary.rayCount}
          </p>

          <div className="divider" />

          <h3 className="sub-head">布景清单</h3>
          <div className="setplan-table">
            {current.setPieces.map((piece) => (
              <div key={piece.id} className="setplan-row piece" title={piece.rationale}>
                <span className={`dot ${piece.category}`} />
                <span className="name">
                  {piece.name}
                  <em>{CATEGORY_LABEL[piece.category] ?? piece.category}</em>
                </span>
                <span className="mono dim">
                  {piece.size.map((n) => n.toFixed(1)).join(' × ')} m
                </span>
                <span className="mono dim">关联 {piece.relatedShots.length}</span>
              </div>
            ))}
            {current.setPieces.length === 0 && <p className="empty">该场次无需实体布景</p>}
          </div>

          <h3 className="sub-head">镜头覆盖分析</h3>
          <div className="setplan-table">
            <div className="setplan-row head">
              <span>镜号</span>
              <span className="mono">焦距</span>
              <span className="mono">LED</span>
              <span className="mono">地面</span>
              <span className="mono">无覆盖</span>
            </div>
            {current.shots.map((shot) => (
              <div key={shot.id} className="setplan-row">
                <span className="name">
                  {shot.name}
                  {!shot.insideRing && <em className="warn">机位在环外</em>}
                </span>
                <span className="mono dim">{shot.focal ? `${shot.focal.toFixed(0)}mm` : '—'}</span>
                <span className="mono dim">{pct(shot.coverage.led)}</span>
                <span className="mono dim">{pct(shot.coverage.ground)}</span>
                <span className={`mono ${shot.coverage.open > 30 ? 'warn' : 'dim'}`}>
                  {pct(shot.coverage.open)}
                </span>
              </div>
            ))}
          </div>

          {aimShots.length > 0 && (
            <>
              <h3 className="sub-head">机位朝向（计算前 / 计算后）</h3>
              <div className="setplan-table">
                <div className="setplan-row aim head">
                  <span>镜号</span>
                  <span className="mono">计算前</span>
                  <span className="mono">Δ</span>
                  <span className="mono">计算后</span>
                </div>
                {aimShots.map((row) => (
                  <div
                    key={row.id}
                    className="setplan-row aim"
                    title={shotAim?.note ?? '缺口固定朝机位一侧，把视线摆向环屏'}
                  >
                    <span className="name">{row.name}</span>
                    <span className="mono dim">{pct(row.before.led)}</span>
                    <span className="mono dim">+{row.deltaDeg}°</span>
                    <span className="mono">{pct(row.after.led)}</span>
                  </div>
                ))}
              </div>
              <p className="setplan-meta mono">
                缺口固定朝机位一侧；计算后每个 take 只加固定偏航角，把视线摆向环屏
              </p>
            </>
          )}

          <p className="setplan-meta mono">
            生成于 {new Date(current.generatedAt).toLocaleString('zh-CN')}
            {current.source.note ? ` · ${current.source.note}` : ''}
          </p>
        </>
      )}
    </Panel>
  );
}
