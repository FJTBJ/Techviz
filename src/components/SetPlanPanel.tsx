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
  const showShotMarkers = useScene((s) => s.showShotMarkers);
  const toggleShotMarkers = useScene((s) => s.toggleShotMarkers);
  const loadSetPlan = useScene((s) => s.loadSetPlan);
  const setPlanScene = useScene((s) => s.setPlanScene);
  const toggleSetPlan = useScene((s) => s.toggleSetPlan);
  const shotAim = useScene((s) => s.shotAim);
  const setStagePosition = useScene((s) => s.setStagePosition);
  const setOffset = useScene((s) => s.setOffset);
  const setSetOffset = useScene((s) => s.setSetOffset);
  const setStageRotationY = useScene((s) => s.setStageRotationY);
  const applySetAssetFilter = useScene((s) => s.applySetAssetFilter);
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
        <div className="panel-actions">
          <button
            className={`btn tiny ${showShotMarkers ? 'active' : ''}`}
            onClick={toggleShotMarkers}
            disabled={!current}
            title="黄色菱形 = 每个镜头的首帧机位；一键隐藏/显示"
          >
            {showShotMarkers ? '隐藏机位点' : '显示机位点'}
          </button>
          <button className={`btn tiny ${showSetPlan ? 'active' : ''}`} onClick={toggleSetPlan} disabled={!current}>
            {showSetPlan ? '隐藏体块' : '显示体块'}
          </button>
        </div>
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

          {current.stagePosition && (
            <>
              <h3 className="sub-head">推荐置景摆放</h3>
              <p className="setplan-meta mono" title={current.stagePosition.method}>
                置景整体平移 ({-current.stagePosition.offset[0]}, {-current.stagePosition.offset[2]})m
                {(current.stagePosition.rotationDeg ?? 0) !== 0 && ` · 绕环心旋转 ${current.stagePosition.rotationDeg}°`} ·
                演员 {current.stagePosition.actorBacked}%
                {current.stagePosition.actorBacked !== current.stagePosition.actorBackedOrigin &&
                  `（原位 ${current.stagePosition.actorBackedOrigin}%）`}
                {current.stagePosition.assetBacked != null &&
                  ` · 置景资产 ${current.stagePosition.assetBacked}%`}{' '}
                · {current.stagePosition.shotCount} 镜 {current.stagePosition.sampleCount} 采样
              </p>
              {current.setInstanceIds?.length != null && (
                <p className="setplan-meta mono">
                  置景筛选：交互资产 {current.setInstanceIds.length} 件默认显示，其余默认隐藏
                </p>
              )}
              {current.planList && current.planList.length > 0 && (
                <div className="plan-list">
                  {current.planList.map((p) => (
                    <p key={p.planId} className="setplan-meta mono">
                      {p.label}：覆盖 {p.coveredCount} 镜 · 平移 ({-p.offset[0]}, {-p.offset[2]})m · 旋转 {p.rotationDeg}° · 置景 {p.setInstanceIds.length} 件 · 演员 {p.actorBacked}%
                    </p>
                  ))}
                  {(current.pendingShotIds?.length ?? 0) > 0 && (
                    <p className="setplan-meta mono warn-text">
                      未覆盖 {current.pendingShotIds!.length} 镜：无可行内容位姿（画面无法完整入屏），需单独处理
                    </p>
                  )}
                </div>
              )}
              <div className="panel-actions">
                <button
                  className="btn tiny"
                  onClick={() => {
                    // 1) 解算值是环心偏移；现场语义是棚固定、置景整体平移，取反作用到集合；
                    //    内容位姿 = 平移 + 绕环心旋转（KMOKE-261104 规则四），旋转同步写入
                    const o = current.stagePosition!.offset;
                    setSetOffset([-o[0], -o[1], -o[2]]);
                    setStageRotationY(current.stagePosition!.rotationDeg ?? 0);
                    setStagePosition([0, 0, 0]);
                    // 2) 置景筛选：与人物有交互的资产默认显示，其余默认隐藏
                    applySetAssetFilter();
                  }}
                  title="置景+演员+机位整体平移到推荐位置，交互置景资产默认显示、其余隐藏（环屏棚回原点；随当前方案自动保存）"
                >
                  应用摆放
                </button>
                {(setOffset[0] !== 0 || setOffset[2] !== 0) && (
                  <span className="mono dim">
                    当前摆放 ({setOffset[0]}, {setOffset[2]})
                  </span>
                )}
              </div>
            </>
          )}

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
                    <span
                      className="mono dim"
                      title={`偏航 +${row.deltaDeg}° / 俯仰 ${row.deltaPitchDeg > 0 ? '+' : ''}${row.deltaPitchDeg}°`}
                    >
                      +{row.deltaDeg}°{row.deltaPitchDeg ? `/${row.deltaPitchDeg > 0 ? '+' : ''}${row.deltaPitchDeg}°` : ''}
                    </span>
                    <span className="mono">{pct(row.after.led)}</span>
                  </div>
                ))}
              </div>
              <p className="setplan-meta mono">
                缺口固定朝机位一侧；计算后每个 take 加固定偏航 / 俯仰角，把视线摆向环屏
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
