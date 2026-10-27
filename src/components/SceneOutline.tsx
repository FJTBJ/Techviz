import { useEffect, useMemo, useRef, useState } from 'react';
import { useScene } from '../store/sceneStore';
import type { SceneAsset } from '../types';
import { Panel } from './ui';

/** 用 code 去掉尾部序号做分组键，便于整组显隐（CUBE / ZHUZI / SM_CHUANGHU…） */
const groupKey = (asset: SceneAsset) => {
  const code = asset.code.split('.')[0];
  return code.replace(/[\d_]+$/, '') || code;
};

export function SceneOutline() {
  const assets = useScene((s) => s.assets);
  const selectedId = useScene((s) => s.selectedId);
  const selectAsset = useScene((s) => s.selectAsset);
  const removeAsset = useScene((s) => s.removeAsset);
  const duplicateAsset = useScene((s) => s.duplicateAsset);
  const setAssetVisibility = useScene((s) => s.setAssetVisibility);
  const usedIds = useScene((s) => s.activeShotUsedIds);
  const shotHiddenIds = useScene((s) => s.shotHiddenIds);
  const setShotVisibility = useScene((s) => s.setShotVisibility);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLDivElement | null>(null);

  /** 选中镜头时大纲只列该镜头用到的元素，和视口保持一致 */
  const shotMode = Boolean(usedIds);
  const listedAssets = useMemo(() => {
    if (!usedIds) return assets;
    const used = new Set(usedIds);
    return assets.filter((asset) => used.has(asset.instanceId));
  }, [assets, usedIds]);

  const hiddenSet = useMemo(() => new Set(shotHiddenIds), [shotHiddenIds]);
  /** 列表里这一行的实际显隐：镜头模式看手工隐藏覆盖，完整场景看资产自身的 visible */
  const isHidden = (asset: SceneAsset) =>
    shotMode ? hiddenSet.has(asset.instanceId) : !asset.visible;

  const hiddenCount = listedAssets.filter(isHidden).length;

  const groups = useMemo(() => {
    const map = new Map<string, SceneAsset[]>();
    for (const asset of listedAssets) {
      const key = groupKey(asset);
      const list = map.get(key);
      if (list) list.push(asset);
      else map.set(key, [asset]);
    }
    return [...map.entries()];
  }, [listedAssets]);

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
        </div>
      }
    >
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
                      <div
                        key={asset.instanceId}
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
                        <span className="outline-name" title={`${asset.name} · ${asset.code}`}>
                          {asset.name}
                        </span>
                        <span className="outline-code mono">{asset.code}</span>
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
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {listedAssets.length === 0 && (
          <p className="empty">
            {assets.length === 0
              ? '场景为空，可从顶栏导入 UE 场景'
              : '本镜头视锥内没有用到任何元素'}
          </p>
        )}
      </div>
    </Panel>
  );
}
