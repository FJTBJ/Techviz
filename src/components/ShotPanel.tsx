import * as THREE from 'three';
import { ASPECT_KEYS, RIG_TYPES, SENSOR_KEYS, SENSORS, type AspectKey } from '../types';
import { lensMath } from '../lib/lens';
import { useScene } from '../store/sceneStore';
import { viewportBridge } from '../lib/viewportBridge';
import { NumberField, Panel, SliderField } from './ui';

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export function ShotPanel() {
  const shot = useScene((s) => s.camera);
  const patch = useScene((s) => s.patchCamera);
  const setMode = useScene((s) => s.setMode);
  const lens = lensMath(shot.focal, shot.sensor, shot.aspect);
  const coverage = lens.coverageAt(5);

  const setPosition = (index: 0 | 1 | 2, value: number) => {
    const next: [number, number, number] = [...shot.position];
    next[index] = value;
    patch({ position: next });
  };

  const captureView = () => {
    const camera = viewportBridge.camera;
    if (!camera) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    patch({
      position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
      yaw: round((Math.atan2(-dir.x, -dir.z) * 180) / Math.PI, 1),
      pitch: round((Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) * 180) / Math.PI, 1),
    });
    setMode('camera');
  };

  return (
    <Panel
      title="机位与镜头"
      extra={
        <button className="btn tiny" onClick={captureView}>
          取当前视角
        </button>
      }
    >
      <div className="shot-id">
        <input
          value={shot.sceneNo}
          onChange={(e) => patch({ sceneNo: e.target.value })}
          aria-label="场次"
        />
        <span>/</span>
        <input
          value={shot.shotNo}
          onChange={(e) => patch({ shotNo: e.target.value })}
          aria-label="镜号"
        />
      </div>

      <div className="grid-3">
        <NumberField label="机位 X" value={round(shot.position[0])} unit="m" onChange={(v) => setPosition(0, v)} />
        <NumberField label="机位高度" value={round(shot.position[1])} unit="m" onChange={(v) => setPosition(1, v)} />
        <NumberField label="机位 Z" value={round(shot.position[2])} unit="m" onChange={(v) => setPosition(2, v)} />
      </div>

      <SliderField
        label="水平角"
        value={shot.yaw}
        min={0}
        max={360}
        unit="°"
        onChange={(v) => patch({ yaw: v })}
      />
      <SliderField
        label="俯仰"
        value={shot.pitch}
        min={-80}
        max={80}
        unit="°"
        onChange={(v) => patch({ pitch: v })}
      />
      <SliderField
        label="横滚"
        value={shot.roll}
        min={-45}
        max={45}
        unit="°"
        onChange={(v) => patch({ roll: v })}
      />

      <div className="divider" />

      <label className="field">
        <span>传感器</span>
        <select
          value={shot.sensor}
          onChange={(e) => patch({ sensor: e.target.value as typeof shot.sensor })}
        >
          {SENSOR_KEYS.map((key) => (
            <option key={key} value={key}>
              {SENSORS[key].label}
            </option>
          ))}
        </select>
      </label>

      <SliderField
        label="焦距"
        value={shot.focal}
        min={8}
        max={300}
        unit="mm"
        onChange={(v) => patch({ focal: v })}
      />

      <div className="field">
        <span>画幅</span>
        <div className="segmented">
          {ASPECT_KEYS.map((key) => (
            <button
              key={key}
              className={shot.aspect === key ? 'active' : ''}
              onClick={() => patch({ aspect: key as AspectKey })}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <label className="field">
        <span>器材</span>
        <select value={shot.rig} onChange={(e) => patch({ rig: e.target.value as typeof shot.rig })}>
          {RIG_TYPES.map((rig) => (
            <option key={rig} value={rig}>
              {rig}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>技术备注</span>
        <textarea
          rows={2}
          value={shot.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          placeholder="遮挡、净空、器材限制等"
        />
      </label>

      <div className="readout-grid">
        <div>
          <em>水平视角</em>
          <b className="mono">{lens.hfovDeg.toFixed(1)}°</b>
        </div>
        <div>
          <em>垂直视角</em>
          <b className="mono">{lens.vfovDeg.toFixed(1)}°</b>
        </div>
        <div>
          <em>等效焦距</em>
          <b className="mono">{lens.equivalentFocal.toFixed(0)}mm</b>
        </div>
        <div>
          <em>5m 处画面</em>
          <b className="mono">
            {coverage.width.toFixed(1)}×{coverage.height.toFixed(1)}m
          </b>
        </div>
      </div>
    </Panel>
  );
}
