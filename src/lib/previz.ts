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

/**
 * 按 master 时间码取姿态。
 * 注意：关键帧的 t 是 UE take 时间码（如 33275s），不是 master 秒数，
 * 首帧 t 对应 shot.start，因此按相同时间偏移平移到关键帧时间轴（1:1，不拉伸），
 * 轨道结束后 sampleShot 会自然停在最后一帧。
 */
export function sampleShotAtTime(shot: PrevizShot, time: number): PrevizPose | null {
  const keys = shot.keys;
  if (keys.length === 0) return null;
  return sampleShot(shot, keys[0].t + (time - shot.start));
}

/**
 * 把整个集合（布景 / 演员 / 机位）绕环屏中心整体旋转 yawDeg。
 * 集合内相对关系不变，只是相对固定的 LED 缺口换了朝向。
 */
export function rotatePoseY(
  pose: PrevizPose,
  yawDeg: number,
  translate: [number, number, number] = [0, 0, 0],
): PrevizPose {
  const r = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // 置景摆放平移在原始坐标系生效（先平移后旋转），与视口中「旋转组 > 平移组」的嵌套顺序一致
  const x = pose.position[0] + translate[0];
  const y = pose.position[1] + translate[1];
  const z = pose.position[2] + translate[2];
  return {
    ...pose,
    position: [x * cos + z * sin, y, -x * sin + z * cos],
    yaw: pose.yaw + yawDeg,
  };
}

/** 镜头在指定时间的原始机位姿态（集合整体转向由 rotatePoseY 叠加） */
export function shotPoseAt(shot: PrevizShot, time: number): PrevizPose | null {
  return sampleShotAtTime(shot, time);
}

/** 官方镜头短名：Kmoke 场记单 shot_file_name（如 s079a_c004_A），缺失时退回 UE 镜头名 */
export function shotLabel(shot: PrevizShot): string {
  if (shot.short) return shot.short;
  return shot.name.replace(/@.*$/, '');
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
