import { useMemo, useState } from 'react';
import { useScene } from '../store/sceneStore';
import { Panel } from './ui';
import type { PrevizShot, ShotCatalogEntry } from '../types';

/** 场次分组：一个场次码下的全部镜头（按镜号排序） */
interface SceneGroup {
  code: string;
  shots: ShotCatalogEntry[];
}

/** 场景资产分组：一级 = 资产名，二级 = 场次，三级 = 镜头 */
interface AssetGroup {
  asset: string;
  scenes: SceneGroup[];
  total: number;
}

/** 场次码排序：s2 < s10 < s079a < s079b（数字优先，后缀其次），无规律码排最后 */
function sceneCodeRank(code: string): [number, string] {
  const m = /^s(\d+)([a-z]?)$/.exec(code);
  if (!m) return [Number.MAX_SAFE_INTEGER, code];
  return [Number(m[1]), m[2]];
}

const UNMAPPED = '未关联场景';

/**
 * 左侧栏：全量镜头树（场景资产 → 场次 → 镜头）。
 * 数据源是 Kmoke 场记全量清单（shot-names.json）+ 场次场景映射（scene-asset-map.json）；
 * 预演时间线（previz）里有的镜头带 3D 机位数据（青色圆点），点击在 3D 视口取景；
 * 其余镜头点击后只播放 take 视频。只读展示，不含任何编辑功能。
 */
export function ShotLibrary() {
  const shotCatalog = useScene((s) => s.shotCatalog);
  const sceneAssetMap = useScene((s) => s.sceneAssetMap);
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const activeNoDataShot = useScene((s) => s.activeNoDataShot);
  const selectShot = useScene((s) => s.selectShot);
  const selectNoDataShot = useScene((s) => s.selectNoDataShot);

  /** 分组折叠状态：用户手动开合的覆盖项；默认只展开选中镜头所在的场景与场次 */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  /** 有 3D 机位数据的镜头：file_name → 预演镜头（两者同源键） */
  const rigShots = useMemo(() => {
    const map = new Map<string, PrevizShot>();
    for (const shot of previz?.shots ?? []) map.set(shot.name, shot);
    return map;
  }, [previz]);

  const groups = useMemo<AssetGroup[]>(() => {
    if (!shotCatalog) return [];
    const byAsset = new Map<string, Map<string, ShotCatalogEntry[]>>();
    for (const entry of shotCatalog) {
      // 场次查不到映射时归到「未关联场景」组（全量清单比映射表覆盖广，属正常现象）
      const asset = (entry.scene && sceneAssetMap?.[entry.scene]?.[0]) || UNMAPPED;
      const code = entry.scene ?? '未知场次';
      let scenes = byAsset.get(asset);
      if (!scenes) {
        scenes = new Map();
        byAsset.set(asset, scenes);
      }
      let list = scenes.get(code);
      if (!list) {
        list = [];
        scenes.set(code, list);
      }
      list.push(entry);
    }
    const sceneSort = (a: SceneGroup, b: SceneGroup) => {
      const [na, sa] = sceneCodeRank(a.code);
      const [nb, sb] = sceneCodeRank(b.code);
      return na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
    };
    return [...byAsset.entries()]
      .map(([asset, scenes]) => {
        const list = [...scenes.entries()]
          .map(([code, shots]) => ({
            code,
            shots: [...shots].sort((a, b) => a.short.localeCompare(b.short)),
          }))
          .sort(sceneSort);
        return { asset, scenes: list, total: list.reduce((acc, s) => acc + s.shots.length, 0) };
      })
      .sort((a, b) => {
        // 「未关联场景」固定排最后，其余按资产名排序
        const ra = a.asset === UNMAPPED ? 1 : 0;
        const rb = b.asset === UNMAPPED ? 1 : 0;
        return ra - rb || a.asset.localeCompare(b.asset, 'zh');
      });
  }, [shotCatalog, sceneAssetMap]);

  /** 当前选中镜头所在场次：默认展开它所在的场景资产与场次 */
  const activeShot = activeShotId
    ? (previz?.shots.find((s) => s.id === activeShotId) ?? null)
    : null;
  const activeSceneCode = activeShot?.scene ?? activeNoDataShot?.scene ?? null;

  const isOpen = (key: string, defaultOpen: boolean) => overrides[key] ?? defaultOpen;
  const toggle = (key: string, defaultOpen: boolean) =>
    setOverrides((prev) => ({ ...prev, [key]: !isOpen(key, defaultOpen) }));

  const total = shotCatalog?.length ?? 0;

  return (
    <aside className="sidebar">
      <Panel title="镜头库" extra={<span className="count">{total}</span>}>
        {!shotCatalog ? (
          <p className="empty">后端无镜头清单数据</p>
        ) : (
          <div className="shot-tree">
            {groups.map((group) => {
              const assetOpen = isOpen(
                `a:${group.asset}`,
                group.scenes.some((scene) => scene.code === activeSceneCode),
              );
              return (
                <div className="shot-group" key={group.asset}>
                  <button className="asset-row" onClick={() => toggle(`a:${group.asset}`, assetOpen)}>
                    <span className={`twist ${assetOpen ? 'open' : ''}`}>▸</span>
                    <span className="asset-name">{group.asset}</span>
                    <span className="count">{group.total}</span>
                  </button>
                  {assetOpen &&
                    group.scenes.map((scene) => {
                      const sceneOpen = isOpen(`s:${scene.code}`, scene.code === activeSceneCode);
                      return (
                        <div className="scene-group" key={scene.code}>
                          <button
                            className="scene-row"
                            onClick={() => toggle(`s:${scene.code}`, sceneOpen)}
                          >
                            <span className={`twist ${sceneOpen ? 'open' : ''}`}>▸</span>
                            <span className="scene-code mono">{scene.code}</span>
                            <span className="count">{scene.shots.length}</span>
                          </button>
                          {sceneOpen && (
                            <div className="shot-list">
                              {scene.shots.map((entry, index) => {
                                const rigShot = entry.hasRig ? rigShots.get(entry.key) : undefined;
                                const active = rigShot
                                  ? activeShotId === rigShot.id
                                  : activeNoDataShot?.key === entry.key;
                                return (
                                  <button
                                    key={entry.key}
                                    className={`shot-card ${active ? 'active' : ''}`}
                                    onClick={() =>
                                      rigShot ? selectShot(rigShot.id) : selectNoDataShot(entry)
                                    }
                                    title={`${entry.short} · take ${entry.take ?? '—'} · ${entry.durationSec.toFixed(1)}s${entry.hasRig ? ' · 含 3D 机位数据' : ''}`}
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
                                      <span className="shot-index mono">
                                        {String(index + 1).padStart(2, '0')}
                                      </span>
                                    )}
                                    <span className="shot-meta">
                                      <strong>
                                        {entry.short}
                                        {entry.hasRig && <i className="rig-dot" title="含 3D 机位数据" />}
                                      </strong>
                                      <em>
                                        {entry.durationSec.toFixed(1)}s · take {entry.take ?? '—'}
                                      </em>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        )}
        <p className="hint">
          青色圆点 = 含 3D 机位数据，点击在 3D 视口取景；其余镜头仅播放 take 视频，机位取景小窗显示占位。
        </p>
      </Panel>
    </aside>
  );
}
