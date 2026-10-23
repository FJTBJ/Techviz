import { useRef, useState, type ChangeEvent } from 'react';
import { ASSET_LIBRARY } from '../data/mockData';
import { useScene } from '../store/sceneStore';
import { Panel } from './ui';

export function AssetLibrary() {
  const [keyword, setKeyword] = useState('');
  const addAssetFromLibrary = useScene((s) => s.addAssetFromLibrary);
  const addUploadedModel = useScene((s) => s.addUploadedModel);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = ASSET_LIBRARY.filter((item) => {
    if (!keyword.trim()) return true;
    const key = keyword.trim().toLowerCase();
    return (
      item.name.toLowerCase().includes(key) ||
      item.code.toLowerCase().includes(key) ||
      item.assetType.includes(key)
    );
  });

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    addUploadedModel(file.name.replace(/\.(glb|gltf)$/i, ''), url);
    event.target.value = '';
  };

  return (
    <aside className="sidebar">
      <Panel
        title="资产库"
        extra={<span className="count">{ASSET_LIBRARY.length}</span>}
      >
        <input
          className="search"
          placeholder="搜索名称 / 编码 / 类型"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <div className="asset-list">
          {filtered.map((item) => (
            <button
              key={item.assetId}
              className="asset-card"
              onClick={() => addAssetFromLibrary(item)}
              title="点击加入场景"
            >
              <span className="asset-swatch" style={{ background: item.color }}>
                {item.assetType.slice(0, 1)}
              </span>
              <span className="asset-meta">
                <strong>{item.name}</strong>
                <em>
                  {item.code} · {item.level}
                </em>
              </span>
              <span className="asset-add">＋</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="empty">未找到匹配资产</p>}
        </div>
      </Panel>

      <Panel title="UE 导出模型">
        <p className="hint">
          从 UE 用 glTF Exporter 导出 GLB 后在此加载；模型单位为米，原点位于资产底部。
        </p>
        <button className="btn block" onClick={() => fileRef.current?.click()}>
          上传 .glb / .gltf
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".glb,.gltf"
          hidden
          onChange={handleUpload}
        />
      </Panel>
    </aside>
  );
}
