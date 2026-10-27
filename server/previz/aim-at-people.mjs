/**
 * 把预演机位的朝向重新对准演员。
 *
 * 背景：take 里记录的是相机相对「机位架/父级」的变换（没有 AttachTrack，
 * 父级对象也不在导出表里），所以 28 个镜头里有 5°~177° 不等的朝向误差，
 * 表现为镜头明明贴着演员却看向别处。位置是对的（演员与机位距离 1~8m 合理），
 * 只有 yaw/pitch 不可信。
 *
 * 这里保留 take 记录的机位位置，把 yaw/pitch 改为朝向画面主体演员的头部：
 *   - 取距离机位最近、且在 15m 内的演员
 *   - 目标点 = 演员脚下 + 1.45m（胸口~颈部，兼容 1.7m 身高）
 * 原始朝向保存在 rawYaw / rawPitch，加 --raw 参数可原样还原。
 *
 * 用法：
 *   node server/previz/aim-at-people.mjs            # 对准演员
 *   node server/previz/aim-at-people.mjs --raw      # 还原 take 原始朝向
 *   node server/previz/aim-at-people.mjs --dry      # 只打印，不写文件
 */
import fs from 'node:fs';

const DATA = 'd:/trae_projects/Web3d/server/data';
const TIMELINE = `${DATA}/previz-timeline.json`;
const PEOPLE = `${DATA}/ue-people.json`;

const args = process.argv.slice(2);
const restore = args.includes('--raw');
const dry = args.includes('--dry');

const HEAD = 1.45;
const MAX_DIST = 15;

const timeline = JSON.parse(fs.readFileSync(TIMELINE, 'utf8'));
const people = JSON.parse(fs.readFileSync(PEOPLE, 'utf8'));

const parseP = (k) => (Array.isArray(k.p) ? k.p : String(k.p).split(/\s+/).map(Number));
const keyTime = (k) => (k.t !== undefined ? k.t : k.s);

/** 在 key 序列里按时间线性插值（key 的 s 为镜头内本地秒） */
function sampleKeys(keys, t) {
  if (!keys.length) return null;
  if (t <= keyTime(keys[0])) return parseP(keys[0]);
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= keyTime(a) && t <= keyTime(b)) {
      const f = (t - keyTime(a)) / Math.max(1e-6, keyTime(b) - keyTime(a));
      const pa = parseP(a);
      const pb = parseP(b);
      return [0, 1, 2].map((j) => pa[j] + (pb[j] - pa[j]) * f);
    }
  }
  return parseP(keys[keys.length - 1]);
}

const rad2deg = (r) => (r * 180) / Math.PI;

let changed = 0;
let skipped = 0;
const stats = [];

for (const shot of timeline.shots) {
  const key = shot.id.replace(/@.*$/, '');
  const entry = people.shots?.[key];
  if (!entry?.characters?.length) {
    skipped += 1;
    continue;
  }

  const t0 = keyTime(shot.keys[0]);
  const offset = entry.offset ?? 0;
  let usedShot = 0;
  const pitches = [];

  for (const k of shot.keys) {
    if (restore) {
      if (k.rawYaw !== undefined) {
        k.yaw = k.rawYaw;
        k.pitch = k.rawPitch;
        delete k.rawYaw;
        delete k.rawPitch;
      }
      continue;
    }

    // 机位关键帧的 t 是 UE 绝对时间，换算成镜头内本地时间再叠加人物偏移
    const localT = keyTime(k) - t0 + offset;
    let best = null;
    for (const ch of entry.characters) {
      const p = sampleKeys(ch.keys, localT);
      if (!p) continue;
      const dx = p[0] - k.position[0];
      const dz = p[2] - k.position[2];
      const dist = Math.hypot(dx, dz);
      if (dist > MAX_DIST) continue;
      if (!best || dist < best.dist) best = { p, dist };
    }
    if (!best) continue;

    if (k.rawYaw === undefined) {
      k.rawYaw = k.yaw;
      k.rawPitch = k.pitch;
    }
    const dx = best.p[0] - k.position[0];
    const dy = best.p[1] + HEAD - k.position[1];
    const dz = best.p[2] - k.position[2];
    const yaw = rad2deg(Math.atan2(-dx, -dz));
    const pitch = rad2deg(Math.atan2(dy, Math.hypot(dx, dz)));
    k.yaw = +yaw.toFixed(3);
    k.pitch = +pitch.toFixed(3);
    pitches.push(pitch);
    usedShot += 1;
  }

  if (usedShot) {
    changed += 1;
    const avg = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    stats.push({ id: key, keys: usedShot, pitch: +avg.toFixed(1) });
  }
}

if (!dry) fs.writeFileSync(TIMELINE, JSON.stringify(timeline, null, 1));

console.log(restore ? '已还原 take 原始朝向' : `已对准演员：${changed} 个镜头（${skipped} 个镜头无人物数据）`);
for (const s of stats.slice(0, 12)) console.log(' ', s.id, '关键帧', s.keys, '平均俯仰', s.pitch, '°');
if (dry) console.log('（--dry 未写文件）');
