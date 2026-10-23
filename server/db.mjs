import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
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

export function getUserBySub(sub) {
  return db.prepare('SELECT * FROM users WHERE sub = ?').get(sub);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/** 按 sub 找用户，不存在则建（OIDC JIT 入库）；返回完整用户行 */
export function upsertUser({ sub, name, email, role }) {
  const existing = getUserBySub(sub);
  if (existing) {
    db.prepare(
      'UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), role = COALESCE(?, role) WHERE id = ?',
    ).run(name ?? null, email ?? null, role ?? null, existing.id);
    return getUserBySub(sub);
  }
  const id = `u_${randomUUID()}`;
  db.prepare(
    'INSERT INTO users (id, sub, name, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, sub, name ?? sub, email ?? '', role ?? 'viewer', new Date().toISOString());
  return getUserBySub(sub);
}

/** 保证开发模式匿名用户（id 固定为 dev）在库里有记录 */
export function ensureDevUser() {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, sub, name, email, role, created_at) VALUES ('dev', 'dev', '开发者', '', 'admin', ?)",
  ).run(new Date().toISOString());
  return getUserBySub('dev');
}

/** 创建会话，返回 {token, expiresAt} */
export function createSession(userId, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expiresAt,
  );
  return { token, expiresAt };
}

/** 取会话（过期自动清理并返回 null） */
export function getSession(token) {
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, u.id AS user_id, u.sub, u.name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    deleteSession(token);
    return null;
  }
  return {
    token: row.token,
    expiresAt: row.expires_at,
    user: { id: row.user_id, sub: row.sub, name: row.name, email: row.email, role: row.role },
  };
}

export function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

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
 * 迁移：旧版存档 server/data/scene.json 存在且 scenes 表为空时，
 * 导入为用户 dev 的「默认方案」行；json 文件保留不删。
 * 没有历史文件时为 dev 用户初始化一个空「默认方案」（内容为 null，前端照旧走 demo 数据）。
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
