import { useEffect, useMemo, useRef } from 'react';
import { useScene } from '../store/sceneStore';
import { shotLabel, timecode } from '../lib/previz';

/** 场次配色，让时间线上的镜头块可区分 */
const SCENE_COLORS = ['#3f7fd6', '#5bb98c', '#c98b3a', '#a06bd0', '#c0555f', '#4aa6b8', '#8a8f3d'];

/**
 * 镜头时间线：只在镜头库选中某个镜头时出现，
 * 播放范围限定在该镜头内（master 时间码 shot.start ~ shot.end）。
 */
export function Timeline() {
  const previz = useScene((s) => s.previz);
  const activeShotId = useScene((s) => s.activeShotId);
  const time = useScene((s) => s.timelineTime);
  const playing = useScene((s) => s.playing);
  const speed = useScene((s) => s.playbackSpeed);
  const follow = useScene((s) => s.followPreviz);
  const togglePlayback = useScene((s) => s.togglePlayback);
  const setTimelineTime = useScene((s) => s.setTimelineTime);
  const setSpeed = useScene((s) => s.setPlaybackSpeed);
  const toggleFollow = useScene((s) => s.toggleFollowPreviz);
  const selectShot = useScene((s) => s.selectShot);
  const trackRef = useRef<HTMLDivElement>(null);

  const fps = previz?.fps ?? 24;
  const shots = previz?.shots ?? [];
  const shot = useMemo(
    () => (activeShotId ? (previz?.shots.find((s) => s.id === activeShotId) ?? null) : null),
    [previz, activeShotId],
  );

  // 本场次内的镜头顺序，用于上一镜 / 下一镜
  const siblings = useMemo(() => {
    if (!shot) return [];
    return shot.scene ? shots.filter((s) => s.scene === shot.scene) : shots;
  }, [shots, shot]);

  // 播放驱动：requestAnimationFrame 推进播放头，到本镜头出点后回到入点
  useEffect(() => {
    if (!playing || !shot) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const st = useScene.getState();
      if (!st.playing || !st.previz) return;
      const next = st.timelineTime + dt * st.playbackSpeed;
      st.setTimelineTime(next >= shot.end ? shot.start : next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, shot]);

  // 空格键播放/暂停（输入框内不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      e.preventDefault();
      if (useScene.getState().previz && useScene.getState().activeShotId) {
        useScene.getState().togglePlayback();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!previz || !shot) return null;

  const start = shot.start;
  const duration = Math.max(0.1, shot.end - shot.start);
  const rel = Math.max(0, Math.min(duration, time - start));
  const pct = (rel / duration) * 100;

  const sceneIndex = Math.max(0, previz.scenes.findIndex((item) => item.scene === shot.scene));
  const color = SCENE_COLORS[sceneIndex % SCENE_COLORS.length];

  const seekByEvent = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setTimelineTime(start + ratio * duration);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekByEvent(e.clientX);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    seekByEvent(e.clientX);
  };

  const stepShot = (dir: -1 | 1) => {
    if (!siblings.length) return;
    const index = siblings.findIndex((s) => s.id === shot.id);
    const next = siblings[Math.max(0, Math.min(siblings.length - 1, index + dir))];
    if (next && next.id !== shot.id) selectShot(next.id);
  };

  const label = shotLabel(shot);

  return (
    <div className="timeline">
      <div className="tl-left">
        <button className="tl-play" onClick={togglePlayback} title="播放 / 暂停本镜头（空格）">
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          className="tl-step"
          onClick={() => stepShot(-1)}
          disabled={siblings.findIndex((s) => s.id === shot.id) <= 0}
          title="上一镜"
        >
          ◀|
        </button>
        <button
          className="tl-step"
          onClick={() => stepShot(1)}
          disabled={siblings.findIndex((s) => s.id === shot.id) >= siblings.length - 1}
          title="下一镜"
        >
          |▶
        </button>
        <span className="tl-time mono">{timecode(rel, fps)}</span>
        <span className="tl-frame mono">f{Math.floor(rel * fps)}</span>
      </div>

      <div
        className="tl-track"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        title="点击或拖动定位本镜头"
      >
        <div
          className="tl-block active"
          style={{ left: '0%', width: '100%', background: color }}
          title={`${label} · ${shot.id}`}
        />
        <div className="tl-playhead" style={{ left: `${pct}%` }} />
      </div>

      <div className="tl-right">
        <span className="tl-shot" title={shot.id}>
          {label}
        </span>
        <span className="tl-dur mono">{fmtDur(duration)}</span>
        <button
          className={`tl-follow ${follow ? 'active' : ''}`}
          onClick={toggleFollow}
          title="视口相机跟随本镜头机位"
        >
          跟随机位
        </button>
        <select
          className="tl-speed"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          title="播放速度"
        >
          <option value={0.25}>0.25×</option>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
      </div>
    </div>
  );
}

function fmtDur(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
