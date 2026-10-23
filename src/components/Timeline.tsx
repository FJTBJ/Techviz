import { useEffect, useMemo, useRef } from 'react';
import { useScene } from '../store/sceneStore';
import { shotAt, timecode } from '../lib/previz';

/** 场次配色，让时间线上的镜头块可区分 */
const SCENE_COLORS = ['#3f7fd6', '#5bb98c', '#c98b3a', '#a06bd0', '#c0555f', '#4aa6b8', '#8a8f3d'];

export function Timeline() {
  const previz = useScene((s) => s.previz);
  const time = useScene((s) => s.timelineTime);
  const playing = useScene((s) => s.playing);
  const speed = useScene((s) => s.playbackSpeed);
  const follow = useScene((s) => s.followPreviz);
  const togglePlayback = useScene((s) => s.togglePlayback);
  const setTimelineTime = useScene((s) => s.setTimelineTime);
  const setSpeed = useScene((s) => s.setPlaybackSpeed);
  const toggleFollow = useScene((s) => s.toggleFollowPreviz);
  const seekShot = useScene((s) => s.seekShot);
  const trackRef = useRef<HTMLDivElement>(null);

  const duration = previz?.duration ?? 0;
  const fps = previz?.fps ?? 24;
  const shots = previz?.shots ?? [];
  const current = useMemo(() => (previz ? shotAt(shots, time) : null), [previz, shots, time]);
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;

  // 播放驱动：requestAnimationFrame 推进播放头，到末尾循环
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const st = useScene.getState();
      if (!st.playing || !st.previz) return;
      const next = st.timelineTime + dt * st.playbackSpeed;
      st.setTimelineTime(next >= st.previz.duration ? 0 : next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // 空格键播放/暂停（输入框内不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      e.preventDefault();
      if (useScene.getState().previz) useScene.getState().togglePlayback();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 镜头块：按 master 时间码定位
  const blocks = useMemo(() => {
    const colors = new Map<string, string>();
    for (const s of shots) {
      const key = s.scene ?? '—';
      if (!colors.has(key)) colors.set(key, SCENE_COLORS[colors.size % SCENE_COLORS.length]);
    }
    return shots.map((s) => ({
      id: s.id,
      name: s.name,
      start: s.start,
      width: Math.max(0.35, ((s.end - s.start) / Math.max(duration, 1)) * 100),
      left: (s.start / Math.max(duration, 1)) * 100,
      color: colors.get(s.scene ?? '—') ?? SCENE_COLORS[0],
    }));
  }, [shots, duration]);

  const seekByEvent = (clientX: number) => {
    const el = trackRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setTimelineTime(ratio * duration);
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
    if (!shots.length) return;
    const index = shots.findIndex((s) => s.id === current?.id);
    if (index < 0) {
      const next = shots.find((s) => s.start > time) ?? shots[shots.length - 1];
      seekShot(next.id);
      return;
    }
    const next = shots[Math.max(0, Math.min(shots.length - 1, index + dir))];
    seekShot(next.id);
  };

  return (
    <div className={`timeline ${previz ? '' : 'disabled'}`}>
      <div className="tl-left">
        <button className="tl-play" onClick={togglePlayback} disabled={!previz} title="播放 / 暂停（空格）">
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="tl-step" onClick={() => stepShot(-1)} disabled={!previz} title="上一镜">
          ◀|
        </button>
        <button className="tl-step" onClick={() => stepShot(1)} disabled={!previz} title="下一镜">
          |▶
        </button>
        <span className="tl-time mono">{timecode(time, fps)}</span>
        <span className="tl-frame mono">f{Math.floor(time * fps)}</span>
      </div>

      <div
        className="tl-track"
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        title="点击或拖动定位"
      >
        {blocks.map((b) => (
          <div
            key={b.id}
            className={`tl-block ${current?.id === b.id ? 'active' : ''}`}
            style={{ left: `${b.left}%`, width: `${b.width}%`, background: b.color }}
            title={`${b.name} @ ${b.start.toFixed(1)}s`}
          />
        ))}
        {!previz && <span className="tl-empty">无预演时间线（需后端 previz-timeline.json）</span>}
        <div className="tl-playhead" style={{ left: `${pct}%` }} />
      </div>

      <div className="tl-right">
        <span className={`tl-shot ${current ? '' : 'dim'}`} title={current?.name}>
          {current ? current.name : previz ? '（镜头间隙）' : '—'}
        </span>
        <span className="tl-dur mono">{fmtDur(duration)}</span>
        <button
          className={`tl-follow ${follow ? 'active' : ''}`}
          onClick={toggleFollow}
          disabled={!previz}
          title="视口相机跟随预演机位"
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
