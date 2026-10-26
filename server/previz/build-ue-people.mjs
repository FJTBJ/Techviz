// build-ue-people.mjs — 从 UE take 序列关联的 PostData 镜头序列中抽取人物动画
// 用法: node build-ue-people.mjs
// 输出: server/data/ue-people.json
//
// 关联关系：take 资产（c_xxx.uasset）里有一个 MovieSceneSubSection 指向 m_xxx 镜头序列，
// 该 section 的 SectionRange 起点 = m_ 序列在 take 时间轴上的落点，
// 而 take 的相机关键帧从 camFirst 开始（= 场记单 sourceSeconds）。
// 因此 take 时间 t 对应的人物动画时间 = t + (camFirst - sectionStart) / fps。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAsset } from './ueasset.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATA = path.join(ROOT, 'server/data');
const EXTRACT = path.join(import.meta.dirname, 'uepeople.mjs');
const PROJECT = 'D:/Ver_Projects/P4_Projects/PROJ_THEHAKIMDYXNPS_0806_QiDaoShi_A000A';
const CONTENT = path.join(PROJECT, 'Content');
const SAMPLE_FPS = 10;

const shotsJson = JSON.parse(fs.readFileSync(path.join(DATA, 'previz-shots.json'), 'utf8'));
const shotNames = JSON.parse(fs.readFileSync(path.join(DATA, 'shot-names.json'), 'utf8')).shots || {};

const takeAssets = [...new Set(shotsJson.shots.filter(s => s.asset).map(s => s.asset))];

/** 读 MovieSceneFrameRange：1 字节下界类型 + int32 下界 + 1 字节上界类型 + int32 上界 */
function readFrameRange(buf, valueStart) {
  const lower = buf.readInt32LE(valueStart + 1);
  const upper = buf.readInt32LE(valueStart + 6);
  return { lower, upper };
}

/** take 里指向的 m_ 镜头序列资产路径 */
function resolvePostSequence(asset, take) {
  const text = take.buf.toString('latin1');
  const direct = text.match(/\/Game\/Cinematics\/PostData\/Copy\/(m_[A-Za-z0-9_]+)/);
  if (direct) return { gamePath: `/Game/Cinematics/PostData/Copy/${direct[1]}`, name: direct[1] };
  const sub = take.exports.find(e => take.exportClassName(e) === 'MovieSceneSubSection');
  if (!sub) return null;
  const tags = take.parseTags(sub.off, sub.size);
  const seqTag = tags.tags.find(t => t.name === 'SubSequence');
  if (!seqTag) return null;
  const imp = take.imports[-take.i32(seqTag.valueStart) - 1];
  if (!imp) return null;
  const name = imp.objectName;
  const re = new RegExp('/Game/[A-Za-z0-9_/]+/' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = text.match(re);
  return { gamePath: m ? m[0] : null, name };
}

function gamePathToFile(gamePath) {
  if (!gamePath) return null;
  const rel = gamePath.replace(/^\/Game\//, '');
  const f = path.join(CONTENT, rel + '.uasset');
  return fs.existsSync(f) ? f : null;
}

const shots = {};
const log = [];

for (const asset of takeAssets) {
  const base = path.basename(asset, '.uasset');
  const short = shotNames[base]?.short || null;
  if (!fs.existsSync(asset)) { log.push(`${base}: take 缺失`); continue; }
  const take = loadAsset(asset);
  const rate = take.tickResolution?.numerator || 24;

  // 相机首帧 tick（取有 key 的 3DTransform 段的最小 tick）
  let camFirst = null;
  let camLast = null;
  for (const e of take.exports) {
    if (!/3DTransformSection/.test(take.exportClassName(e))) continue;
    const r = take.parseTags(e.off, e.size);
    for (const t of r.tags) {
      if (!take.isChannelStruct(t)) continue;
      const ch = take.parseChannel(t.valueStart, t.size, t.extra.includes('Double'));
      if (!ch || !ch.times.length) continue;
      if (camFirst === null || ch.times[0] < camFirst) camFirst = ch.times[0];
      const last = ch.times[ch.times.length - 1];
      if (camLast === null || last > camLast) camLast = last;
    }
  }

  // 子序列 section 的落点
  const sub = take.exports.find(e => take.exportClassName(e) === 'MovieSceneSubSection');
  let subStart = null;
  if (sub) {
    const r = take.parseTags(sub.off, sub.size);
    const rt = r.tags.find(t => t.name === 'SectionRange');
    if (rt) subStart = readFrameRange(take.buf, rt.valueStart).lower;
  }

  const seq = resolvePostSequence(asset, take);
  const seqFile = seq ? gamePathToFile(seq.gamePath) : null;
  if (!seqFile) { log.push(`${base}: 无人物序列`); shots[base] = { short, sequence: seq?.gamePath || null, characters: [] }; continue; }

  const tmp = path.join(process.env.TEMP || '.', `uepeople-${base}.json`);
  execFileSync(process.execPath, [EXTRACT, seqFile, '--fps', String(SAMPLE_FPS), '--out', tmp], { stdio: 'pipe' });
  const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.rmSync(tmp, { force: true });

  const offset = (camFirst !== null && subStart !== null) ? +((camFirst - subStart) / rate).toFixed(4) : 0;
  const duration = (camFirst !== null && camLast !== null) ? +((camLast - camFirst) / rate).toFixed(3) : null;

  // 只保留人物：UE 里角色根节点以 Char_ / FIX 开头，
  // 0BP_ / BP_ / SM_ 开头的是道具（如 0BP_NianZhu_A001C 念珠）与门扇，直接剔除。
  const characters = parsed.characters.map(c => ({
    name: c.name,
    label: c.name.replace(/\s+/g, ' ').trim(),
    keys: c.keys
      .filter(k => k.p && k.p.every(v => v != null))
      .map(k => {
        const [x, y, z] = k.p;
        const yaw = k.r ? ((-k.r[2] + 540) % 360 - 180) : 0;
        return {
          s: k.s,
          p: [+(y / 100).toFixed(3), +(z / 100).toFixed(3), +(-x / 100).toFixed(3)],
          yaw: +yaw.toFixed(2),
        };
      }),
  })).filter(c => c.keys.length > 1 && /^(char|fix)/i.test(c.name));

  shots[base] = {
    short,
    sequence: seq.gamePath,
    offset,
    duration,
    characters,
  };
  log.push(`${base}${short ? ` (${short})` : ''}: ${characters.length} 人, offset ${offset}s, ${characters.map(c => `${c.label}×${c.keys.length}`).join(' ')}`);
}

const out = { generatedAt: new Date().toISOString(), fps: SAMPLE_FPS, shots };
fs.writeFileSync(path.join(DATA, 'ue-people.json'), JSON.stringify(out));
console.log(log.join('\n'));
console.log(`\n写出 ${Object.keys(shots).length} 个 take → server/data/ue-people.json (${(fs.statSync(path.join(DATA, 'ue-people.json')).size / 1024).toFixed(0)} KB)`);
