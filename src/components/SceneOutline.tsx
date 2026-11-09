import { useEffect, useMemo, useRef, useState } from 'react';
import { useScene } from '../store/sceneStore';
import type { SceneAsset } from '../types';
import { Panel } from './ui';

/** 用 code 去掉尾部序号做分组键，便于整组显隐（CUBE / ZHUZI / SM_CHUANGHU…） */
const groupKey = (asset: SceneAsset) => {
  // 灯光单独一组，方便整组显隐
  if (asset.kind === 'light') return '灯光';
  const code = asset.code.split('.')[0];
  return code.replace(/[\d_]+$/, '') || code;
};

export function SceneOutline() {
  const assets = useScene((s) => s.assets);
  const selectedId = useScene((s) => s.selectedId);
  const selectAsset = useScene((s) => s.selectAsset);
  // 仅展示页：复制/删除等编辑功能已停用（按钮注释，恢复时一并取消注释）
  // const removeAsset = useScene((s) => s.removeAsset);
  // const duplicateAsset = useScene((s) => s.duplicateAsset);
  const setAssetVisibility = useScene((s) => s.setAssetVisibility);
  const usedIds = useScene((s) => s.activeShotUsedIds);
  const shotHiddenIds = useScene((s) => s.shotHiddenIds);
  const setShotVisibility = useScene((s) => s.setShotVisibility);
  // 棚和设备开关已拆分到 StudioPanel（独立「棚和设备」tab），恢复时取消注释下列订阅
  // const showLedRing = useScene((s) => s.showLedRing);
  // const toggleLedRing = useScene((s) => s.toggleLedRing);
  // const showGrid = useScene((s) => s.showGrid);
  // const toggleGrid = useScene((s) => s.toggleGrid);
  // const showPeople = useScene((s) => s.showPeople);
  // const togglePeople = useScene((s) => s.togglePeople);
  // const showSetPlan = useScene((s) => s.showSetPlan);
  // const toggleSetPlan = useScene((s) => s.toggleSetPlan);
  // const showShotMarkers = useScene((s) => s.showShotMarkers);
  // const toggleShotMarkers = useScene((s) => s.toggleShotMarkers);
  // const showFrustum = useScene((s) => s.showFrustum);
  // const toggleFrustum = useScene((s) => s.toggleFrustum);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** 列表筛选：全部 / 置景 / 不置景 / 本镜头置景（置景与否以当前选中方案的置景集为准） */
  // 置景筛选两级：一级「全部 / 置景」，选「置景」后二级区分「方案置景 / 镜头置景」
  const [filter, setFilter] = useState<'all' | 'set-plan' | 'set-shot'>('all');
  const listRef = useRef<HTMLDivElement | null>(null);
  // 方案置景筛选数据源：当前选中方案的置景实例集
  const activePlanId = useScene((s) => s.activePlanId);
  const setPlan = useScene((s) => s.setPlan);
  // 地台尺寸已改为 3D 视口拖拽手柄（PlatformSizer3D），列表不再放数值调节
  const togglePlanSetAsset = useScene((s) => s.togglePlanSetAsset);
  // 添加模型入口已挪到「工具」tab（StudioPanel），恢复时取消注释
  // const addPrimitive = useScene((s) => s.addPrimitive);

  /** 选中镜头时大纲只列该镜头用到的元素，和视口保持一致 */
  const shotMode = Boolean(usedIds);
  const listedAssets = useMemo(() => {
    if (!usedIds) return assets;
    const used = new Set(usedIds);
    // 方案地台不参与镜头视锥剔除，始终保留在列表里（显隐走 eye 开关）
    return assets.filter(
      (asset) => used.has(asset.instanceId) || asset.instanceId === 'platform-main',
    );
  }, [assets, usedIds]);

  const hiddenSet = useMemo(() => new Set(shotHiddenIds), [shotHiddenIds]);
  /** 列表里这一行的实际显隐：镜头模式看手工隐藏覆盖，完整场景看资产自身的 visible */
  const isHidden = (asset: SceneAsset) =>
    shotMode ? hiddenSet.has(asset.instanceId) : !asset.visible;

  const hiddenCount = listedAssets.filter(isHidden).length;

  /** 选中方案对应的置景实例集（「方案置景」筛选用） */
  const activePlanSet = useMemo(() => {
    const ids = new Set<string>();
    if (!activePlanId || !setPlan) return ids;
    for (const entry of Object.values(setPlan.plans)) {
      const hit = entry.planList?.find((p) => p.planId === activePlanId);
      if (hit) {
        for (const id of hit.setInstanceIds) ids.add(id);
        break;
      }
    }
    return ids;
  }, [activePlanId, setPlan]);

  /** 本镜头视锥用到的资产 id 集（「本镜头置景」筛选用） */
  const shotSetIds = useMemo(() => new Set(usedIds ?? []), [usedIds]);

  /** 按筛选条件过滤列表（全部 / 方案置景 / 镜头置景）。
   * 方案置景 = 该方案下所有镜头用到的置景集合（从全量资产取，不受镜头视锥过滤影响）；
   * 镜头置景 = 本镜头用到的、且已纳入方案置景集的置景（⊆ 方案置景） */
  const filteredAssets = useMemo(() => {
    if (filter === 'set-plan')
      return assets.filter((asset) => asset.kind === 'ue' && activePlanSet.has(asset.instanceId));
    if (filter === 'set-shot')
      return listedAssets.filter(
        (asset) =>
          asset.kind === 'ue' &&
          shotSetIds.has(asset.instanceId) &&
          (activePlanId ? activePlanSet.has(asset.instanceId) : true),
      );
    return listedAssets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, listedAssets, filter, shotSetIds, activePlanSet, activePlanId]);

  const groups = useMemo(() => {
    const map = new Map<string, SceneAsset[]>();
    for (const asset of filteredAssets) {
      const key = groupKey(asset);
      const list = map.get(key);
      if (list) list.push(asset);
      else map.set(key, [asset]);
    }
    return [...map.entries()];
  }, [filteredAssets]);

  const setVisible = (ids: string[], visible: boolean) => {
    if (shotMode) setShotVisibility(ids, visible);
    else setAssetVisibility(ids, visible);
  };

  // 视口里点中元素后，自动展开它所在的分组并滚动到这一行，方便确认选中了哪个
  const selectedGroup = useMemo(() => {
    const asset = listedAssets.find((item) => item.instanceId === selectedId);
    return asset ? groupKey(asset) : null;
  }, [listedAssets, selectedId]);
  const selectedGroupOpen = selectedGroup ? !collapsed[selectedGroup] : false;

  useEffect(() => {
    if (!selectedGroup) return;
    setCollapsed((current) =>
      current[selectedGroup] ? { ...current, [selectedGroup]: false } : current,
    );
  }, [selectedGroup]);

  useEffect(() => {
    if (!selectedId || !selectedGroupOpen) return;
    const raf = requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(`[data-asset-id="${selectedId}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId, selectedGroupOpen, listedAssets]);

  return (
    <Panel
      title={shotMode ? '场景大纲 · 本镜头' : '场景大纲'}
      extra={
        <div className="outline-actions">
          <span
            className="count"
            title={`本镜头 ${listedAssets.length} / 全部 ${assets.length}，已隐藏 ${hiddenCount}`}
          >
            {listedAssets.length}
            {shotMode ? `/${assets.length}` : ''}
          </span>
          <button
            className="mini"
            title="隐藏列表内全部元素"
            onClick={() => setVisible(listedAssets.map((a) => a.instanceId), false)}
          >
            全部隐藏
          </button>
          <button
            className="mini"
            title="显示列表内全部元素"
            onClick={() => setVisible(listedAssets.map((a) => a.instanceId), true)}
          >
            全部显示
          </button>
          {/* 添加模型入口已挪到「工具」tab（StudioPanel 基础模型子页），恢复时取消注释
          <select
            className="prim-add-select"
            value=""
            onChange={(e) => {
              const k = e.target.value as 'box' | 'sphere' | 'column' | '';
              if (k) addPrimitive(k);
              e.currentTarget.value = '';
            }}
          >
            <option value="">＋ 添加模型…</option>
            <option value="box">长方体</option>
            <option value="sphere">球体</option>
            <option value="column">圆柱</option>
          </select>
          */}
        </div>
      }
    >
      {/* 棚和设备开关已拆分为独立「棚和设备」tab（StudioPanel），恢复时把该区块挪回此处 */}
      {/* 置景筛选两级：全部 / 置景；选「置景」后下级一行显示方案置景 / 镜头置景 */}
      <div className="segmented outline-filter">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          全部
        </button>
        <button
          className={filter !== 'all' ? 'active' : ''}
          onClick={() => setFilter('set-plan')}
          title="按置景范围筛选资产"
        >
          置景
        </button>
      </div>
      {filter !== 'all' && (
        <div className="segmented outline-subfilter">
          <button
            className={filter === 'set-plan' ? 'active' : ''}
            onClick={() => setFilter('set-plan')}
            title="当前选中方案中全部置景资产"
          >
            方案置景
          </button>
          {shotMode && (
            <button
              className={filter === 'set-shot' ? 'active' : ''}
              onClick={() => setFilter('set-shot')}
              title="本镜头用到的、且已纳入方案置景集的置景资产"
            >
              镜头置景
            </button>
          )}
        </div>
      )}
      <div className="outline" ref={listRef}>
        {groups.map(([key, list]) => {
          const opened = !collapsed[key];
          const allHidden = list.every(isHidden);
          return (
            <div className="outline-group" key={key}>
              <div
                className="outline-group-head"
                onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
              >
                <span className="caret">{opened ? '▾' : '▸'}</span>
                <span className="outline-group-name">{key}</span>
                <span className="outline-group-count">{list.length}</span>
                <button
                  className={`eye ${allHidden ? '' : 'on'}`}
                  title={
                    allHidden
                      ? `显示「${key}」全部 ${list.length} 个`
                      : `隐藏「${key}」全部 ${list.length} 个`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setVisible(list.map((a) => a.instanceId), allHidden);
                  }}
                >
                  {allHidden ? '○' : '◉'}
                </button>
              </div>
              {opened && (
                <div className="outline-group-rows">
                  {list.map((asset) => {
                    const hidden = isHidden(asset);
                    return (
                      <div key={asset.instanceId}>
                      <div
                        data-asset-id={asset.instanceId}
                        className={`outline-row ${selectedId === asset.instanceId ? 'active' : ''} ${
                          hidden ? 'off' : ''
                        }`}
                        onClick={() => selectAsset(asset.instanceId)}
                      >
                        <button
                          className={`eye ${hidden ? '' : 'on'}`}
                          title={hidden ? '显示' : '隐藏'}
                          onClick={(e) => {
                            e.stopPropagation();
                            setVisible([asset.instanceId], hidden);
                          }}
                        >
                          {hidden ? '○' : '◉'}
                        </button>
                        {/* 命名参考 UE 资产名（拼音_编号，如 SM_CHUANGHU / ZHUZI）：code 为主名，导出 mesh 名作辅助 */}
                        <span className="outline-name" title={`${asset.name} · ${asset.instanceId}`}>
                          {asset.code.split('.')[0]}
                        </span>
                        <span className="outline-code mono">{asset.name}</span>
                        {/* 置景管理：入置景的资产可移除，不置景的可添加（以当前选中方案为准） */}
                        {activePlanId && asset.kind === 'ue' && (
                          <button
                            className={`row-action set-toggle ${
                              activePlanSet.has(asset.instanceId) ? 'on' : ''
                            }`}
                            title={
                              activePlanSet.has(asset.instanceId) ? '移除置景' : '添加为置景'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePlanSetAsset(
                                asset.instanceId,
                                !activePlanSet.has(asset.instanceId),
                              );
                            }}
                          >
                            {activePlanSet.has(asset.instanceId) ? '移除置景' : '＋置景'}
                          </button>
                        )}
                        {/* 仅展示页：复制/删除编辑功能停用（恢复时取消注释并恢复对应 hook）
                        <button
                          className="row-action"
                          title="复制"
                          onClick={(e) => {
                            e.stopPropagation();
                            duplicateAsset(asset.instanceId);
                          }}
                        >
                          ⧉
                        </button>
                        <button
                          className="row-action danger"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeAsset(asset.instanceId);
                          }}
                        >
                          ✕
                        </button>
                        */}
                      </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {filteredAssets.length === 0 && (
          <p className="empty">
            {assets.length === 0
              ? '场景为空，可从顶栏导入 UE 场景'
              : filter !== 'all'
                ? '当前筛选下没有元素'
                : '本镜头视锥内没有用到任何元素'}
          </p>
        )}
      </div>
    </Panel>
  );
}
