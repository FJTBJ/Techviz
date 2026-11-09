import { useState } from 'react';
import { Panel } from './ui';
import { useScene } from '../store/sceneStore';
import type { SceneAsset } from '../types';

/** 可添加的拍摄设备（参数为模拟占位，待设备库数据下发后替换） */
interface DeviceDef {
  id: string;
  name: string;
  params: [string, string][];
}

const DEVICE_CATALOG: DeviceDef[] = [
  {
    id: 'robot-arm',
    name: '机械臂',
    params: [
      ['结构', '6 轴关节臂 + 直线轨道'],
      ['臂展', '3.2 m'],
      ['端部负载', '12 kg'],
      ['重复定位精度', '±0.05 mm'],
      ['最大线速度', '2.0 m/s'],
      ['轨道行程', '8 m'],
      ['控制方式', '预演关键帧回放 / 遥操作'],
    ],
  },
  {
    id: 'treadmill',
    name: '跑步机',
    params: [
      ['跑带尺寸', '2.0 m × 1.2 m'],
      ['速度范围', '0–18 km/h'],
      ['承载', '150 kg'],
      ['驱动', '7.5 kW 变频'],
      ['控制方式', '变速跟随预演时间线'],
    ],
  },
];

/** 模型库可添加的基础模型 */
const PRIM_LIBRARY: { kind: 'box' | 'sphere' | 'column'; name: string; desc: string }[] = [
  { kind: 'box', name: '长方体', desc: '1×1×1 m' },
  { kind: 'sphere', name: '球体', desc: '直径 1 m' },
  { kind: 'column', name: '圆柱', desc: 'Ø1×2 m' },
];

/**
 * 右侧「工具」tab：内部两个子 tab——
 *  - 基础模型：模型库网格，卡片可直接拖拽进 3D 视口（落点即拖放位置），也可点击添加到原点；
 *    下方列出已添加模型（显隐/移除）；
 *  - 设备：添加设备（下拉选择），上半已添加设备列表（点选查看参数、可移除），下半设备参数。
 */
export function StudioPanel() {
  /** 工具内子页：基础模型 / 设备 */
  const [subTab, setSubTab] = useState<'prim' | 'device'>('prim');

  // —— 基础模型（来自资产库中 prim-* 虚拟资产）——
  const assets = useScene((s) => s.assets);
  const addPrimitive = useScene((s) => s.addPrimitive);
  const setAssetVisibility = useScene((s) => s.setAssetVisibility);
  const removeAsset = useScene((s) => s.removeAsset);
  const primAssets = assets.filter((a) => a.instanceId.startsWith('prim-'));

  // —— 设备 ——
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 「添加设备」下拉当前选中项 */
  const [pickId, setPickId] = useState<string>('');

  const added = DEVICE_CATALOG.filter((d) => addedIds.includes(d.id));
  const available = DEVICE_CATALOG.filter((d) => !addedIds.includes(d.id));
  const selected = DEVICE_CATALOG.find((d) => d.id === selectedId) ?? null;

  const addDevice = (id: string) => {
    setAddedIds((ids) => [...ids, id]);
    setSelectedId(id);
  };
  const removeDevice = (id: string) => {
    setAddedIds((ids) => ids.filter((x) => x !== id));
    if (selectedId === id) setSelectedId(null);
  };

  return (
    <Panel>
      {/* 子 tab 行置于面板顶部，添加入口并入同一行右侧 */}
      <div className="tool-head">
        <div className="segmented tool-tabs">
          <button
            className={subTab === 'prim' ? 'active' : ''}
            onClick={() => setSubTab('prim')}
          >
            基础模型
          </button>
          <button
            className={subTab === 'device' ? 'active' : ''}
            onClick={() => setSubTab('device')}
          >
            设备
          </button>
        </div>
        {subTab === 'device' && available.length > 0 && (
          // 设备：添加入口（下拉选择 + 添加按钮）
          <div className="device-add-row">
            <select value={pickId} onChange={(e) => setPickId(e.target.value)}>
              <option value="">选择设备…</option>
              {available.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              className="device-add-btn"
              disabled={!pickId}
              onClick={() => {
                if (!pickId) return;
                addDevice(pickId);
                setPickId('');
              }}
            >
              添加
            </button>
          </div>
        )}
      </div>

      {subTab === 'prim' ? (
        /* —— 基础模型子页：模型库（拖拽进视口 / 点击添加）+ 已添加模型列表 —— */
        <div className="prim-panel">
          <p className="studio-devices-title">模型库</p>
          <div className="prim-library">
            {PRIM_LIBRARY.map((item) => (
              <div
                key={item.kind}
                className="prim-card"
                draggable
                title="拖拽进 3D 视口放置（点击添加到中心）"
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-prim', item.kind);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => addPrimitive(item.kind)}
              >
                <span className={`prim-shape ${item.kind}`} />
                <span className="prim-card-name">{item.name}</span>
                <span className="prim-card-desc mono">{item.desc}</span>
              </div>
            ))}
          </div>

          <p className="studio-devices-title">已添加模型</p>
          <div className="device-added-list">
            {primAssets.length === 0 ? (
              <p className="empty">暂无模型，拖拽上方模型进视口</p>
            ) : (
              primAssets.map((asset: SceneAsset) => (
                <div key={asset.instanceId} className="device-row">
                  <span className="device-name">{asset.name}</span>
                  <button
                    className="row-action"
                    title={asset.visible ? '隐藏模型' : '显示模型'}
                    onClick={() => setAssetVisibility([asset.instanceId], !asset.visible)}
                  >
                    {asset.visible ? '👁' : '🚫'}
                  </button>
                  <button
                    className="row-action danger"
                    title="移除模型"
                    onClick={() => removeAsset(asset.instanceId)}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        /* —— 设备子页：上半已添加设备列表 + 下半选中设备参数 —— */
        <div className="device-panel">
          <p className="studio-devices-title">已添加设备</p>
          <div className="device-added-list">
            {added.length === 0 ? (
              <p className="empty">暂无设备，从右上角添加</p>
            ) : (
              added.map((d) => (
                <div
                  key={d.id}
                  className={`device-row ${selectedId === d.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(d.id)}
                  title={`点击查看「${d.name}」参数`}
                >
                  <span className="device-name">{d.name}</span>
                  <button
                    className="row-action danger"
                    title="移除设备"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeDevice(d.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          <p className="studio-devices-title">设备参数</p>
          {selected ? (
            <div className="device-params">
              <p className="device-params-name">{selected.name}</p>
              {selected.params.map(([key, value]) => (
                <div className="device-param-row" key={key}>
                  <span className="device-param-key">{key}</span>
                  <span className="device-param-val mono">{value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">点击上方设备查看参数</p>
          )}
        </div>
      )}
    </Panel>
  );
}
