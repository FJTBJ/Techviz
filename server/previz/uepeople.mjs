// uepeople.mjs — 从 UE 关卡序列（PostData 镜头序列）中抽取人物 actor 的动画轨道
// 用法: node uepeople.mjs <path-to-uasset> [--fps 10] [--out file] [--debug]
import fs from 'node:fs';
import { loadAsset } from './ueasset.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node uepeople.mjs <uasset> [--fps 10] [--out file] [--debug]'); process.exit(2); }
const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const sampleFps = Number(argOf('fps', 10));
const outFile = argOf('out', null);
const debug = (...a) => { if (process.argv.includes('--debug') || process.env.UEPEOPLE_DEBUG) console.error(...a); };

const a = loadAsset(file);
const { buf, i32, nameList, exports, exportClassName } = a;
const movieScene = a.movieScene;
if (!movieScene) { console.error('no MovieScene export'); process.exit(1); }
const M = { start: movieScene.off, end: movieScene.off + movieScene.size };

const tickRes = a.tickResolution;
const toSec = t => tickRes && tickRes.numerator ? t * tickRes.denominator / tickRes.numerator : t / 24;

// ---- possessables ----
const NAME = nameList.indexOf('Name');
const PARENT_GUID = nameList.indexOf('ParentGuid');
const TRACKS = nameList.indexOf('Tracks');

const hitsOf = idx => {
  const out = [];
  if (idx < 0) return out;
  for (let o = M.start; o + 8 <= M.end; o++) if (i32(o) === idx && i32(o + 4) === 0) out.push(o);
  return out;
};
const hex = (o, n) => buf.subarray(o, o + n).toString('hex');
const parentHits = hitsOf(PARENT_GUID);
const parentOf = nameHit => {
  const ph = parentHits.find(o => o > nameHit && o < nameHit + 400);
  return ph ? hex(ph + 49, 16) : null;
};
const possessables = hitsOf(NAME)
  .map(h => ({ guid: hex(h - 16, 16), parent: parentOf(h), name: a.readFString(h + 25) }))
  .filter(p => p.name && p.guid !== '00000000000000000000000000000000');
const possByGuid = new Map(possessables.map(p => [p.guid, p]));

// ---- bindings: guid -> track 导出索引 ----
const bindings = hitsOf(TRACKS).map(h => {
  const n = i32(h + 37);
  const tracks = [];
  if (n >= 0 && n < 256) for (let i = 0; i < n; i++) tracks.push(i32(h + 41 + i * 4));
  return { guid: hex(h - 16, 16), tracks };
});
debug('possessables', possessables.length, 'bindings', bindings.length);

// ---- transform sections ----
const sectionClasses = new Set(['MovieScene3DTransformSection', 'MovieSceneDoubleTransformSection']);
const sections = [];
for (const e of exports) {
  const cn = exportClassName(e);
  if (!sectionClasses.has(cn)) continue;
  const r = a.parseTags(e.off, e.size);
  const isDouble = cn.includes('Double') || r.tags.some(t => t.extra === 'MovieSceneDoubleChannel');
  const chans = [];
  for (const t of r.tags) {
    if (!a.isChannelStruct(t)) continue;
    const ch = a.parseChannel(t.valueStart, t.size, t.extra === 'MovieSceneDoubleChannel' || isDouble);
    if (!ch || !ch.times.length) continue;
    chans.push({ prop: t.name, index: t.arrayIndex, ...ch });
  }
  if (!chans.length) continue;
  sections.push({ exportIndex: e.index, class: cn, trackIndex: e.outer, chans });
}

// section -> track -> binding -> possessable
const sectionOwner = new Map();
for (const s of sections) {
  for (const b of bindings) {
    if (!b.tracks.includes(s.trackIndex)) continue;
    const p = possByGuid.get(b.guid);
    if (p) sectionOwner.set(s.exportIndex, p);
    break;
  }
}
debug('sections', sections.length, 'owned', sectionOwner.size);

const rootOf = p => {
  const seen = new Set();
  let cur = p;
  while (cur && cur.parent && possByGuid.has(cur.parent) && !seen.has(cur.guid)) {
    seen.add(cur.guid);
    cur = possByGuid.get(cur.parent);
  }
  return cur || p;
};
const depthOf = p => {
  let d = 0, cur = p;
  const seen = new Set();
  while (cur && !seen.has(cur.guid)) { seen.add(cur.guid); d++; cur = cur.parent ? possByGuid.get(cur.parent) : null; }
  return d;
};

function axisChannels(s, prop) {
  return s.chans.filter(c => c.prop === prop).sort((x, y) => x.index - y.index).slice(0, 3);
}
function sampleCh(ch, t) {
  const ts = ch.times, vs = ch.values;
  if (!ts.length) return null;
  if (t <= ts[0]) return vs[0];
  if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
  const t0 = ts[lo], t1 = ts[hi];
  if (t1 === t0) return vs[lo];
  return vs[lo] + (vs[hi] - vs[lo]) * (t - t0) / (t1 - t0);
}

// 按角色 root 聚合，取层级最深的轨道作为身体位移
const groups = new Map();
for (const [si, p] of sectionOwner) {
  const s = sections.find(x => x.exportIndex === si);
  if (!s) continue;
  const root = rootOf(p);
  const g = groups.get(root.guid) || { root, animated: [] };
  g.animated.push({ poss: p, section: s, depth: depthOf(p) });
  groups.set(root.guid, g);
}

const characters = [];
for (const g of groups.values()) {
  g.animated.sort((x, y) => y.depth - x.depth);
  const best = g.animated[0];
  const s = best.section;
  const loc = axisChannels(s, 'Translation');
  const rot = axisChannels(s, 'Rotation');
  const scale = axisChannels(s, 'Scale');

  const allTimes = new Set();
  for (const c of [...loc, ...rot, ...scale]) for (const t of c.times) allTimes.add(t);
  const times = [...allTimes].sort((x, y) => x - y);
  if (!times.length) continue;

  const dur = toSec(times[times.length - 1] - times[0]);
  const maxKeys = Math.max(2, Math.ceil(dur * sampleFps) + 1);
  const step = Math.max(1, Math.ceil(times.length / maxKeys));
  const picked = [];
  for (let i = 0; i < times.length; i += step) picked.push(times[i]);
  if (picked[picked.length - 1] !== times[times.length - 1]) picked.push(times[times.length - 1]);

  const t0 = times[0];
  const vec = (arr, t) => [0, 1, 2].map(i => {
    if (!arr[i]) return null;
    const v = sampleCh(arr[i], t);
    return v == null ? null : +v.toFixed(3);
  });
  const keys = picked.map(t => ({
    s: +(toSec(t - t0)).toFixed(3),
    p: vec(loc, t),
    // UE Rotator 通道顺序为 [Roll, Pitch, Yaw]（度）
    r: vec(rot, t),
    q: vec(scale, t),
  })).filter(k => k.p.every(v => v != null) || k.r.every(v => v != null));

  const range = axis => {
    const vals = keys.map(k => k.p[axis]).filter(v => v != null && Number.isFinite(v));
    return vals.length ? [+Math.min(...vals).toFixed(1), +Math.max(...vals).toFixed(1)] : null;
  };

  characters.push({
    name: g.root.name,
    label: g.root.name,
    binding: best.poss.name,
    section: s.exportIndex,
    keyCount: keys.length,
    sourceKeys: times.length,
    duration: +dur.toFixed(3),
    range: { x: range(0), y: range(1), z: range(2) },
    keys,
  });
}

characters.sort((x, y) => y.keyCount - x.keyCount);
debug('characters', characters.length, characters.map(c => `${c.name}:${c.keyCount}`).join(' '));

const payload = JSON.stringify({
  file,
  tickResolution: tickRes,
  displayRate: a.displayRate,
  sampleFps,
  possessables: possessables.map(p => ({ name: p.name, parent: possByGuid.get(p.parent)?.name || null })),
  characters,
});
if (outFile) fs.writeFileSync(outFile, payload);
else fs.writeSync(1, payload);
