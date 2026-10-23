import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'techviz.db');
const SCENE_FILE = path.join(DATA_DIR, 'scene.json');

export const DEFAULT_SCENE_NAME = '默认方案';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  sub TEXT UNIQUE,
  name TEXT,
  email TEXT,
  role TEXT DEFAULT 'viewer',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '默认方案',
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS user_current (
  user_id TEXT PRIMARY KEY,
  scene_name TEXT NOT NULL
);
`);

/** 老库补列：登录字段随 OIDC 接入逐步扩展，避免删库重建 */
function ensureColumn(table, column, ddl) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('users', 'username', 'username TEXT');
ensureColumn('users', 'avatar_url', "avatar_url TEXT DEFAULT ''");
ensureColumn('sessions', 'oidc_id_token', 'oidc_id_token TEXT');

/** 统一用户行 → 业务对象（列名 snake_case 只在 SQL 层出现） */
function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    sub: row.sub,
    username: row.username || row.sub || row.id,
    name: row.name || row.username || row.sub || row.id,
    displayName: row.name || row.username || row.sub || row.id,
    email: row.email || '',
    avatarUrl: row.avatar_url || '',
    role: row.role || 'viewer',
  };
}

export function getUserBySub(sub) {
  return toUser(db.prepare('SELECT * FROM users WHERE sub = ?').get(sub));
}

export function getUserById(id) {
  return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

/** 按 sub 找用户，不存在则建（OIDC 首次登录即时建档）；返回业务用户对象 */
export function upsertUser({ sub, username, name, email, avatarUrl, role }) {
  const existing = db.prepare('SELECT * FROM users WHERE sub = ?').get(sub);
  if (existing) {
    db.prepare(
      `UPDATE users SET
         username = COALESCE(?, username),
         name = COALESCE(?, name),
         email = COALESCE(?, email),
         avatar_url = COALESCE(?, avatar_url),
         role = COALESCE(?, role)
       WHERE id = ?`,
    ).run(username ?? null, name ?? null, email ?? null, avatarUrl || null, role ?? null, existing.id);
    return getUserBySub(sub);
  }
  const id = `u_${randomUUID()}`;
  db.prepare(
    `INSERT INTO users (id, sub, username, name, email, avatar_url, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sub,
    username ?? sub,
    name ?? username ?? sub,
    email ?? '',
    avatarUrl ?? '',
    role ?? 'viewer',
    new Date().toISOString(),
  );
  return getUserBySub(sub);
}

/** 保证匿名开发用户在库里有记录 */
export function ensureDevUser() {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, sub, username, name, email, avatar_url, role, created_at)
     VALUES ('dev', 'dev', 'dev', '开发者', '', '', 'admin', ?)`,
  ).run(new Date().toISOString());
  return getUserById('dev');
}

// ---------- 会话（JWT jti 白名单） ----------

export function registerSession(jti, userId, expiresAtIso, oidcIdToken) {
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, oidc_id_token) VALUES (?, ?, ?, ?)').run(
    jti,
    userId,
    expiresAtIso,
    oidcIdToken ?? null,
  );
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
}

/** 按 jti 取会话（过期自动清理并返回 null） */
export function getSessionByJti(jti) {
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, s.oidc_id_token, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(jti);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    deleteSession(jti);
    return null;
  }
  return {
    jti: row.token,
    expiresAt: row.expires_at,
    oidcIdToken: row.oidc_id_token || null,
    user: toUser(row),
  };
}

export function deleteSession(jti) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(jti);
}

// ---------- OIDC 一次性 state ----------

export function saveOidcState(state, redirectUri, ttlSeconds) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.prepare('INSERT INTO oidc_states (state, redirect_uri, expires_at) VALUES (?, ?, ?)').run(
    state,
    redirectUri,
    expiresAt,
  );
  db.prepare('DELETE FROM oidc_states WHERE expires_at < ?').run(new Date().toISOString());
}

/** 消费 state（一次性）；无效或过期返回 null */
export function consumeOidcState(state) {
  const row = db.prepare('SELECT redirect_uri, expires_at FROM oidc_states WHERE state = ?').get(state);
  if (!row) return null;
  db.prepare('DELETE FROM oidc_states WHERE state = ?').run(state);
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return row.redirect_uri;
}

// ---------- 方案（按用户隔离） ----------

export function getScene(userId, name) {
  return db.prepare('SELECT * FROM scenes WHERE user_id = ? AND name = ?').get(userId, name);
}

export function upsertScene(userId, name, data) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO scenes (user_id, name, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(userId, name, data, now);
  return getScene(userId, name);
}

export function listScenes(userId) {
  return db
    .prepare(
      'SELECT name, updated_at AS updatedAt FROM scenes WHERE user_id = ? ORDER BY updated_at DESC',
    )
    .all(userId);
}

/** 用户当前方案名（未设置过时为「默认方案」） */
export function getCurrentSceneName(userId) {
  const row = db.prepare('SELECT scene_name FROM user_current WHERE user_id = ?').get(userId);
  return row ? row.scene_name : DEFAULT_SCENE_NAME;
}

export function setCurrentScene(userId, name) {
  db.prepare(
    `INSERT INTO user_current (user_id, scene_name) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET scene_name = excluded.scene_name`,
  ).run(userId, name);
}

/**
 * 新用户首次登录时初始化方案：以 dev 用户的当前方案为模板复制一份「默认方案」，
 * 保证一进工作台就能看到现有祈祷室布景；复制后两边各自独立修改。
 * 已有方案的用户不做任何处理。
 */
export function seedUserScenes(userId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE user_id = ?').get(userId).n;
  if (count > 0) return false;

  const template =
    getScene('dev', getCurrentSceneName('dev')) ||
    db.prepare('SELECT * FROM scenes ORDER BY updated_at DESC LIMIT 1').get();
  if (!template) return false;

  upsertScene(userId, DEFAULT_SCENE_NAME, template.data);
  setCurrentScene(userId, DEFAULT_SCENE_NAME);
  return true;
}

/**
 * 迁移：旧版存档 server/data/scene.json 存在且 scenes 表为空时，
 * 导入为 dev 用户的「默认方案」行；json 文件保留不删。
 * 没有历史文件时为 dev 用户初始化一个空「默认方案」。
 */
const sceneCount = db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n;
if (sceneCount === 0) {
  const dev = ensureDevUser();
  if (fs.existsSync(SCENE_FILE)) {
    try {
      const raw = fs.readFileSync(SCENE_FILE, 'utf8');
      JSON.parse(raw); // 校验是合法 JSON，坏文件不导入
      upsertScene(dev.id, DEFAULT_SCENE_NAME, raw);
      console.log('[db] 已把 server/data/scene.json 导入为 dev 用户的「默认方案」（原文件保留）');
    } catch (err) {
      console.warn('[db] scene.json 迁移失败：', String(err));
    }
  } else {
    upsertScene(dev.id, DEFAULT_SCENE_NAME, JSON.stringify(null));
    console.log('[db] 初始化 dev 用户「默认方案」');
  }
}
