import { pointToAssetDistance } from '../lib/geometry';
import { useScene } from '../store/sceneStore';
import { NumberField, Panel } from './ui';

export function MeasurePanel() {
  const assets = useScene((s) => s.assets);
  const camera = useScene((s) => s.camera);
  const mode = useScene((s) => s.mode);
  const setMode = useScene((s) => s.setMode);
  const measurements = useScene((s) => s.measurements);
  const removeMeasurement = useScene((s) => s.removeMeasurement);
  const clearMeasurement = useScene((s) => s.clearMeasurement);
  const threshold = useScene((s) => s.clearanceThreshold);
  const setThreshold = useScene((s) => s.setClearanceThreshold);

  const clearances = assets
    .filter((a) => a.visible)
    .map((a) => ({ id: a.instanceId, name: a.name, distance: pointToAssetDistance(camera.position, a) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4);

  const violation = clearances.find((c) => c.distance < threshold);

  return (
    <Panel
      title="测量与净空"
      extra={
        <button
          className={`btn tiny ${mode === 'measure' ? 'active' : ''}`}
          onClick={() => setMode(mode === 'measure' ? 'orbit' : 'measure')}
        >
          {mode === 'measure' ? '退出测量' : '进入测量'}
        </button>
      }
    >
      <div className="measure-list">
        {measurements.map((m) => (
          <div key={m.id} className="measure-row">
            <span className="mono primary">{m.distance.toFixed(2)} m</span>
            <span className="mono subtle">
              高差 {m.deltaY.toFixed(2)} · 平面 {m.deltaXZ.toFixed(2)}
            </span>
            <button className="row-action" onClick={() => removeMeasurement(m.id)}>
              ✕
            </button>
          </div>
        ))}
        {measurements.length === 0 && (
          <p className="empty">尚无测量结果，进入测量模式后在视口点选两点</p>
        )}
        {measurements.length > 0 && (
          <button className="btn ghost block" onClick={clearMeasurement}>
            清空测量
          </button>
        )}
      </div>

      <div className="divider" />

      <NumberField
        label="最小净空"
        value={threshold}
        step={0.1}
        min={0}
        max={10}
        unit="m"
        onChange={setThreshold}
      />

      <div className="clearance-list">
        {clearances.map((c) => (
          <div key={c.id} className={`clearance-row ${c.distance < threshold ? 'warn' : ''}`}>
            <span className="outline-name">{c.name}</span>
            <span className="mono">{c.distance.toFixed(2)} m</span>
          </div>
        ))}
      </div>

      {violation ? (
        <p className="alert">
          机位距「{violation.name}」仅 {violation.distance.toFixed(2)}m，低于最小净空 {threshold}m
        </p>
      ) : (
        <p className="ok">机位净空满足当前阈值</p>
      )}
    </Panel>
  );
}
