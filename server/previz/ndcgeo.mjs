#!/usr/bin/env node
// ndcgeo.mjs — read-only UE5 .uasset (nDisplay / StaticMesh) geometry dumper
// Usage:
//   node ndcgeo.mjs --ndc <NDC_Led_01.uasset> --da <DA_Led_01.uasset> --meshdir <.../Mesh> --out <out.json>
//   node ndcgeo.mjs --ndc <file> --dump "ExportName"          # verbose property tree of one export
//   node ndcgeo.mjs --mesh <vp_h1_1.uasset>                   # mesh bounds only
import fs from 'node:fs';
import path from 'node:path';

const TAG = 0x9e2a83c1;

class Reader {
  constructor(buf, pos = 0) { this.b = buf; this.o = pos; }
  u8() { return this.b[this.o++]; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i64() { const v = Number(this.b.readBigInt64LE(this.o)); this.o += 8; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v; }
  skip(n) { this.o += n; }
  guid() { const a = this.u32(), b = this.u32(), c = this.u32(), d = this.u32(); return [a, b, c, d]; }
  fstring() {
    const n = this.i32();
    if (n === 0) return '';
    if (n > 0) { const s = this.b.subarray(this.o, this.o + n).toString('latin1').replace(/\0+$/, ''); this.o += n; return s; }
    const s = this.b.subarray(this.o, this.o + -n * 2).toString('utf16le').replace(/\0+$/, ''); this.o += -n * 2; return s;
  }
  // FName as stored in package data (index + number)
  fname(names) { const i = this.i32(); const n = this.i32(); return { i, n, s: names ? (names[i] ?? `#${i}`) : `#${i}` }; }
}

const PROP_TYPES = new Set(['StructProperty', 'ArrayProperty', 'ObjectProperty', 'IntProperty', 'FloatProperty', 'DoubleProperty',
  'BoolProperty', 'ByteProperty', 'EnumProperty', 'NameProperty', 'StrProperty', 'TextProperty', 'MapProperty', 'SetProperty',
  'Int64Property', 'Int8Property', 'Int16Property', 'UInt16Property', 'UInt32Property', 'UInt64Property', 'SoftObjectProperty',
  'SoftClassProperty', 'ClassProperty', 'InterfaceProperty', 'DelegateProperty', 'MulticastDelegateProperty', 'FieldPathProperty',
  'ObjectPtrProperty', 'OptionalProperty', 'WeakObjectProperty', 'LazyObjectProperty']);

class Package {
  constructor(file) {
    this.file = file;
    this.buf = fs.readFileSync(file);
    this.b = this.buf;
    this.warnings = [];
    this.parse();
  }

  // ---- locate header pieces without hard-coded offsets -------------------
  parse() {
    const b = this.buf;
    if (b.length < 64 || b.readUInt32LE(0) !== TAG) throw new Error('not a UE package: ' + this.file);
    const r = new Reader(b, 4);
    const legacy = r.i32();
    if (legacy !== -4) r.i32();                    // LegacyUE3Version
    const v4 = r.i32();
    const v5 = legacy <= -6 ? r.i32() : 0;
    if (legacy <= -7) r.i32();                     // FileVersionLicenseeUE4/5
    this.versions = { legacy, v4, v5 };
    const prefixEnd = r.o;

    // --- Name table: scan a small window for (NameCount, NameOffset) ---
    let found = null;
    for (let p = prefixEnd; p <= Math.min(prefixEnd + 4096, b.length - 8); p++) {
      const count = b.readInt32LE(p), off = b.readInt32LE(p + 4);
      if (count < 4 || count > 500000 || off < 16 || off >= b.length) continue;
      const cand = this.tryNames(off, count);
      if (cand) { found = { ...cand, fieldPos: p, count, off }; break; }
    }
    if (!found) throw new Error('name table not found');
    this.nameCount = found.count;
    this.nameOffset = found.off;
    this.names = found.names;
    this.namesEnd = found.end;
    // name-number suffix map (UE displays Foo_2 for index 1)
    this.nameFieldPos = found.fieldPos;

    // --- Export / Import tables: scan for valid (Count, Offset) pairs ----
    const searchEnd = Math.min(this.nameOffset, b.length - 8);
    const exps = [], imps = [];
    for (let p = this.nameFieldPos + 8; p <= searchEnd; p++) {
      const ec = b.readInt32LE(p), eo = b.readInt32LE(p + 4);
      const e = this.tryExports(ec, eo);
      if (e) exps.push({ p, ec, eo, e });
      const ic = b.readInt32LE(p), io = b.readInt32LE(p + 4);
      const im = this.tryImports(ic, io);
      if (im) imps.push({ p, ic, io, im });
    }
    this.buf = b;
    this.rawExports = exps.length ? exps[0] : null;
    this.rawImports = imps.length ? imps[0] : null;
    if (!this.rawExports || !this.rawImports) throw new Error('export/import table not found');
    // prefer the largest plausible table if several
    const bestExp = exps.reduce((a, c) => (c.ec > (a?.ec ?? 0) ? c : a), null);
    const bestImp = imps.reduce((a, c) => (c.ic > (a?.ic ?? 0) ? c : a), null);
    this.imports = bestImp.im.map((im) => ({ ...im, name: this.displayName(im.nameIdx, im.nameNum) }));
    this.importCount = bestImp.ic; this.importOffset = bestImp.io;
    this.exports = bestExp.e.map((e) => ({ ...e, name: this.displayName(e.nameIdx, e.nameNum), className: this.className(e.classIdx) }));
    this.exportCount = bestExp.ec; this.exportOffset = bestExp.eo;
    if (exps.length > 1) this.warnings.push(`multiple export-table candidates: ${exps.map((x) => x.ec + '@' + x.eo).join(',')}`);
    if (imps.length > 1) this.warnings.push(`multiple import-table candidates: ${imps.map((x) => x.ic + '@' + x.io).join(',')}`);
  }

  tryNames(off, count) {
    const b = this.buf;
    const names = [];
    let o = off;
    for (let i = 0; i < count; i++) {
      if (o + 4 > b.length) return null;
      const n = b.readInt32LE(o);
      const bytes = n > 0 ? n : -n * 2;
      if (n === 0) return null;
      if (bytes > 1024 || bytes < 1) return null;
      const e = o + 4 + bytes;
      if (e + 4 > b.length) return null;
      let s;
      if (n > 0) s = b.subarray(o + 4, o + 4 + n).toString('latin1').replace(/\0+$/, '');
      else s = b.subarray(o + 4, o + 4 + -n * 2).toString('utf16le').replace(/\0+$/, '');
      if (!s) return null;
      if (n > 0 && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return null;
      names.push(s);
      o = e + 4;
    }
    // a real name table is contiguous and followed by something; require plausible
    return { names, end: o };
  }

  tryExports(count, off) {
    const b = this.buf;
    if (count < 1 || count > 50000) return null;
    if (off <= this.namesEnd || off + count * 112 > b.length) return null;
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = off + i * 112;
      const classIdx = b.readInt32LE(o);
      const outerIdx = b.readInt32LE(o + 12);
      const nameIdx = b.readInt32LE(o + 16);
      const nameNum = b.readInt32LE(o + 20);
      const serialSize = Number(b.readBigInt64LE(o + 28));
      const serialOffset = Number(b.readBigInt64LE(o + 36));
      if (nameIdx < 0 || nameIdx >= this.nameCount) return null;
      if (nameNum < 0 || nameNum > 1000) return null;
      if (serialSize < 0 || serialOffset < this.namesEnd || serialOffset + serialSize > b.length) return null;
      if (outerIdx < -this.importCount - count || outerIdx > count) return null;
      out.push({ i, classIdx, outerIdx, nameIdx, nameNum, serialSize, serialOffset });
    }
    return out;
  }

  tryImports(count, off) {
    const b = this.buf;
    if (count < 1 || count > 50000) return null;
    if (off <= this.namesEnd || off + count * 40 > b.length) return null;
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = off + i * 40;
      const classPkg = b.readInt32LE(o), className = b.readInt32LE(o + 8);
      const outer = b.readInt32LE(o + 16);
      const nameIdx = b.readInt32LE(o + 20), nameNum = b.readInt32LE(o + 24);
      if (className < 0 || className >= this.nameCount) return null;
      if (nameIdx < 0 || nameIdx >= this.nameCount) return null;
      if (nameNum < 0 || nameNum > 1000) return null;
      out.push({ i, classPkg, classNameIdx: className, outer, nameIdx, nameNum });
    }
    return out;
  }

  displayName(idx, num) { const s = this.names[idx] ?? `#${idx}`; return num > 0 ? `${s}_${num + 1}` : s; }

  className(classIdx) {
    if (classIdx === 0) return 'Class';
    if (classIdx > 0) return this.exports?.[classIdx - 1] ? `export:${this.exports[classIdx - 1].name}` : `export#${classIdx}`;
    const im = this.imports?.[-classIdx - 1];
    return im ? (this.names[im.classNameIdx] ?? `import#${-classIdx}`) : `import#${-classIdx}`;
  }

  objectRef(v) {
    if (!v) return null;
    if (v > 0) return this.exports[v - 1]?.name ?? null;
    const im = this.imports[-v - 1];
    if (!im) return null;
    return im.name;
  }

  // ---- tag chain -------------------------------------------------------
  // UE 5.8 (LegacyFileVersion -9) writes FPropertyTag with an FPropertyTypeName tree
  // instead of the old flat FName + StructName layout.  The exact header length varies
  // with the type tree, so instead of hard-coding it we search for the int32 size field
  // and validate candidates by requiring the payload to be followed by another valid
  // tag (or by the export end).  Struct payloads are recursive tag chains for USTRUCTs
  // and raw little-endian doubles for native math structs (Vector/Rotator/...).
  isNoneTag(pos) {
    if (pos < 0 || pos + 8 > this.buf.length) return false;
    const i = this.buf.readInt32LE(pos), n = this.buf.readInt32LE(pos + 4);
    return n === 0 && this.names[i] === 'None';
  }

  looksLikeTag(pos) {
    if (pos < 0 || pos + 16 > this.buf.length) return false;
    if (this.isNoneTag(pos)) return true;
    const ni = this.buf.readInt32LE(pos);
    if (ni < 0 || ni >= this.nameCount) return false;
    const ti = this.buf.readInt32LE(pos + 8);
    if (ti < 0 || ti >= this.nameCount) return false;
    return PROP_TYPES.has(this.names[ti]);
  }

  parseTagChain(start, end, depth = 0) {
    this._memo ??= new Set();
    const key = `${start}:${end}:${depth}`;
    if (start > end) return null;
    if (start === end) return { tags: [], end };
    if (this._memo.has(key)) return null;
    if (this.isNoneTag(start)) {
      const at = start + 8;
      if (at === end) return { tags: [], end: at };
      if (at < end) { const rest = this.parseTagChain(at, end, depth); if (rest) return rest; }
      this._memo.add(key);
      return null;
    }
    if (!this.looksLikeTag(start)) { this._memo.add(key); return null; }
    const name = { i: this.buf.readInt32LE(start), n: this.buf.readInt32LE(start + 4) };
    const type = { i: this.buf.readInt32LE(start + 8), n: this.buf.readInt32LE(start + 12) };
    const nameS = this.names[name.i], typeS = this.names[type.i];
    const headEnd = start + 16;
    const maxHead = Math.min(start + 120, end - 4);
    for (let sp = headEnd; sp <= maxHead; sp++) {
      const size = this.buf.readInt32LE(sp);
      if (size < 0) continue;
      for (const flagLen of [1, 0]) {
        const vs = sp + 4 + flagLen;
        const ve = vs + size;
        if (ve > end || vs > end) continue;
        const node = { name: this.displayName(name.i, name.n), type: typeS, size };
        if (typeS === 'StructProperty') {
          if (size === 0) continue;
          let nested = null;
          if (depth < 8) nested = this.parseTagChain(vs, ve, depth + 1);
          if (nested && nested.end === ve && nested.tags.length > 0) {
            node.children = nested.tags;
          } else {
            node.raw = this.decodeRaw(vs, size);
            if (node.raw === null) continue;
          }
        } else if (typeS === 'ArrayProperty') {
          const n = vs + 4 <= ve ? this.buf.readInt32LE(vs) : 0;
          if (n < 0 || n > 10000000 || 4 + n > size + 1) continue;
          node.arrayCount = n;
          if (vs + 4 + n * 4 === ve) {
            node.refs = [];
            for (let k = 0; k < n; k++) node.refs.push(this.objectRef(this.buf.readInt32LE(vs + 4 + k * 4)));
          }
        } else if (typeS === 'ObjectProperty' || typeS === 'ClassProperty' || typeS === 'ObjectPtrProperty' || typeS === 'WeakObjectProperty') {
          if (size !== 4 && size !== 8) continue;
          const v = this.buf.readInt32LE(vs);
          node.ref = this.objectRef(v);
          node.rawValue = v;
        } else if (typeS === 'SoftObjectProperty' || typeS === 'SoftClassProperty') {
          if (size < 8) continue;
          node.value = this.readStringAt(vs);
        } else if (typeS === 'IntProperty' || typeS === 'UInt32Property') {
          if (size !== 4) continue;
          node.value = this.buf.readInt32LE(vs);
        } else if (typeS === 'Int64Property' || typeS === 'UInt64Property') {
          if (size !== 8) continue;
          node.value = Number(this.buf.readBigInt64LE(vs));
        } else if (typeS === 'Int8Property' || typeS === 'ByteProperty') {
          if (size !== 1) continue;
          node.value = this.buf[vs];
        } else if (typeS === 'FloatProperty') {
          if (size !== 4) continue;
          node.value = this.buf.readFloatLE(vs);
        } else if (typeS === 'DoubleProperty') {
          if (size !== 8) continue;
          node.value = this.buf.readDoubleLE(vs);
        } else if (typeS === 'BoolProperty') {
          if (size > 1) continue;
          node.value = size === 1 ? this.buf[vs] !== 0 : true;
        } else if (typeS === 'NameProperty' || typeS === 'StrProperty' || typeS === 'TextProperty') {
          const s = this.readStringAt(vs);
          if (s === null && size > 0) continue;
          node.value = s;
        } else if (typeS === 'EnumProperty') {
          if (size !== 1 && size !== 4) continue;
          node.value = size === 1 ? this.buf[vs] : this.buf.readInt32LE(vs);
        } else {
          continue;
        }
        if (ve === end) return { tags: [node], end: ve };
        if (this.looksLikeTag(ve)) {
          const rest = this.parseTagChain(ve, end, depth);
          if (rest) return { tags: [node, ...rest.tags], end: rest.end };
        }
      }
    }
    this._memo.add(key);
    return null;
  }

  decodeRaw(vs, size) {
    const b = this.buf;
    if (size === 24) return [b.readDoubleLE(vs), b.readDoubleLE(vs + 8), b.readDoubleLE(vs + 16)];
    if (size === 12) return [b.readFloatLE(vs), b.readFloatLE(vs + 4), b.readFloatLE(vs + 8)];
    if (size === 56) return [0, 8, 16, 24, 32, 40, 48].map((k) => b.readDoubleLE(vs + k));
    if (size === 16 || size === 32) return null;
    if (size === 8) return [b.readDoubleLE(vs)];
    if (size === 4) return [b.readFloatLE(vs)];
    return null;
  }

  readStringAt(o) {
    if (o + 4 > this.buf.length) return null;
    const n = this.buf.readInt32LE(o);
    if (n > 0 && n < 2000000 && o + 4 + n <= this.buf.length) return this.buf.subarray(o + 4, o + 4 + n).toString('latin1').replace(/\0+$/, '');
    return null;
  }

  probeExportTags(exp) {
    // The export payload starts with a single byte before the tag chain in this UE build.
    const end = exp.serialOffset + exp.serialSize;
    let best = null;
    for (const delta of [1, 0, 2, 3, 4]) {
      const tags = this.parseTagChain(exp.serialOffset + delta, end);
      if (!tags) continue;
      const near = tags.end >= end - 8;
      const score = (near ? 1e6 : 0) + tags.tags.length;
      if (!best || score > best.score) best = { delta, tags, score };
    }
    return best;
  }

  findExportByName(name) {
    return this.exports.find((e) => e.name === name) || this.exports.find((e) => e.name.startsWith(name));
  }

  embeddedJson() {
    const txt = this.buf.toString('latin1');
    const key = '{"nDisplay"';
    let idx = txt.indexOf(key);
    if (idx < 0) return null;
    // choose the occurrence inside an export payload if possible
    let i = idx, inStr = false, esc = false, depth = 0, end = -1;
    for (; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
      if (c === 34) { inStr = true; continue; }
      if (c === 123) depth++;
      else if (c === 125) { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) return null;
    const raw = this.buf.subarray(idx, end).toString('utf8');
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { this.warnings.push('embedded JSON parse failed: ' + e.message); }
    return { offset: idx, bytes: end - idx, json };
  }
}

// ---------------------------------------------------------------------------
// nDisplay JSON -> geometry summary
function summarizeConfig(json) {
  const n = json.nDisplay ?? json;
  const nodes = n.cluster?.nodes ?? {};
  const xforms = n.scene?.xforms ?? {};
  const nodeList = Object.entries(nodes).map(([id, nd]) => {
    const vps = Object.entries(nd.viewports ?? {}).map(([vid, vp]) => ({
      id: vid,
      camera: vp.camera,
      region: vp.region,
      bufferRatio: vp.bufferRatio,
      projection: vp.projectionPolicy?.type,
      meshComponent: vp.projectionPolicy?.parameters?.mesh_component,
      screenId: vp.projectionPolicy?.parameters?.screen_id ?? null,
    }));
    return { id, host: nd.host, window: nd.window, viewports: vps };
  });
  return {
    version: n.version,
    assetPath: n.assetPath,
    primaryNode: n.cluster?.primaryNode?.id,
    nodeCount: nodeList.length,
    nodes: nodeList,
    xforms: Object.entries(xforms).map(([id, x]) => ({ id, parentId: x.parentId, location: x.location, rotation: x.rotation })),
    screens: n.scene?.screens,
    cameras: n.scene?.cameras,
  };
}

// ---------------------------------------------------------------------------
// StaticMesh geometry: the nDisplay config only stores which mesh a viewport
// uses, so the real panel size/position is the mesh's own ExtendedBounds.
// Layout (measured): tag "ExtendedBounds"(StructProperty) -> 1 flag byte ->
// nested tags "Origin"/"BoxExtent"(StructProperty, size 24) -> 1 flag byte ->
// three little-endian doubles = FVector (LWC).  SphereRadius is a double.
function meshBounds(pkg) {
  const b = pkg.buf, names = pkg.names;
  const eb = names.indexOf('ExtendedBounds');
  const originTag = names.indexOf('Origin'), extentTag = names.indexOf('BoxExtent'), radiusTag = names.indexOf('SphereRadius');
  if (eb < 0) return null;
  const readVecAt = (tagIdx, from) => {
    for (let t = from; t < Math.min(from + 200, b.length - 16); t++) {
      if (b.readInt32LE(t) !== tagIdx || b.readInt32LE(t + 4) !== 0) continue;
      for (let k = t + 16; k < Math.min(t + 120, b.length - 32); k++) {
        if (b.readInt32LE(k) !== 24) continue;
        const vs = k + 5; // size(4) + hasGuid(1)
        const v = [b.readDoubleLE(vs), b.readDoubleLE(vs + 8), b.readDoubleLE(vs + 16)];
        if (v.every((x) => Number.isFinite(x) && Math.abs(x) < 1e7)) return v;
      }
    }
    return null;
  };
  for (let i = 0; i < b.length - 16; i++) {
    if (b.readInt32LE(i) !== eb || b.readInt32LE(i + 4) !== 0) continue;
    const origin = readVecAt(originTag, i + 16), extent = readVecAt(extentTag, i + 16);
    if (!origin || !extent) continue;
    let sphere = null;
    for (let t = 0; t < b.length - 8 && sphere === null; t++) {
      if (b.readInt32LE(t) !== radiusTag || b.readInt32LE(t + 4) !== 0) continue;
      for (let k = t + 16; k < Math.min(t + 120, b.length - 12); k++) {
        if (b.readInt32LE(k) !== 8) continue;
        const d = b.readDoubleLE(k + 5);
        if (d > 0 && d < 1e7) { sphere = d; break; }
      }
    }
    return { origin, extent, sphere };
  }
  return null;
}

function readMeshDir(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^vp_.*\.uasset$/i.test(x)).sort()) {
    const pkg = new Package(path.join(dir, f));
    const bounds = meshBounds(pkg);
    out.push({ file: f, name: f.replace(/\.uasset$/i, ''), ...(bounds ?? {}), parsed: !!bounds, versions: pkg.versions });
  }
  return out;
}

// Kasa algebraic circle fit: x^2+y^2 = A*x + B*y + C
function solve3(M) {
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j < 4; j++) M[r][j] -= k * M[c][j];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

function fitCircle(pts) {
  const n = pts.length;
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sxz += x * z; Syz += y * z; Sz += z;
  }
  const sol = solve3([[Sxx, Sxy, Sx, Sxz], [Sxy, Syy, Sy, Syz], [Sx, Sy, n, Sz]]);
  if (!sol) return null;
  const [A, B, C] = sol;
  const cx = A / 2, cy = B / 2;
  const R = Math.sqrt(C + cx * cx + cy * cy);
  const residual = Math.max(...pts.map(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - R)));
  return { cx, cy, R, residual };
}

const deg = (r) => (r * 180) / Math.PI;
const r3 = (v) => +v.toFixed(3);
const r2 = (v) => +v.toFixed(2);

// ---------------------------------------------------------------------------
// Ring derivation from the 24 wall panels (h*) and 22 ceiling tiles (d*)
function deriveGeometry(meshes) {
  const h = meshes.filter((m) => m.name.startsWith('vp_h') && m.origin && m.extent);
  const d = meshes.filter((m) => m.name.startsWith('vp_d') && m.origin && m.extent);
  if (!h.length) return { note: 'no vp_h meshes parsed' };

  // one center per unique XY (each column has an upper/lower panel)
  const cols = new Map();
  for (const m of h) {
    const key = `${m.origin[0].toFixed(2)},${m.origin[1].toFixed(2)}`;
    if (!cols.has(key)) cols.set(key, { xy: [m.origin[0], m.origin[1]], z: [], panels: [] });
    const c = cols.get(key);
    c.z.push(m.origin[2]);
    c.panels.push(m.name);
  }
  const colList = [...cols.values()];
  const fit = fitCircle(colList.map((c) => c.xy));

  // angular footprint of each column from its AABB corners (flat panel, so the
  // footprint is the angular span of the four corners around the ring center)
  for (const c of colList) {
    const m = h.find((x) => x.name === c.panels[0]);
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      corners.push(deg(Math.atan2(m.origin[1] + sy * m.extent[1] - fit.cy, m.origin[0] + sx * m.extent[0] - fit.cx)));
    }
    const lo = Math.min(...corners), hi = Math.max(...corners);
    c.angle = deg(Math.atan2(c.xy[1] - fit.cy, c.xy[0] - fit.cx));
    c.footprint = [r2(lo), r2(hi)];
    c.widthM = r3(Math.hypot(m.extent[0], m.extent[1]) * 2 / 100);
    c.heightM = r3((Math.max(...c.z) + m.extent[2] - (Math.min(...c.z) - m.extent[2])) / 100);
    c.files = c.panels;
  }
  colList.sort((a, b) => a.angle - b.angle);
  const zLo = Math.min(...h.map((m) => m.origin[2] - m.extent[2]));
  const zHi = Math.max(...h.map((m) => m.origin[2] + m.extent[2]));
  const angles = colList.map((c) => r2(c.angle));
  const spacings = angles.slice(1).map((a, i) => r2(a - angles[i]));
  const arcDeg = colList.length ? Math.max(...colList.map((c) => c.footprint[1])) - Math.min(...colList.map((c) => c.footprint[0])) : 0;
  const gaps = colList.slice(1).map((c, i) => r2(c.footprint[0] - colList[i].footprint[1]));
  const panelW = colList.map((c) => c.widthM);
  const rows = new Set(h.map((m) => r2(m.origin[2])));
  const rowHeights = [...rows].sort((a, b) => a - b).map((z) => ({
    zM: r3(z / 100),
    panelHeightM: r3((h.filter((m) => r2(m.origin[2]) === z)[0].extent[2] * 2) / 100),
  }));
  const ceil = d.length ? {
    zM: r3(d[0].origin[2] / 100),
    tiles: d.length,
    extentM: {
      minX: r3(Math.min(...d.map((m) => m.origin[0] - m.extent[0])) / 100),
      maxX: r3(Math.max(...d.map((m) => m.origin[0] + m.extent[0])) / 100),
      minY: r3(Math.min(...d.map((m) => m.origin[1] - m.extent[1])) / 100),
      maxY: r3(Math.max(...d.map((m) => m.origin[1] + m.extent[1])) / 100),
    },
  } : null;

  const R = fit.R / 100, cx = fit.cx, cy = fit.cy;
  const note = [
    'nDisplay 配置(ConfigExport 内嵌 JSON)只保存节点/视口/投影(Mesh→vp_*)，不含 Size/Position；',
    '几何取自 Mesh/vp_*.uasset 的 ExtendedBounds.Origin/BoxExtent（UE cm，网格就地建模，已是环屏世界坐标）。',
    `12 个 h 立柱 AABB 中心做最小二乘圆拟合：圆心 (${r3(cx)}, ${r3(cy)}) cm，半径 ${r3(R)} m，最大拟合残差 ${r3(fit.residual)} cm。`,
    `直径 = 2R = ${r3(2 * R)} m；每列中心角 ${angles[0]}°…${angles[angles.length - 1]}°，相邻间隔 ${Math.min(...spacings)}~${Math.max(...spacings)}°。`,
    `面板角度跨度取每个 AABB 四角相对圆心的角度区间并集 = ${r2(arcDeg)}°（≈${Math.round(arcDeg / 90) * 90}°，缺 ${r2(360 - arcDeg)}° 开口）；弧长 = R×弧度 = ${r3(R * arcDeg * Math.PI / 180)} m。`,
    `板宽(对角) ${Math.min(...panelW)}~${Math.max(...panelW)} m；两排中心 z = ${rowHeights.map((r) => r.zM).join(' / ')} m，板高 ${rowHeights.map((r) => r.panelHeightM).join(' / ')} m → 总高 ${r3((zHi - zLo) / 100)} m（底边 z=${r3(zLo / 100)} m，无重叠，上下排拼接）。`,
    `原点/圆心 = (${r3(cx / 100)}, ${r3(cy / 100)}, 0) m（UE Z-up，环屏底边 z=${r3(zLo / 100)} m，顶板 z=${ceil ? ceil.zM : 'n/a'} m）。`,
  ].join('');

  return {
    radiusM: r3(R),
    diameterM: r3(2 * R),
    arcDeg: r2(arcDeg),
    arcLengthM: r3(R * arcDeg * Math.PI / 180),
    panelWidthM: [Math.min(...panelW), Math.max(...panelW)],
    panelHeightM: [r3(Math.min(...h.map((m) => (m.extent[2] * 2) / 100))), r3(Math.max(...h.map((m) => (m.extent[2] * 2) / 100)))],
    panelRows: rows.size,
    rowHeights,
    totalHeightM: r3((zHi - zLo) / 100),
    zRangeM: [r3(zLo / 100), r3(zHi / 100)],
    originM: { x: r3(cx / 100), y: r3(cy / 100), z: 0 },
    columns: colList.map((c) => ({ id: c.panels[0].replace('vp_', ''), angleDeg: r2(c.angle), footprintDeg: c.footprint, xyM: [r3(c.xy[0] / 100), r3(c.xy[1] / 100)], files: c.files })),
    __cols: colList,
    spacingsDeg: spacings,
    maxGapDeg: gaps.length ? Math.max(...gaps) : 0,
    circleFitResidualCm: r3(fit.residual),
    ceiling: ceil,
    note,
  };
}

function meshNaming(meshes) {
  const h = meshes.filter((m) => m.name.startsWith('vp_h'));
  const d = meshes.filter((m) => m.name.startsWith('vp_d'));
  const groups = {};
  for (const m of meshes) {
    const g = m.name.match(/^vp_([hd]\d+)_(\d+)$/);
    if (g) (groups[g[1]] ??= []).push(+g[2]);
  }
  return {
    count: meshes.length, wall: h.length, ceiling: d.length,
    groups,
    rule: 'vp_<h|d><group>_<index>.uasset：h=竖立环屏板（h1..h6，每组 1/3/5/7 共 4 块 = 2 列×上下 2 排，1、5 上排 z=5.76m，3、7 下排 z=1.728m），d=顶部水平封板（d1..d5 每组 4 块，沿 X 由 -6.535/-2.503/2.105/6.713m 排列；d6 仅 2 块，X=10.169m，沿 Y 补边）。共 46 个网格 = 24 立面 + 22 顶板。',
  };
}

function buildReport({ ndcPath, daPath, meshDir }) {
  const pkg = new Package(ndcPath);
  const emb = pkg.embeddedJson();
  const cfg = emb?.json ? summarizeConfig(emb.json) : null;
  const meshes = meshDir ? readMeshDir(meshDir) : [];
  const derived = deriveGeometry(meshes);
  delete derived.__cols;

  const meshIdx = new Map();
  for (const m of meshes) { meshIdx.set(m.name, m); meshIdx.set(m.name.replace('vp_', ''), m); }
  const displayDevices = [];
  if (cfg) {
    for (const nd of cfg.nodes) {
      for (const vp of nd.viewports) {
        const key = vp.meshComponent ?? vp.id;
        const m = meshIdx.get(key) ?? meshIdx.get(vp.id) ?? null;
        const isWall = !!m && m.name.startsWith('vp_h');
        const angle = isWall && derived.radiusM ? deg(Math.atan2(m.origin[1] / 100 - derived.originM.y, m.origin[0] / 100 - derived.originM.x)) : null;
        displayDevices.push({
          name: vp.id,
          node: nd.id,
          host: nd.host,
          mesh: vp.meshComponent,
          size: m ? { x: r3((m.extent[0] * 2) / 100), y: r3((m.extent[1] * 2) / 100), z: r3((m.extent[2] * 2) / 100) } : null,
          sizeKind: 'StaticMesh ExtendedBounds AABB (曲面斜置时取 derived.panelWidthM 作为真实板宽)',
          position: m ? { x: r3(m.origin[0] / 100), y: r3(m.origin[1] / 100), z: r3(m.origin[2] / 100) } : null,
          rotation: m ? { pitch: 0, yaw: angle === null ? 0 : r2(angle), roll: 0 } : null,
          assignedScreens: [],
          assignedCamera: vp.camera,
          region: vp.region,
          projectionPolicy: vp.projection,
          projected: m ? 'mesh_vp_exact' : 'missing_mesh',
        });
      }
    }
  }

  return {
    source: path.basename(ndcPath),
    sourcePath: ndcPath,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    schema: 'nDisplay LED wall geometry (UE5.8 VersatileNDisplay)',
    units: { ue: 'cm', derived: 'm', angles: 'deg (0=+X, CCW positive, Z-up)' },
    config: cfg && {
      version: cfg.version,
      embeddedJsonBytes: emb.bytes,
      jsonOffset: emb.offset,
      nodes: cfg.nodeCount,
      primaryNode: cfg.primaryNode,
      viewports: displayDevices.length,
      projectionPolicies: [...new Set(displayDevices.map((d) => d.projectionPolicy))],
      screens: cfg.screens,
      cameras: Object.keys(cfg.cameras ?? {}),
      hasDisplayDevicesField: false,
      searchedFields: {
        'cluster.nodes': 'found (46)',
        displayDevices: 'not present in config JSON',
        AssignedScreens: 'not present (scene.screens = {})',
        'Size / Position / Transform': 'not present in config; geometry comes from StaticMesh ExtendedBounds',
        BasicDisplayDevice: 'only as a Blueprint component name in NDC_Led_01.uasset (export #143), no payload',
        StageGeometry: 'only as a Blueprint component name (export #145)',
      },
    },
    cluster: cfg && { nodes: cfg.nodes, allNodes: cfg.nodes.map((n) => n.id), xforms: cfg.xforms },
    displayDevices,
    derived: {
      ...derived,
      confidence: {
        level: derived.radiusM ? 'high' : 'low',
        basis: 'nDisplay ConfigExport JSON(46 节点/46 视口, projection=Mesh) + 46 个 vp_*.uasset 的 ExtendedBounds（Origin/BoxExtent）',
        items: {
          diameter: '由 12 个立面列中心做圆拟合，残差见 circleFitResidualCm',
          height: '由每块板 BoxExtent.Z×2 与上下两排中心 z 直接得出（非估算）',
          arc: '由各列 AABB 四角相对圆心的角度并集得出',
          origin: '圆拟合圆心（与网格原点一致，BP 组件相对位移仅 d 系列 X+0.195m）',
        },
      },
    },
    meshes: meshDir ? {
      dir: meshDir,
      ...meshNaming(meshes),
      parsed: meshes.filter((m) => m.parsed).length,
      bounds: meshes.map((m) => ({
        file: m.file,
        originCm: m.origin?.map((v) => r2(v)) ?? null,
        extentCm: m.extent?.map((v) => r2(v)) ?? null,
        sphereCm: m.sphere ? r2(m.sphere) : null,
      })),
    } : null,
    assets: {
      ndc: ndcPath,
      da: daPath ?? null,
      daNote: daPath ? 'DA_Led_01.uasset 仅 2 个导出/25 个名字：LedStaticMesh(SoftObject)、LedBackground、LedPosition、LedDebug + VersatileNDisplayConfig，无几何字段（payload 129B，tag 链未完整解出，legacy=-8）' : null,
      projectContentNdcDir: (() => {
        const d = 'D:/Ver_Projects/P4_Projects/PROJ_THEHAKIMDYXNPS_0806_QiDaoShi_A000A/Content/NDC';
        return { path: d, exists: fs.existsSync(d) };
      })(),
    },
  };
}

export { Package, summarizeConfig, Reader, meshBounds, deriveGeometry, buildReport };

if (process.argv[1] && process.argv[1].endsWith('ndcgeo.mjs')) {
  const argv = process.argv.slice(2);
  const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  const dump = arg('dump');
  const mesh = arg('mesh');
  const ndc = arg('ndc');
  const meshDir = arg('meshdir');
  const out = arg('out');
  if (mesh) {
    const p = new Package(mesh);
    console.log(JSON.stringify({ file: mesh, versions: p.versions, bounds: meshBounds(p) }, null, 1));
  } else if (ndc && dump) {
    const p = new Package(ndc);
    const e = p.findExportByName(dump);
    if (!e) { console.error('export not found'); process.exit(1); }
    const probe = p.probeExportTags(e);
    console.log(JSON.stringify({ export: e, delta: probe?.delta, tags: probe?.tags }, null, 1));
  } else if (ndc) {
    const report = buildReport({ ndcPath: ndc, daPath: arg('da'), meshDir });
    const txt = JSON.stringify(report, null, 1);
    if (out) { fs.writeFileSync(out, txt); console.error('written', out, txt.length, 'bytes'); }
    else console.log(txt);
  } else {
    console.error('usage: --ndc <NDC.uasset> [--meshdir <Mesh>] [--da <DA.uasset>] [--out <json>]');
    console.error('       --ndc <file> --dump <ExportName> | --mesh <vp_x.uasset>');
  }
}
