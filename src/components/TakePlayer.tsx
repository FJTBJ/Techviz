import { useEffect, useState } from 'react';
import { shotShortName } from '../lib/previz';
import { useScene } from '../store/sceneStore';

/**
 * 右下角 take 视频小窗：播放当前镜头的 take 条，可隐藏/展开。
 * 视频约定放在 /takes/<镜头文件名>.mp4（缺失时显示占位说明）。
 */
export function TakePlayer() {
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const visible = useScene((s) => s.takeVisible);
  const toggleTake = useScene((s) => s.toggleTake);
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [activeShotId]);

  const shot = activeShotId
    ? (previz?.shots.find((s) => s.id === activeShotId) ?? null)
    : null;
  if (!shot) return null;

  const src = `/takes/${encodeURIComponent(shot.name)}.mp4`;
  const label = previz ? shotShortName(shot, previz.shots) : shot.name;

  if (!visible) {
    return (
      <button className="take-reopen" onClick={toggleTake} title="展开 take 视频">
        take ▸
      </button>
    );
  }

  return (
    <section className="take-player">
      <header>
        <span className="take-title">
          <i>take</i>
          {label}
        </span>
        <button className="take-hide" onClick={toggleTake} title="隐藏 take 视频">
          ✕
        </button>
      </header>
      {failed ? (
        <div className="take-empty">
          <strong>暂无 take 视频</strong>
          <span className="mono">{src}</span>
        </div>
      ) : (
        <video
          key={shot.id}
          src={src}
          controls
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
        />
      )}
    </section>
  );
}
