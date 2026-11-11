import { useScene } from '../store/sceneStore';
import { Panel } from './ui';

/**
 * 右侧「AI分析」tab：展示方案调整对其他镜头的影响检查结果。
 * 检查由视口中的「确定」按钮触发（规则引擎：视线遮挡 / 地台外穿帮）。
 */
export function AnalysisPanel() {
  const impact = useScene((s) => s.impact);
  const previz = useScene((s) => s.previz);
  const runImpactCheck = useScene((s) => s.runImpactCheck);
  const selectShot = useScene((s) => s.selectShot);

  const result = impact.result;
  const shotCatalog = useScene((s) => s.shotCatalog);
  /** 镜头显示名：与左侧镜头库一致，优先场记短名，无清单数据时退回全名去尾缀 */
  const nameOf = (shotId: string) => {
    const shot = previz?.shots.find((s) => s.id === shotId);
    if (!shot) return shotId;
    const entry = shotCatalog?.find((e) => e.key === shot.name);
    return entry?.short ?? shot.name.replace(/_[A-Za-z]$/, '');
  };

  return (
    <Panel title="AI 影响分析">
      <div className="ai-panel">
        {/* 状态区：未检查 / 检查中 / 已完成 */}
        {!result && !impact.running && (
          <div className="ai-empty">
            <p className="empty">
              调整方案内容（移动环屏、缩放地台、增改模型）后，点击视口中的「确定」按钮，
              AI 将检查当前方案在其他镜头中的影响（遮挡穿帮、地台外穿帮等）。
            </p>
            <button className="ai-rerun" onClick={() => runImpactCheck()}>
              立即检查
            </button>
          </div>
        )}
        {impact.running && <p className="ai-running">AI 影响检查中…</p>}

        {result && !impact.running && (
          <>
            <p className="ai-summary">
              {result.issueShots.length === 0 ? (
                <>已检查 <b>{result.shotCount}</b> 个镜头，<span className="ok">未发现穿帮风险</span>，本次调整对其他镜头无影响。</>
              ) : (
                <>已检查 <b>{result.shotCount}</b> 个镜头，<span className="warn-text">
                  {result.issueShots.length} 个镜头存在异常</span>，共 {result.issueShots.reduce((n, s) => n + s.issues.length, 0)} 个问题。</>
              )}
            </p>
            <button className="ai-rerun" onClick={() => runImpactCheck()}>
              重新检查
            </button>
            {result.issueShots.map(({ shotId, issues }) => (
              <div key={shotId} className="ai-shot-card">
                <button
                  className="ai-shot-name"
                  title="点击在 3D 视口取景查看"
                  onClick={() => selectShot(shotId)}
                >
                  {nameOf(shotId)}
                </button>
                <ul className="ai-issue-list">
                  {issues.map((issue, i) => (
                    <li key={i} className={`ai-issue ${issue.severity}`}>
                      <span className="ai-issue-badge">
                        {issue.severity === 'high' ? '高' : '中'}
                      </span>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
    </Panel>
  );
}
