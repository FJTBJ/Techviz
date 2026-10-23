import type { PrevizShot, Vec3 } from '../types';

export interface PrevizPose {
  position: Vec3;
  yaw: number;
  pitch: number;
  focal: number | null;
}

/** 时间线当前所在的镜头（落在镜头之间空隙时返回 null） */
export function shotAt(shots: PrevizShot[], time: number): PrevizShot | null {
  for (const shot of shots) {
    if (time >= shot.start && time <= shot.end) return shot;
  }
  return null;
}

/** 镜头内含当前时间的相邻两帧 */
function bracket(shot: PrevizShot, time: number) {
  const keys = shot.keys;
  if (keys.length === 0) return null;
  if (keys.length === 1) return { a: keys[0], b: keys[0], f: 0 };
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (time <= first.t) return { a: first, b: first, f: 0 };
  if (time >= last.t) return { a: last, b: last, f: 0 };
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= time) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.t - a.t;
  return { a, b, f: span > 1e-6 ? (time - a.t) / span : 0 };
}

/** 在镜头关键帧之间线性插值（yaw 走最短弧） */
export function sampleShot(shot: PrevizShot, time: number): PrevizPose | null {
  const pair = bracket(shot, time);
  if (!pair) return null;
  const { a, b, f } = pair;
  const lerp = (x: number, y: number) => x + (y - x) * f;
  let dyaw = b.yaw - a.yaw;
  if (dyaw > 180) dyaw -= 360;
  if (dyaw < -180) dyaw += 360;
  return {
    position: [
      lerp(a.position[0], b.position[0]),
      lerp(a.position[1], b.position[1]),
      lerp(a.position[2], b.position[2]),
    ],
    yaw: a.yaw + dyaw * f,
    pitch: lerp(a.pitch, b.pitch),
    focal: a.focal ?? b.focal ?? shot.focal ?? null,
  };
}

/** 时间码 00:00:00:00（时:分:秒:帧） */
export function timecode(seconds: number, fps: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * fps);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}
