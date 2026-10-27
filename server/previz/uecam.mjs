// uecam.mjs — offline UE5 .uasset (LevelSequence take) camera animation extractor
// Usage: node uecam.mjs <path-to-uasset>
// Read-only. Outputs JSON to stdout.
import fs from 'fs';

const file = process.argv[2];
if (!file) { console.error('usage: node uecam.mjs <uasset>'); process.exit(2); }
const buf = fs.readFileSync(file);
const SIZE = buf.length;
const u8 = o => buf[o];
const i32 = o => buf.readInt32LE(o);
const i64 = o => Number(buf.readBigInt64LE(o));
const f32 = o => buf.readFloatLE(o);
const f64 = o => buf.readDoubleLE(o);
const debug = (...a) => { if (process.env.UECAM_DEBUG) console.error(...a); };

// ---------- name table ----------
function tryParseNames(offset, count, limit) {
  let o = offset;
  const names = [];
  for (let i = 0; i < count; i++) {
    if (o + 4 > limit) return null;
    const len = i32(o);
    let s;
    if (len === 0) { s = ''; o += 4; }
    else if (len > 0) {
      if (len > 1024 || o + 4 + len > limit) return null;
      const raw = buf.subarray(o + 4, o + 4 + len);
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k];
        if (c !== 0 && (c < 0x20 || c > 0x7e)) return null;
      }
      s = raw.toString('latin1').replace(/\0+$/, '');
      o += 4 + len;
    } else {
      const n = -len;
      if (n > 1024 || o + 4 + n * 2 > limit) return null;
      const raw = buf.subarray(o + 4, o + 4 + n * 2);
      s = raw.toString('utf16le').replace(/\0+$/, '');
      o += 4 + n * 2;
    }
    o += 4; // hash (uint32)
    names.push(s);
  }
  return { names, end: o };
}

function findNameTable() {
  let best = null;
  for (let p = 4; p < 8192; p++) {
    const count = i32(p), off = i32(p + 4);
    if (count < 8 || count > 300000) continue;
    if (off < 64 || off > SIZE - 16) continue;
    if (off <= p) continue;
    const r = tryParseNames(off, count, SIZE);
    if (!r) continue;
    if (!best || count > best.count) best = { count, off, names: r.names, end: r.end, pairOffset: p };
  }
  return best;
}

// ---------- export table ----------
function validExportEntry(o) {
  const name = i32(o + 16), num = i32(o + 20);
  const sz = i64(o + 28), off = i64(o + 36);
  const cls = i32(o), outer = i32(o + 12);
  if (name < 0 || name >= nameCount) return null;
  if (num < 0 || num > 1000000) return null;
  if (Math.abs(cls) > 200000 || Math.abs(outer) > 200000) return null;
  if (!(sz >= 0 && sz <= SIZE) || !(off >= 0 && off + sz <= SIZE)) return null;
  return { cls, outer, name, num, size: sz, off };
}
let nameCount = 0;
// Locate the (ExportCount, ExportOffset, ImportCount, ImportOffset) quadruple that
// precedes the tables. Import table is laid out immediately before the export table.
function findTableSet(names) {
  nameCount = names.length;
  const candidates = [];
  // 头部字段存在非 4 字节对齐的情况（不同保存路径会整体错位 1~3 字节），
  // 因此这里按字节步进扫描四元组，避免漏掉 export/import 表。
  for (let p = 8; p + 16 <= SIZE; p += 1) {
    const ec = i32(p), eo = i32(p + 4), ic = i32(p + 8), io = i32(p + 12);
    if (ec < 1 || ec > 200000) continue;
    if (ic < 0 || ic > 200000) continue;
    if (eo <= 0 || io <= 0) continue;
    if (eo + ec * 112 > SIZE) continue;
    if (io + ic * 40 > SIZE) continue;
    const gap = eo - (io + ic * 40);
    if (gap < 0 || gap > 8192) continue;
    if (!validExportEntry(eo) || !validExportEntry(eo + (ec - 1) * 112)) continue;
    if (ic > 0 && (!validImportEntry(io, names) || !validImportEntry(io + (ic - 1) * 40, names))) continue;
    candidates.push({ exportCount: ec, exportOffset: eo, importCount: ic, importOffset: io, pairOffset: p, gap });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.gap - b.gap) || (b.exportCount - a.exportCount));
  return candidates[0];
}

// ---------- import table ----------
function validImportEntry(o, names) {
  const cp = i32(o), cn = i32(o + 8), outer = i32(o + 16), on = i32(o + 20);
  const pn = i32(o + 28), opt = i32(o + 36);
  if (cp < 0 || cp >= names.length) return null;
  if (cn < 0 || cn >= names.length) return null;
  if (on < 0 || on >= names.length) return null;
  if (pn < 0 || pn >= names.length) return null;
  if (outer < -100000 || outer > 100000) return null;
  return { classPackage: names[cp], className: names[cn], outer, objectName: names[on],
           packageName: names[pn], optional: opt };
}
// ---------- property tags ----------
function parseTags(dataStart, dataSize) {
  const end = dataStart + dataSize;
  let p = dataStart + 1; // exports start with one zero byte
  const tags = [];
  let guard = 0;
  while (p + 8 <= end && guard++ < 100000) {
    const nameIdx = i32(p), nameNum = i32(p + 4);
    const name = nameName(nameIdx);
    p += 8;
    if (name === 'None') return { tags, end: p, ok: end - p <= 8 };
    if (p + 8 > end) break;
    const type = nameName(i32(p));
    p += 8;
    if (p + 4 > end) break;
    const sizeHint = i32(p); p += 4;
    let extra = '';
    if (type === 'StructProperty') {
      extra = nameName(i32(p)); p += 8;
      p += 16; // struct guid / reserved
    } else if (type === 'ArrayProperty' || type === 'SetProperty') {
      extra = nameName(i32(p)); p += 8 + 4;
    } else if (type === 'MapProperty') {
      extra = nameName(i32(p)) + '->' + nameName(i32(p + 8)); p += 16 + 4;
    } else if (type === 'ByteProperty' || type === 'EnumProperty') {
      extra = nameName(i32(p)); p += 8;
    } else if (type === 'BoolProperty') {
      p += 1;
    }
    if (p + 5 > end) break;
    const size = i32(p); p += 4;
    const flags = u8(p); p += 1;
    let arrayIndex = 0;
    if (flags & 0x01) { arrayIndex = i32(p); p += 4; }
    if (flags & 0x02) { p += 16; } // property guid
    const valueStart = p;
    tags.push({ name, nameNum, type, extra, sizeHint, size, flags, arrayIndex, valueStart });
    if (size < 0 || valueStart + size > end) { debug('tag overrun', name, size); break; }
    p = valueStart + size;
  }
  return { tags, end: p, ok: false };
}

// ---------- movie scene channels ----------
// FMovieSceneFloatChannel / FMovieSceneDoubleChannel
function parseChannel(start, size, isDouble) {
  try {
    const pre = u8(start), post = u8(start + 1);
    const frameSize = i32(start + 2);
    if (frameSize !== 4) { debug('unexpected frame size', frameSize); }
    const nTimes = i32(start + 6);
    if (nTimes < 0 || nTimes > 200000) return null;
    const times = new Array(nTimes);
    let o = start + 10;
    for (let i = 0; i < nTimes; i++) { times[i] = i32(o); o += 4; }
    const elemSize = i32(o); o += 4;
    const nValues = i32(o); o += 4;
    if (nValues < 0 || nValues > 200000) return null;
    if (elemSize <= 0 || elemSize > 256) return null;
    const values = new Array(Math.min(nValues, nTimes));
    for (let i = 0; i < values.length; i++) {
      const vp = o + i * elemSize;
      values[i] = isDouble ? f64(vp) : f32(vp);
    }
    const afterValues = o + nValues * elemSize;
    let defaultValue = null, hasDefault = null;
    if (afterValues + (isDouble ? 8 : 4) <= start + size) {
      defaultValue = isDouble ? f64(afterValues) : f32(afterValues);
      const b = afterValues + (isDouble ? 8 : 4);
      hasDefault = i32(b);
    }
    return { pre, post, times, values, elemSize, nValues, defaultValue, hasDefault, bytes: start + size - start };
  } catch (e) { return null; }
}

function isChannelStruct(t) {
  return t.type === 'StructProperty' &&
    (t.extra === 'MovieSceneFloatChannel' || t.extra === 'MovieSceneDoubleChannel');
}

// ---------- main ----------
const nt = findNameTable();
if (!nt) { console.error('cannot locate name table'); process.exit(1); }
let nameList = nt.names;
function nameName(idx) { return (idx >= 0 && idx < nameList.length) ? nameList[idx] : ('#' + idx); }
nameCount = nameList.length;

debug('nameTable', JSON.stringify({ count: nt.count, off: nt.off, end: nt.end, pairOffset: nt.pairOffset }));
const ts = findTableSet(nameList);
if (!ts) { console.error('cannot locate export/import tables'); process.exit(1); }
debug('tableSet', JSON.stringify(ts));
const et = { offset: ts.exportOffset, count: ts.exportCount };
const imports = ts.importCount ? { offset: ts.importOffset, count: ts.importCount } : null;

const exports = [];
for (let i = 0; i < et.count; i++) {
  const o = et.offset + i * 112;
  const e = validExportEntry(o);
  if (!e) break;
  exports.push({ index: i, ...e, objectName: nameName(e.name) });
}
function exportClassName(e) {
  if (e.cls < 0 && imports) {
    const imp = validImportEntry(imports.offset + (-e.cls - 1) * 40, nameList);
    if (imp) return imp.objectName;
  }
  if (e.cls > 0 && exports[e.cls - 1]) return exports[e.cls - 1].objectName;
  return '#' + e.cls;
}
function outerName(e) {
  if (e.outer < 0 && imports) {
    const imp = validImportEntry(imports.offset + (-e.outer - 1) * 40, nameList);
    if (imp) return imp.objectName;
  }
  if (e.outer > 0 && exports[e.outer - 1]) return exports[e.outer - 1].objectName;
  return null;
}

const sectionClasses = new Set(['MovieScene3DTransformSection', 'MovieSceneDoubleTransformSection',
  'MovieSceneFloatSection', 'MovieSceneDoubleSection']);
if (process.env.UECAM_DEBUG) {
  for (const e of exports) debug('exp', e.index, e.objectName, 'cls', e.cls, '->', exportClassName(e),
    'outer', e.outer, '->', outerName(e), 'size', e.size, 'off', e.off);
}
const keysMeta = { tickResolution: null, displayRate: null, timeUnit: 'tick',
  firstTick: null, lastTick: null, durationSeconds: null };

// Some struct values (e.g. FFrameRate) are serialized as a nested FPropertyTag chain
// instead of a flat payload, so scan for the tag and walk the inner chain.
function scanFrameRateTag(exp, propIdx) {
  if (propIdx < 0) return null;
  const noneIdx = nameList.indexOf('None');
  const structIdx = nameList.indexOf('StructProperty');
  const numIdx = nameList.indexOf('Numerator');
  const denIdx = nameList.indexOf('Denominator');
  const end = exp.off + exp.size;
  for (let o = exp.off; o + 60 < end; o++) {
    if (i32(o) !== propIdx || i32(o + 4) !== 0) continue;
    if (i32(o + 8) !== structIdx) continue;
    let p = o + 49; // name(8) type(8) hint(4) structName(8) guid(16) size(4) flags(1)
    let num = null, den = null;
    for (let g = 0; g < 8 && p + 25 < end; g++) {
      const n = i32(p);
      if (n === noneIdx) break;
      const size = i32(p + 20), v = p + 25;
      if (size < 0 || v + size > end) break;
      if (n === numIdx) num = i32(v);
      else if (n === denIdx) den = i32(v);
      p = v + size;
    }
    if (num !== null) return { numerator: num, denominator: den == null ? 1 : den };
  }
  return null;
}

const movieSceneExport = exports.find(e => exportClassName(e) === 'MovieScene');
if (movieSceneExport) {
  keysMeta.tickResolution = scanFrameRateTag(movieSceneExport, nameList.indexOf('TickResolution'));
  keysMeta.displayRate = scanFrameRateTag(movieSceneExport, nameList.indexOf('DisplayRate'));
}

const sections = [];
if (process.env.UECAM_DEBUG) {
  for (const e of exports) {
    const cn = exportClassName(e);
    if (!/SceneComponent|CineCamera|ActorRecorderPropertyMap/.test(cn)) continue;
    const r = parseTags(e.off, e.size);
    debug('tags', e.index, e.objectName, cn, JSON.stringify(r.tags.map(t => ({
      n: t.name, t: t.type, extra: t.extra, size: t.size,
      d: t.type === 'StructProperty' ? [0, 1, 2].map(i => +f64(t.valueStart + i * 8).toFixed(3)) : null,
    }))));
  }
}
for (const e of exports) {
  const cn = exportClassName(e);
  if (!sectionClasses.has(cn)) continue;
  const r = parseTags(e.off, e.size);
  const chans = [];
  const isDouble = cn.includes('Double') ||
    r.tags.some(t => t.extra === 'MovieSceneDoubleChannel');
  for (const t of r.tags) {
    if (!isChannelStruct(t)) continue;
    const ch = parseChannel(t.valueStart, t.size, t.extra === 'MovieSceneDoubleChannel' || isDouble);
    if (!ch) continue;
    chans.push({ prop: t.name, index: t.arrayIndex, ...ch });
  }
  // order channels: known order by UE convention
  const order = { Translation: 0, Rotation: 3, Scale: 6 };
  chans.sort((a, b) => {
    const oa = (order[a.prop] ?? 9) + a.index, ob = (order[b.prop] ?? 9) + b.index;
    return oa - ob;
  });
  const quaternion = r.tags.some(t => /quaternion/i.test(t.name) && t.size > 0 && t.type === 'BoolProperty');
  sections.push({
    exportIndex: e.index, export: e.objectName, class: cn, parentTrack: outerName(e),
    tags: r.tags.map(t => ({ name: t.name, type: t.type, extra: t.extra, size: t.size, index: t.arrayIndex })),
    channels: chans, quaternion
  });
}

// summarize
if (process.env.UECAM_DEBUG) for (const s of sections) {
  debug('section', s.exportIndex, s.class, 'tags', JSON.stringify(s.tags.map(t => `${t.name}${t.index ? '[' + t.index + ']' : ''}:${t.type}:${t.size}`)));
  for (const c of s.channels) debug('  ch', c.prop, c.index, 'n', c.times.length,
    't', c.times[0], '..', c.times[c.times.length - 1],
    'v', c.values[0], '..', c.values[c.values.length - 1], 'elem', c.elemSize, 'default', c.defaultValue);
}
const sectionSummaries = sections.map(s => {
  const chans = s.channels;
  const keyCounts = chans.map(c => c.times.length);
  const maxKeys = keyCounts.length ? Math.max(...keyCounts) : 0;
  const firstLoc = chans.filter(c => c.prop === 'Translation').slice(0, 3).map(c => c.values[0] ?? null);
  const firstRot = chans.filter(c => c.prop === 'Rotation').slice(0, 3).map(c => c.values[0] ?? null);
  const firstScale = chans.filter(c => c.prop === 'Scale').slice(0, 3).map(c => c.values[0] ?? null);
  const times = chans.flatMap(c => [c.times[0], c.times[c.times.length - 1]]).filter(v => typeof v === 'number');
  const summary = {
    export: s.export, exportIndex: s.exportIndex, class: s.class, parentTrack: s.parentTrack,
    channelCount: chans.length, keyCount: maxKeys,
    channelNames: chans.map(c => `${c.prop}[${c.index}]:${c.times.length}`),
    timeRange: times.length ? [Math.min(...times), Math.max(...times)] : null,
    firstLocation: firstLoc, firstRotation: firstRot, firstScale: firstScale,
    quaternion: s.quaternion
  };
  if (!/TransformSection/.test(s.class)) {
    const props = floatSectionProperty(s);
    if (props.length) summary.property = props.join(',');
  }
  return summary;
});

// choose main transform section: the transform section with the most total keys
function totalKeys(s) { return s.channels.reduce((a, c) => a + c.times.length, 0); }
const transformSections = sections.filter(s => /TransformSection/.test(s.class));
const main = transformSections.slice().sort((a, b) => totalKeys(b) - totalKeys(a))[0] || null;

function channelsOf(s, prop) {
  return s.channels.filter(c => c.prop === prop).sort((a, b) => a.index - b.index);
}
// returns the constant value of a channel, or null when it actually animates
function isConstant(ch) {
  if (!ch || !ch.values.length) return null;
  const v0 = ch.values[0];
  return ch.values.every(v => Math.abs(v - v0) < 1e-9) ? v0 : null;
}
// the property path lives on the parent track (e.g. FocusSettings.ManualFocusDistance)
function floatSectionProperty(s) {
  const secExp = exports[s.exportIndex];
  const track = secExp && secExp.outer > 0 ? exports[secExp.outer - 1] : null;
  if (!track) return [];
  const found = new Set();
  const end = track.off + track.size;
  for (let o = track.off; o + 4 <= end; o += 4) {
    const n = nameName(i32(o));
    if (/FocalLength|FocusDistance/.test(n)) found.add(n);
  }
  return [...found];
}
// FStrings of the MovieScene binding tags (spawnable / possessable display names)
function bindingNames(exp) {
  const nameIdx = nameList.indexOf('Name'), strIdx = nameList.indexOf('StrProperty');
  const found = [];
  const end = exp.off + exp.size;
  for (let o = exp.off; o + 30 < end; o++) {
    if (i32(o) !== nameIdx || i32(o + 4) !== 0 || i32(o + 8) !== strIdx || i32(o + 12) !== 0) continue;
    const v = o + 25, len = i32(v);
    if (len <= 0 || len > 200 || v + 4 + len > end) continue;
    const str = buf.subarray(v + 4, v + 4 + len).toString('latin1').replace(/\0+$/, '');
    if (str.length >= 3 && /^[ -~]+$/.test(str)) found.push(str);
  }
  return found;
}

// interpolate / evaluate channel at arbitrary time
function sampleChannel(ch, t) {
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

// Some takes carry no translation/rotation channels at all: the camera is static and its
// pose only exists on the spawnable template (SceneComponent.RelativeLocation /
// CameraComponent.RelativeRotation). Read that static pose so those shots are not dropped.
function templateStaticPose() {
  // SceneComponent carries the camera mount, CineCameraComponent the lens rig.
  // UE Rotator is (Pitch, Yaw, Roll) while transform channels are [Roll, Pitch, Yaw].
  let loc = null, mount = null, cam = null;
  for (const e of exports) {
    const cn = exportClassName(e);
    if (cn !== 'SceneComponent' && cn !== 'CineCameraComponent') continue;
    const r = parseTags(e.off, e.size);
    for (const t of r.tags) {
      const isVec = t.type === 'StructProperty' && t.extra === 'Vector' && t.size >= 24;
      const isRot = t.type === 'StructProperty' && t.extra === 'Rotator' && t.size >= 24;
      if (!isVec && !isRot) continue;
      const v = [f64(t.valueStart), f64(t.valueStart + 8), f64(t.valueStart + 16)]
        .map(x => Number.isFinite(x) ? +x.toFixed(4) : null);
      if (!v.every(x => x !== null)) continue;
      if (t.name === 'RelativeLocation' && isVec && cn === 'SceneComponent' && !loc) loc = v;
      if (t.name === 'RelativeRotation' && isRot) {
        const euler = [v[2], v[0], v[1]]; // Roll, Pitch, Yaw
        if (cn === 'SceneComponent') mount = euler; else cam = euler;
      }
    }
  }
  const rot = (mount || cam)
    ? [0, 1, 2].map(i => +((mount ? mount[i] : 0) + (cam ? cam[i] : 0)).toFixed(4))
    : null;
  debug('templateStaticPose', JSON.stringify({ loc, mount, cam }));
  return { loc, rot };
}

let keys = [];
const poseSource = { location: null, rotation: null, scale: null, valueProperty: null };
let valueChannel = null, valueProperty = null;
if (main) {
  // Take recorder can split the camera over two sections: the actor carries the
  // location while its CameraComponent carries the rotation. Pick the section that
  // actually animates each component instead of assuming a single section holds both.
  const pick = arr => arr.slice().sort((a, b) => totalKeys(b) - totalKeys(a))[0] || null;
  const locSource = pick(transformSections.filter(s =>
    channelsOf(s, 'Translation').some(c => isConstant(c) === null))) || main;
  const rotSource = pick(transformSections.filter(s =>
    channelsOf(s, 'Rotation').some(c => isConstant(c) === null))) || main;
  const locCh = channelsOf(locSource, 'Translation');
  const scaleCh = channelsOf(locSource, 'Scale');
  const rotCh = channelsOf(rotSource, 'Rotation');
  poseSource.location = locSource.exportIndex;
  poseSource.rotation = rotSource.exportIndex;
  poseSource.scale = locSource.exportIndex;

  // Float/Double section (focus distance or focal length)
  for (const s of sections) {
    if (!/FloatSection|DoubleSection/.test(s.class) || /TransformSection/.test(s.class)) continue;
    const c = s.channels.find(c => /Curve|Channel/i.test(c.prop)) || s.channels[0];
    if (!c) continue;
    valueChannel = c;
    const props = floatSectionProperty(s);
    valueProperty = props.length ? props.join(',') : c.prop;
    poseSource.valueProperty = valueProperty;
    break;
  }

  const timeSet = new Set();
  for (const arr of [locCh, rotCh, scaleCh]) for (const c of arr) for (const t of c.times) timeSet.add(t);
  if (valueChannel) for (const t of valueChannel.times) timeSet.add(t);
  const times = [...timeSet].sort((a, b) => a - b);
  const rate = keysMeta.tickResolution;
  const toSec = t => rate && rate.numerator ? +(t * rate.denominator / rate.numerator).toFixed(6) : null;
  const first = times.length ? times[0] : 0;
  const vec = (arr, t) => [0, 1, 2].map(i => {
    if (!arr[i]) return null;
    const v = sampleChannel(arr[i], t);
    return v == null ? null : +v.toFixed(4);
  });
  // Channels that are entirely missing fall back to the template's static pose.
  const fallback = templateStaticPose();
  const vecOr = (arr, t, fb) => {
    const v = vec(arr, t);
    if (v.every(x => x != null)) return v;
    if (!fb) return v;
    return v.map((x, i) => (x != null ? x : fb[i]));
  };
  poseSource.staticPose = !times.length && !!fallback.loc;
  keys = times.map(t => {
    const raw = valueChannel ? sampleChannel(valueChannel, t) : null;
    const v = raw == null ? null : +raw.toFixed(4);
    return {
      time: t,
      seconds: toSec(t - first),
      loc: vecOr(locCh, t, fallback.loc),
      rot: vecOr(rotCh, t, fallback.rot),
      scale: vec(scaleCh, t),
      focal: /FocalLength/i.test(valueProperty || '') ? v : null,
      focusDistance: /FocusDistance/i.test(valueProperty || '') ? v : null
    };
  });
  // No channels at all (static take): emit one key so the shot still has a pose.
  if (!keys.length && (fallback.loc || fallback.rot)) {
    keys = [{ time: 0, seconds: 0, loc: fallback.loc, rot: fallback.rot, scale: null, focal: null, focusDistance: null }];
    poseSource.staticPose = true;
  }
  keysMeta.firstTick = times.length ? times[0] : (keys.length ? 0 : null);
  keysMeta.lastTick = times.length ? times[times.length - 1] : (keys.length ? 0 : null);
  keysMeta.durationSeconds = times.length ? toSec(times[times.length - 1] - first) : (keys.length ? 0 : null);
}


// spawn section / spawnable names
const spawnables = [];
for (const e of exports) {
  const cn = exportClassName(e);
  if (!/Spawn/.test(cn)) continue;
  const r = parseTags(e.off, e.size);
  spawnables.push({ export: e.objectName, exportIndex: e.index, class: cn, parentTrack: outerName(e),
    tags: r.tags.map(t => ({ name: t.name, type: t.type, extra: t.extra, size: t.size })) });
}
// readable names inside the sequence (binding names + custom bindings)
const bindingList = movieSceneExport ? bindingNames(movieSceneExport) : [];
const spawnableNames = new Set(bindingList);
for (const e of exports) {
  if (/CustomBinding|SpawnableActorBinding/.test(exportClassName(e))) spawnableNames.add(e.objectName);
}

function rangeOf(field, axis) {
  const vals = keys.map(k => axis == null ? k[field] : (k[field] || [])[axis])
    .filter(v => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? [+Math.min(...vals).toFixed(4), +Math.max(...vals).toFixed(4)] : null;
}
const checks = {
  keyCount: keys.length,
  timeMonotonic: keys.every((k, i) => i === 0 || k.time > keys[i - 1].time),
  timeUnit: 'tick',
  tickResolution: keysMeta.tickResolution,
  displayRate: keysMeta.displayRate,
  locationFinite: keys.every(k => !k.loc || k.loc.every(v => v === null || Number.isFinite(v))),
  locationAllZero: keys.every(k => !k.loc || k.loc.every(v => v === null || Math.abs(v) < 1e-6)),
  locationRangeXYZ: [0, 1, 2].map(i => rangeOf('loc', i)),
  rotationRangeXYZ: [0, 1, 2].map(i => rangeOf('rot', i)),
  scaleRangeXYZ: [0, 1, 2].map(i => rangeOf('scale', i)),
  focalRange: rangeOf('focal'),
  focusDistanceRange: rangeOf('focusDistance')
};

const out = {
  file,
  class: exports.length ? (() => {
    const root = exports.find(e => /LevelSequence/.test(exportClassName(e)));
    return root ? exportClassName(root) : exportClassName(exports[0]);
  })() : null,
  meta: keysMeta,
  mainSection: main ? { exportIndex: main.exportIndex, class: main.class, parentTrack: main.parentTrack } : null,
  poseSource,
  tracks: sectionSummaries,
  checks,
  keys,
  spawn: spawnables,
  spawnableNames: [...spawnableNames].slice(0, 40)
};
process.stdout.write(JSON.stringify(out, null, 1));
