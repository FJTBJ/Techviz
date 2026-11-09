import { useEffect, useMemo, useState } from 'react';
import { useScene } from '../store/sceneStore';
import { apiFetch } from '../lib/api';
import { Panel } from './ui';
import type { PrevizShot, ShotCatalogEntry } from '../types';

/** 场次码排序：s2 < s10 < s079a < s079b（数字优先，后缀其次） */
function sceneCodeRank(code: string): [number, string] {
  const m = /^s(\d+)([a-z]?)$/.exec(code);
  if (!m) return [Number.MAX_SAFE_INTEGER, code];
  return [Number(m[1]), m[2]];
}

/**
 * 左侧栏：方案库（上下两栏）。
 * 上栏 = 方案列表：全部场次的置景方案（planList），点击方案即在中间视口预览
 * 该方案内容（内容位姿自动应用，置景按方案实例集显示）；
 * 下栏 = 选中方案涉及的镜头列表，点击镜头在视口取景 / 播放 take。
 * 只读展示，不含任何编辑功能。
 */
export function ShotLibrary() {
  const setPlan = useScene((s) => s.setPlan);
  const activePlanId = useScene((s) => s.activePlanId);
  const selectPlan = useScene((s) => s.selectPlan);
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const selectShot = useScene((s) => s.selectShot);
  // AI 影响检查结果：异常镜头在列表中显示 ⚠ 提醒
  const impactResult = useScene((s) => s.impact.result);
  const warnShotIds = useMemo(
    () => new Set(impactResult?.issueShots.map((item) => item.shotId) ?? []),
    [impactResult],
  );
  // 空态（尚无方案）：左侧改为全量镜头列表
  const planLibraryMode = useScene((s) => s.planLibraryMode);
  const shotCatalog = useScene((s) => s.shotCatalog);
  const activeNoDataShot = useScene((s) => s.activeNoDataShot);
  const selectNoDataShot = useScene((s) => s.selectNoDataShot);
  // 镜头 AI 分类（shot-classifications.json，kmoke4 拉取）：镜头卡片分类标签
  const [classifications, setClassifications] = useState<
    Record<string, { category?: string; scene_setting?: string; floor?: string }>
  >({});
  // 标签筛选：选中的标签（多选，镜头需同时命中全部所选标签）
  const [activeTags, setActiveTags] = useState<string[]>([]);
  // 「添加镜头」：把方案覆盖外的镜头临时加入列表（查看其他镜头使用该方案的效果），切方案清空
  const [addedShotIds, setAddedShotIds] = useState<string[]>([]);
  // 下拉暂存选中项，点「添加」确认后才加入列表
  const [pickShotId, setPickShotId] = useState('');
  useEffect(() => {
    setAddedShotIds([]);
    setPickShotId('');
  }, [activePlanId]);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/shot-classifications')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data) setClassifications(json.data.shots ?? {});
      })
      .catch(() => {
        /* 分类数据缺失时标签按「无交互」补齐 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 全部方案（跨场次）按场次码排序 */
  const planRows = useMemo(() => {
    const rows: {
      planId: string;
      label: string;
      scene: string;
      coveredCount: number;
      setCount: number;
      rotationDeg: number;
    }[] = [];
    for (const [scene, entry] of Object.entries(setPlan?.plans ?? {})) {
      for (const p of entry.planList ?? []) {
        rows.push({
          planId: p.planId,
          label: p.label,
          scene,
          coveredCount: p.coveredCount,
          setCount: p.setInstanceIds.length,
          rotationDeg: p.rotationDeg ?? 0,
        });
      }
    }
    return rows.sort((a, b) => {
      const [na, sa] = sceneCodeRank(a.scene);
      const [nb, sb] = sceneCodeRank(b.scene);
      return na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0) || a.planId.localeCompare(b.planId);
    });
  }, [setPlan]);

  /** 选中方案条目与其镜头（含每镜缩略图元数据） */
  const activePlan = useMemo(() => {
    if (!activePlanId || !setPlan) return null;
    for (const [scene, entry] of Object.entries(setPlan.plans)) {
      const hit = entry.planList?.find((p) => p.planId === activePlanId);
      if (hit) return { scene, plan: hit };
    }
    return null;
  }, [activePlanId, setPlan]);

  /** 镜头 id → 预演镜头（含 short/duration 由 shotCatalog 提供缩略图等） */
  const rigById = useMemo(() => {
    const map = new Map<string, PrevizShot>();
    for (const s of previz?.shots ?? []) map.set(s.id, s);
    return map;
  }, [previz]);

  const planShots = useMemo(() => {
    if (!activePlan) return [];
    return activePlan.plan.coveredShotIds
      .map((id) => rigById.get(id))
      .filter((s): s is PrevizShot => Boolean(s));
  }, [activePlan, rigById]);

  const pendingShots = useMemo(() => {
    if (!activePlan) return [];
    return (setPlan?.plans[activePlan.scene].pendingShotIds ?? [])
      .map((id) => rigById.get(id))
      .filter((s): s is PrevizShot => Boolean(s));
  }, [activePlan, rigById, setPlan]);

  /** 方案镜头按场次分组（场次码数字优先排序），先按标签筛选 */
  const planShotGroups = useMemo(() => {
    const filtered = planShots.filter((shot) => {
      if (activeTags.length === 0) return true;
      const labels = new Set(
        shotTags(catalogKeyOf(shot), classifications).map(([label]) => label),
      );
      return activeTags.every((t) => labels.has(t));
    });
    const map = new Map<string, PrevizShot[]>();
    for (const shot of filtered) {
      const key = shot.scene ?? '其他';
      const list = map.get(key);
      if (list) list.push(shot);
      else map.set(key, [shot]);
    }
    return [...map.entries()].sort((a, b) => {
      const [na, sa] = sceneCodeRank(a[0]);
      const [nb, sb] = sceneCodeRank(b[0]);
      return na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
    });
  }, [planShots, activeTags, classifications]);

  /** 可添加镜头：方案未覆盖且未添加过的预演镜头 */
  const coveredIds = useMemo(() => new Set(activePlan?.plan.coveredShotIds ?? []), [activePlan]);
  const addableShots = useMemo(
    () =>
      (previz?.shots ?? [])
        .filter((s) => !coveredIds.has(s.id) && !addedShotIds.includes(s.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [previz, coveredIds, addedShotIds],
  );
  /** 已添加镜头（以当前方案位姿预览） */
  const addedShots = useMemo(
    () => addedShotIds.map((id) => rigById.get(id)).filter((s): s is PrevizShot => Boolean(s)),
    [addedShotIds, rigById],
  );

  const totalPlans = planRows.length;

  /** 空态：全量镜头按场次分组（含无 3D 机位数据的镜头），数据来自场记 shot-names */
  const emptyGroups = useMemo(() => {
    const map = new Map<string, ShotCatalogEntry[]>();
    for (const entry of shotCatalog ?? []) {
      const key = entry.scene ?? '其他';
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()].sort((a, b) => {
      const [na, sa] = sceneCodeRank(a[0]);
      const [nb, sb] = sceneCodeRank(b[0]);
      return na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
    });
  }, [shotCatalog]);

  /** 空态点击镜头：有 3D 机位的走视口取景，无机位的走 take 播放 + 占位；再点一次取消选中 */
  const pickCatalogShot = (entry: ShotCatalogEntry) => {
    if (entry.hasRig) {
      const shot = useScene.getState().previz?.shots.find((s) => s.name === entry.key);
      if (!shot) return;
      if (activeShotId === shot.id) selectShot(null);
      else selectShot(shot.id);
      return;
    }
    selectNoDataShot(activeNoDataShot?.key === entry.key ? null : entry);
  };

  // 尚无任何方案：左侧全量镜头列表，中间视口显示「生成 Techviz 方案」按钮（见 Viewport）
  if (planLibraryMode === 'empty') {
    return (
      <aside className="sidebar">
        <Panel title="镜头列表" extra={<span className="count">{shotCatalog?.length ?? 0}</span>}>
          <div className="empty-shot-list">
            {emptyGroups.length === 0 ? (
              <p className="empty">暂无镜头数据</p>
            ) : (
              emptyGroups.map(([scene, entries]) => (
                <div className="empty-shot-group" key={scene}>
                  <p className="empty-shot-group-title">
                    {scene}
                    <span className="count">{entries.length}</span>
                  </p>
                  {entries.map((entry) => {
                    const active =
                      activeNoDataShot?.key === entry.key ||
                      (entry.hasRig &&
                        activeShotId !== null &&
                        rigById.get(activeShotId)?.name === entry.key);
                    return (
                      <button
                        key={entry.key}
                        className={`shot-card ${active ? 'active' : ''}`}
                        onClick={() => pickCatalogShot(entry)}
                        title={`${entry.key} · 点击在 3D 视口取景`}
                      >
                        {entry.thumbnailUrl ? (
                          <img
                            className="shot-thumb"
                            src={entry.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              e.currentTarget.style.visibility = 'hidden';
                            }}
                          />
                        ) : (
                          <span className="shot-index mono">{entry.short}</span>
                        )}
                        <span className="shot-meta">
                          <strong>{entry.short}</strong>
                          {!entry.hasRig && <em>无 3D 机位数据</em>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </Panel>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <Panel title="方案库" extra={<span className="count">{totalPlans}</span>}>
        <div className="plan-library">
          {/* 上半：方案列表 */}
          <div className="plan-list-scroll">
            {!setPlan ? (
              <p className="empty">后端无方案数据</p>
            ) : totalPlans === 0 ? (
              <p className="empty">尚无置景方案，先运行方案生成</p>
            ) : (
              planRows.map((row) => (
                <button
                  key={row.planId}
                  className={`plan-card ${activePlanId === row.planId ? 'active' : ''}`}
                  onClick={() => selectPlan(row.planId)}
                  title={`${row.label} · 覆盖 ${row.coveredCount} 镜`}
                >
                  <span className="plan-meta">
                    <strong>{row.label}</strong>
                    <em>镜头数 {row.coveredCount}</em>
                  </span>
                </button>
              ))
            )}
          </div>

          {/* 下半：选中方案涉及的镜头列表 */}
          <div className="plan-shots">
            <p className="plan-shots-title">
              {activePlan ? '本方案镜头' : '方案镜头'}
              <span className="count">{planShots.length}</span>
            </p>
            {!activePlan ? (
              <p className="empty">点击上方方案查看涉及镜头</p>
            ) : (
              <>
                {/* 标签筛选：点选标签，只显示同时命中全部所选标签的镜头 */}
                <div className="tag-filter">
                  {ALL_TAGS.map((t) => (
                    <button
                      key={t}
                      className={`tag-chip ${activeTags.includes(t) ? 'active' : ''}`}
                      onClick={() =>
                        setActiveTags((ts) =>
                          ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t],
                        )
                      }
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {/* 添加镜头：下拉选择 + 点「添加」确认，加入列表以当前方案位姿预览 */}
                {addableShots.length > 0 && (
                  <div className="shot-add-row">
                    <select
                      value={pickShotId}
                      onChange={(e) => setPickShotId(e.target.value)}
                    >
                      <option value="">＋ 添加镜头…</option>
                      {addableShots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {shortOf(s.name)}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={!pickShotId}
                      onClick={() => {
                        if (!pickShotId) return;
                        setAddedShotIds((ids) =>
                          ids.includes(pickShotId) ? ids : [...ids, pickShotId],
                        );
                        setPickShotId('');
                      }}
                    >
                      添加
                    </button>
                  </div>
                )}
                <div className="plan-shot-scroll">
                {planShotGroups.map(([scene, list]) => (
                  <div className="plan-shot-group" key={scene}>
                    <p className="plan-shot-group-title">
                      {scene}
                      <span className="count">{list.length}</span>
                    </p>
                    {list.map((shot) => {
                      const entry = shotCatalogEntry(shot);
                      const tags = shotTags(catalogKeyOf(shot), classifications);
                      return (
                        <button
                          key={shot.id}
                          className={`shot-card stacked ${activeShotId === shot.id ? 'active' : ''}`}
                          onClick={() =>
                            activeShotId === shot.id ? selectShot(null) : selectShot(shot.id)
                          }
                          title={`${shot.name} · 点击在 3D 视口取景，再点一次取消选中`}
                        >
                          <span className="shot-main">
                            {entry?.thumbnailUrl ? (
                              <img
                                className="shot-thumb"
                                src={entry.thumbnailUrl}
                                alt=""
                                loading="lazy"
                                onError={(e) => {
                                  e.currentTarget.style.visibility = 'hidden';
                                }}
                              />
                            ) : (
                              <span className="shot-index mono">{displayName(shot)}</span>
                            )}
                            <span className="shot-meta">
                              <strong>{displayName(shot)}</strong>
                              {warnShotIds.has(shot.id) && (
                                <span
                                  className="shot-warn"
                                  title="AI 检查：本镜头可能穿帮，详见「AI分析」"
                                >
                                  ⚠
                                </span>
                              )}
                            </span>
                          </span>
                          <span className="shot-tags">
                            {tags.map(([label, cls]) => (
                              <span key={label} className={`shot-tag ${cls}`}>
                                {label}
                              </span>
                            ))}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {/* 已添加镜头：以当前方案位姿预览，可移除 */}
                {addedShots.length > 0 && (
                  <div className="plan-shot-group">
                    <p className="plan-shot-group-title">
                      已添加镜头<span className="count">{addedShots.length}</span>
                    </p>
                    {addedShots.map((shot) => {
                      const entry = shotCatalogEntry(shot);
                      const tags = shotTags(catalogKeyOf(shot), classifications);
                      return (
                        <button
                          key={shot.id}
                          className={`shot-card stacked ${activeShotId === shot.id ? 'active' : ''}`}
                          onClick={() =>
                            activeShotId === shot.id ? selectShot(null) : selectShot(shot.id)
                          }
                          title={`${shot.name} · 以当前方案位姿预览，再点一次取消选中`}
                        >
                          <span className="shot-main">
                            {entry?.thumbnailUrl ? (
                              <img
                                className="shot-thumb"
                                src={entry.thumbnailUrl}
                                alt=""
                                loading="lazy"
                                onError={(e) => {
                                  e.currentTarget.style.visibility = 'hidden';
                                }}
                              />
                            ) : (
                              <span className="shot-index mono">{displayName(shot)}</span>
                            )}
                            <span className="shot-meta">
                              <strong>{displayName(shot)}</strong>
                              {warnShotIds.has(shot.id) && (
                                <span
                                  className="shot-warn"
                                  title="AI 检查：本镜头可能穿帮，详见「AI分析」"
                                >
                                  ⚠
                                </span>
                              )}
                            </span>
                          </span>
                          <span className="shot-tags">
                            {tags.map(([label, cls]) => (
                              <span key={label} className={`shot-tag ${cls}`}>
                                {label}
                              </span>
                            ))}
                            <span
                              className="shot-tag remove"
                              title="从列表移除"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAddedShotIds((ids) => ids.filter((x) => x !== shot.id));
                              }}
                            >
                              ✕ 移除
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {pendingShots.length > 0 && (
                  <>
                    <p className="plan-shots-title warn-text">
                      未覆盖镜头<span className="count">{pendingShots.length}</span>
                    </p>
                    {pendingShots.map((shot) => (
                      <div key={shot.id} className="shot-card pending" title="无可行内容位姿，未纳入任何方案">
                        <span className="shot-meta">
                          <strong>{displayName(shot)}</strong>
                          <em>未覆盖</em>
                        </span>
                      </div>
                    ))}
                  </>
                )}
                </div>
              </>
            )}
          </div>
        </div>
      </Panel>
    </aside>
  );
}

/** 镜头显示短名：s001_c025_A → s001_c025 */
function shortOf(name: string): string {
  return name.replace(/_[A-Za-z]$/, '');
}

/** 镜头显示名：优先场记短名（s001_c005_A），无清单数据时退回 take 名去尾缀 */
function displayName(shot: PrevizShot): string {
  return shotCatalogEntry(shot)?.short ?? shortOf(shot.name);
}

/** 分类标签全集（筛选条按此顺序展示） */
const ALL_TAGS = ['机械臂', '有交互', '无交互', '需置景', '有置景', '无置景', '有地板', '无地板'];

/** 分类数据的键：场记短名（s015_c005_A），与 shot-classifications.json 一致 */
function catalogKeyOf(shot: PrevizShot): string {
  return shotCatalogEntry(shot)?.short ?? shot.name;
}

/**
 * 镜头三维度标签：机械臂/有交互/无交互 + 需/有/无置景 + 有/无地板。
 * 无分类结论的镜头按「无交互 / 需置景 / 有地板」补齐（与方案引擎保守默认一致）。
 */
function shotTags(
  base: string,
  cls: Record<string, { category?: string; scene_setting?: string; floor?: string }>,
): [string, string][] {
  const c = cls[base] ?? {};
  const cat = c.category ?? 'no_interaction';
  const setting = c.scene_setting ?? 'need_set';
  const floor = c.floor ?? 'has_floor';
  return [
    [cat === 'robot_arm' ? '机械臂' : cat === 'interaction' ? '有交互' : '无交互', `cat-${cat}`],
    [
      setting === 'need_set' ? '需置景' : setting === 'has_set' ? '有置景' : '无置景',
      `set-${setting}`,
    ],
    [floor === 'has_floor' ? '有地板' : '无地板', `floor-${floor}`],
  ];
}

/** 从 store 快照清单里取镜头缩略图条目（避免直接订阅全表触发重渲染） */
function shotCatalogEntry(shot: PrevizShot) {
  const st = useScene.getState();
  return st.shotCatalog?.find((e) => e.key === shot.name) ?? null;
}
