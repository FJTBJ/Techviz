import { useMemo, useState } from 'react';
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
  const updateAsset = useScene((s) => s.updateAsset);
  const setAssetVisibility = useScene((s) => s.setAssetVisibility);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const hiddenCount = assets.filter((a) => !a.visible).length;

  const groups = useMemo(() => {
    const map = new Map<string, SceneAsset[]>();
    for (const asset of assets) {
      const key = groupKey(asset);
      const list = map.get(key);
      if (list) list.push(asset);
      else map.set(key, [asset]);
    }
    return [...map.entries()];
  }, [assets]);

  return (
    <Panel
      title="场景大纲"
      extra={
        <div className="outline-actions">
          <span className="count" title={`显示 ${assets.length - hiddenCount} / 隐藏 ${hiddenCount}`}>
            {assets.length}
          </span>
          <button
            className="mini"
            title="隐藏全部元素"
            onClick={() => setAssetVisibility(assets.map((a) => a.instanceId), false)}
          >
            全部隐藏
          </button>
          <button
            className="mini"
            title="显示全部元素"
            onClick={() => setAssetVisibility(assets.map((a) => a.instanceId), true)}
          >
            全部显示
          </button>
        </div>
      }
    >
      <div className="outline">
        {groups.map(([key, list]) => {
          const opened = !collapsed[key];
          const allVisible = list.every((a) => a.visible);
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
                  className={`eye ${allVisible ? 'on' : ''}`}
                  title={allVisible ? `隐藏「${key}」全部 ${list.length} 个` : `显示「${key}」全部 ${list.length} 个`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAssetVisibility(list.map((a) => a.instanceId), !allVisible);
                  }}
                >
                  {allVisible ? '◉' : '○'}
                </button>
              </div>
              {opened && (
                <div className="outline-group-rows">
                  {list.map((asset) => (
                    <div
                      key={asset.instanceId}
                      className={`outline-row ${selectedId === asset.instanceId ? 'active' : ''}`}
                      onClick={() => selectAsset(asset.instanceId)}
                    >
                      <button
                        className={`eye ${asset.visible ? 'on' : ''}`}
                        title={asset.visible ? '隐藏' : '显示'}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateAsset(asset.instanceId, { visible: !asset.visible });
                        }}
                      >
                        {asset.visible ? '◉' : '○'}
                      </button>
                      <span className="outline-name">{asset.name}</span>
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
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {assets.length === 0 && <p className="empty">场景为空，可从顶栏导入 UE 场景</p>}
      </div>
    </Panel>
  );
}
