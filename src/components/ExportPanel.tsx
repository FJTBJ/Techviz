import { useRef, useState, type ChangeEvent } from 'react';
import { PROJECT_INFO } from '../data/mockData';
import { composeShotImage, downloadBlob, shotCsv } from '../lib/exporters';
import { viewportBridge } from '../lib/viewportBridge';
import { useScene } from '../store/sceneStore';
import { Panel } from './ui';

export function ExportPanel() {
  const shot = useScene((s) => s.camera);
  const buildScenario = useScene((s) => s.buildScenario);
  const loadScenario = useScene((s) => s.loadScenario);
  const resetDemo = useScene((s) => s.resetDemo);
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');

  const exportShotImage = () => {
    const canvas = viewportBridge.canvas;
    if (!canvas) {
      setMessage('画布尚未就绪');
      return;
    }
    const dataUrl = composeShotImage(canvas, shot, PROJECT_INFO.projectName);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${shot.sceneNo}-${shot.shotNo}-机位图.png`;
    a.click();
    setMessage('机位图已导出（按目标画幅裁切）');
  };

  const exportCsv = () => {
    downloadBlob(
      `${shot.sceneNo}-${shot.shotNo}-镜头表.csv`,
      shotCsv(shot, PROJECT_INFO.projectName),
      'text/csv;charset=utf-8',
    );
    setMessage('镜头表 CSV 已导出');
  };

  const saveScenario = () => {
    downloadBlob(
      `${shot.sceneNo}-${shot.shotNo}-techviz方案.json`,
      JSON.stringify(buildScenario(), null, 2),
      'application/json',
    );
    setMessage('方案 JSON 已保存');
  };

  const openScenario = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const error = loadScenario(JSON.parse(text));
      setMessage(error ?? '方案已载入');
    } catch {
      setMessage('读取失败：文件不是合法的 JSON');
    }
  };

  return (
    <Panel title="出图与交付">
      <div className="export-grid">
        <button className="btn" onClick={exportShotImage}>
          导出机位图
        </button>
        <button className="btn" onClick={exportCsv}>
          导出镜头表
        </button>
        <button className="btn" onClick={saveScenario}>
          保存方案
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          载入方案
        </button>
      </div>
      <input ref={fileRef} type="file" accept=".json" hidden onChange={openScenario} />
      {message && <p className="hint strong">{message}</p>}
      <button className="btn ghost block" onClick={resetDemo}>
        重置为示例场景
      </button>
    </Panel>
  );
}
