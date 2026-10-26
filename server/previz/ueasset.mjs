// ueasset.mjs — UE5 .uasset 只读解析基础能力（name table / 导入导出表 / 属性标签 / 动画通道）
import fs from 'fs';

export function loadAsset(file) {
  const buf = fs.readFileSync(file);
  const SIZE = buf.length;
  const u8 = o => buf[o];
  const i32 = o => buf.readInt32LE(o);
  const i64 = o => Number(buf.readBigInt64LE(o));
  const f32 = o => buf.readFloatLE(o);
  const f64 = o => buf.readDoubleLE(o);

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
        s = buf.subarray(o + 4, o + 4 + n * 2).toString('utf16le').replace(/\0+$/, '');
        o += 4 + n * 2;
      }
      o += 4; // hash
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
      // 有些资产会命中大量空串的伪表，按非空名字数量择优
      const nonEmpty = r.names.reduce((n, s) => n + (s && s.length > 1 ? 1 : 0), 0);
      if (nonEmpty < 8) continue;
      const cand = { count, off, names: r.names, end: r.end, pairOffset: p, nonEmpty };
      if (!best || nonEmpty > best.nonEmpty || (nonEmpty === best.nonEmpty && count > best.count)) best = cand;
    }
    return best;
  }

  const nt = findNameTable();
  if (!nt) throw new Error('cannot locate name table: ' + file);
  const nameList = nt.names;
  const nameCount = nameList.length;
  const nameName = idx => (idx >= 0 && idx < nameList.length) ? nameList[idx] : ('#' + idx);

  function validImportEntry(o) {
    const cp = i32(o), cn = i32(o + 8), outer = i32(o + 16), on = i32(o + 20);
    const pn = i32(o + 28), opt = i32(o + 36);
    if (cp < 0 || cp >= nameList.length) return null;
    if (cn < 0 || cn >= nameList.length) return null;
    if (on < 0 || on >= nameList.length) return null;
    if (pn < 0 || pn >= nameList.length) return null;
    if (outer < -100000 || outer > 100000) return null;
    return { classPackage: nameList[cp], className: nameList[cn], outer, objectName: nameList[on],
             packageName: nameList[pn], optional: opt };
  }

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

  function findTableSet() {
    const candidates = [];
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
      if (ic > 0 && (!validImportEntry(io) || !validImportEntry(io + (ic - 1) * 40))) continue;
      candidates.push({ exportCount: ec, exportOffset: eo, importCount: ic, importOffset: io, gap });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.gap - b.gap) || (b.exportCount - a.exportCount));
    return candidates[0];
  }

  // ---------- property tags ----------
  function parseTags(dataStart, dataSize) {
    const end = dataStart + dataSize;
    let p = dataStart + 1;
    const tags = [];
    let guard = 0;
    while (p + 8 <= end && guard++ < 200000) {
      const nameIdx = i32(p), nameNum = i32(p + 4);
      const name = nameName(nameIdx);
      p += 8;
      if (name === 'None') return { tags, end: p, ok: true };
      if (p + 8 > end) break;
      const type = nameName(i32(p));
      p += 8;
      if (p + 4 > end) break;
      const sizeHint = i32(p); p += 4;
      let extra = '';
      if (type === 'StructProperty') {
        extra = nameName(i32(p)); p += 8;
        p += 16;
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
      if (flags & 0x02) { p += 16; }
      const valueStart = p;
      tags.push({ name, nameNum, type, extra, sizeHint, size, flags, arrayIndex, valueStart });
      if (size < 0 || valueStart + size > end) break;
      p = valueStart + size;
    }
    return { tags, end: p, ok: false };
  }

  // ---------- movie scene channels ----------
  function parseChannel(start, size, isDouble) {
    try {
      const pre = u8(start), post = u8(start + 1);
      const frameSize = i32(start + 2);
      if (frameSize !== 4) return null;
      const nTimes = i32(start + 6);
      if (nTimes < 0 || nTimes > 500000) return null;
      const times = new Array(nTimes);
      let o = start + 10;
      for (let i = 0; i < nTimes; i++) { times[i] = i32(o); o += 4; }
      const elemSize = i32(o); o += 4;
      const nValues = i32(o); o += 4;
      if (nValues < 0 || nValues > 500000) return null;
      if (elemSize <= 0 || elemSize > 256) return null;
      const values = new Array(Math.min(nValues, nTimes));
      for (let i = 0; i < values.length; i++) {
        const vp = o + i * elemSize;
        values[i] = isDouble ? f64(vp) : f32(vp);
      }
      return { pre, post, times, values, elemSize, nValues };
    } catch (e) { return null; }
  }

  const isChannelStruct = t => t.type === 'StructProperty' &&
    (t.extra === 'MovieSceneFloatChannel' || t.extra === 'MovieSceneDoubleChannel');

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
      let p = o + 49;
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

  // ---------- exports ----------
  const ts = findTableSet();
  if (!ts) throw new Error('cannot locate export/import tables: ' + file);
  const exports = [];
  for (let i = 0; i < ts.exportCount; i++) {
    const e = validExportEntry(ts.exportOffset + i * 112);
    if (!e) break;
    exports.push({ index: i, ...e, objectName: nameName(e.name) });
  }
  function exportClassName(e) {
    if (e.cls < 0) {
      const imp = validImportEntry(ts.importOffset + (-e.cls - 1) * 40);
      if (imp) return imp.objectName;
    }
    if (e.cls > 0 && exports[e.cls - 1]) return exports[e.cls - 1].objectName;
    return '#' + e.cls;
  }
  const outerExport = e => (e.outer > 0 && exports[e.outer - 1]) ? exports[e.outer - 1] : null;
  const imports = [];
  for (let i = 0; i < ts.importCount; i++) {
    const imp = validImportEntry(ts.importOffset + i * 40);
    if (!imp) break;
    imports.push({ index: i, ...imp });
  }
  const movieScene = exports.find(e => exportClassName(e) === 'MovieScene') || null;

  // FString 读取（长度为正=ANSI，为负=UTF16）
  function readFString(o, limit = SIZE) {
    if (o + 4 > limit) return null;
    const len = i32(o);
    if (len > 0 && len < 2048 && o + 4 + len <= limit) return buf.subarray(o + 4, o + 4 + len).toString('latin1').replace(/\0+$/, '');
    if (len < 0 && len > -2048 && o + 4 - len * 2 <= limit) return buf.subarray(o + 4, o + 4 - len * 2).toString('utf16le').replace(/\0+$/, '');
    return null;
  }

  return {
    file, buf, SIZE, u8, i32, i64, f32, f64, nameList, nameName,
    exports, imports, exportClassName, outerExport, parseTags, parseChannel,
    isChannelStruct, scanFrameRateTag, readFString, movieScene,
    tickResolution: movieScene ? scanFrameRateTag(movieScene, nameList.indexOf('TickResolution')) : null,
    displayRate: movieScene ? scanFrameRateTag(movieScene, nameList.indexOf('DisplayRate')) : null,
  };
}
