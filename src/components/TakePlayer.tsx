import { useEffect, useState } from 'react';
import { getToken } from '../lib/auth';
import { shotLabel } from '../lib/previz';
import { useScene } from '../store/sceneStore';

/**
 * 右下角 take 视频小窗：播放 Kmoke 场记单里当前镜头的 take，可隐藏/展开。
 * 优先播放本地缓存的 /api/takes/<官方短名>.mp4，缺失时回退到 Kmoke 签名地址。
 */
export function TakePlayer() {
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const visible = useScene((s) => s.takeVisible);
  const toggleTake = useScene((s) => s.toggleTake);
  const [failed, setFailed] = useState(false);
  const [useRemote, setUseRemote] = useState(false);

  useEffect(() => {
    setFailed(false);
    setUseRemote(false);
  }, [activeShotId]);

  const shot = activeShotId
    ? (previz?.shots.find((s) => s.id === activeShotId) ?? null)
    : null;
  if (!shot) return null;

  const token = getToken();
  const localSrc = shot.takeLocal && shot.short
    ? `/api/takes/${encodeURIComponent(shot.short)}.mp4${token ? `?token=${encodeURIComponent(token)}` : ''}`
    : null;
  const remoteSrc = shot.takeUrl ?? null;
  const src = localSrc && !useRemote ? localSrc : remoteSrc;
  const label = shotLabel(shot);

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
          <i>take {shot.take ?? '—'}</i>
          {label}
        </span>
        <button className="take-hide" onClick={toggleTake} title="隐藏 take 视频">
          ✕
        </button>
      </header>
      {!src || failed ? (
        <div className="take-empty">
          <strong>暂无 take 视频</strong>
          <span className="mono">{label}</span>
        </div>
      ) : (
        <video
          key={src}
          src={src}
          controls
          playsInline
          preload="metadata"
          onError={() => {
            if (localSrc && remoteSrc && !useRemote) setUseRemote(true);
            else setFailed(true);
          }}
        />
      )}
    </section>
  );
}
