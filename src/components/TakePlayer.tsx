import { useEffect, useRef, useState } from 'react';
import { getToken } from '../lib/auth';
import { shotLabel } from '../lib/previz';
import { useScene } from '../store/sceneStore';

/**
 * 右下角 take 视频小窗：播放 Kmoke 场记单里当前镜头的 take，可隐藏/展开。
 * 播放/暂停、速度、播放头位置全部由底部时间线统一驱动（共用一套播放器）；
 * 小窗最小化（隐藏）时视频卸载，不再受时间线控制。
 */
export function TakePlayer() {
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const visible = useScene((s) => s.takeVisible);
  const toggleTake = useScene((s) => s.toggleTake);
  const playing = useScene((s) => s.playing);
  const speed = useScene((s) => s.playbackSpeed);
  const togglePlayback = useScene((s) => s.togglePlayback);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [useRemote, setUseRemote] = useState(false);

  useEffect(() => {
    setFailed(false);
    setUseRemote(false);
  }, [activeShotId]);

  const shot = activeShotId
    ? (previz?.shots.find((s) => s.id === activeShotId) ?? null)
    : null;

  const token = getToken();
  const localSrc =
    shot?.takeLocal && shot.short
      ? `/api/takes/${encodeURIComponent(shot.short)}.mp4${token ? `?token=${encodeURIComponent(token)}` : ''}`
      : null;
  const remoteSrc = shot?.takeUrl ?? null;
  const src = localSrc && !useRemote ? localSrc : remoteSrc;
  const label = shot ? shotLabel(shot) : '';
  // 环屏投屏：Kmoke 视频 CDN 会回显 Access-Control-Allow-Origin，
  // 远端签名 URL 配合 crossOrigin=anonymous 可直接作为 WebGL 纹理，无需本地缓存
  const projectable = Boolean(src);
  const setTakeVideoEl = useScene((s) => s.setTakeVideoEl);

  // 把小窗里的 video 交给 3D 环屏复用：同一路播放，进度/暂停/速度天然同步
  useEffect(() => {
    const video = projectable ? videoRef.current : null;
    setTakeVideoEl(video);
    return () => setTakeVideoEl(null);
  }, [projectable, src, visible, setTakeVideoEl]);

  // 播放 / 暂停跟随时间线
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing && visible) void video.play().catch(() => {});
    else video.pause();
  }, [playing, visible, src]);

  // 播放速度跟随时间线
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = speed;
  }, [speed, src]);

  // 播放头位置跟随时间线：镜头内相对进度等比映射到视频时长
  useEffect(() => {
    if (!visible || !shot) return;
    const span = Math.max(0.1, shot.end - shot.start);
    const apply = () => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      // 最小化后视频已卸载，这里再兜一层，避免隐藏期间被时间线驱动
      if (!useScene.getState().takeVisible) return;
      const rel = Math.max(0, Math.min(span, useScene.getState().timelineTime - shot.start));
      const target = (rel / span) * video.duration;
      // 阈值内交给视频自身播放，避免每帧 seek 造成抖动
      if (Math.abs(video.currentTime - target) > 0.35) video.currentTime = target;
    };
    apply();
    return useScene.subscribe(apply);
  }, [visible, shot, src]);

  if (!shot) return null;

  if (!visible) {
    return (
      <button className="take-reopen" onClick={toggleTake} title="展开 take 视频">
        take ▸
      </button>
    );
  }

  /** 元数据就绪时对齐到时间线播放头（含速度与播放状态），保证展开即可用 */
  const syncVideo = (video: HTMLVideoElement) => {
    const span = Math.max(0.1, shot.end - shot.start);
    const state = useScene.getState();
    const rel = Math.max(0, Math.min(span, state.timelineTime - shot.start));
    video.playbackRate = state.playbackSpeed;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = (rel / span) * video.duration;
    }
    if (state.playing && state.takeVisible) void video.play().catch(() => {});
  };

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
        <div className="take-stage">
          <video
            key={src}
            ref={videoRef}
            src={src}
            crossOrigin="anonymous"
            playsInline
            preload="metadata"
            onClick={togglePlayback}
            onLoadedMetadata={(e) => syncVideo(e.currentTarget)}
            onError={() => {
              if (localSrc && remoteSrc && !useRemote) setUseRemote(true);
              else setFailed(true);
            }}
          />
          <span className="take-sync" title="播放 / 暂停、速度、进度均跟随底部时间线">
            {playing ? '❚❚' : '▶'} {speed}× 跟随时间线
          </span>
        </div>
      )}
    </section>
  );
}
