import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import openidClient from 'openid-client';
import {
  upsertUser,
  createSession,
  getSession,
  deleteSession,
  ensureDevUser,
} from './db.mjs';

const { Issuer } = openidClient;

const env = process.env;
const OIDC_ISSUER = env.OIDC_ISSUER || '';
const OIDC_CLIENT_ID = env.OIDC_CLIENT_ID || '';
const OIDC_CLIENT_SECRET = env.OIDC_CLIENT_SECRET || '';
const OIDC_REDIRECT_URI = env.OIDC_REDIRECT_URI || '';
const OIDC_SCOPES = env.OIDC_SCOPES || 'openid profile email';
const BASE_URL = env.BASE_URL || 'http://localhost:5173';
const SESSION_SECRET = env.SESSION_SECRET || 'techviz-dev-secret';

export { BASE_URL, OIDC_ISSUER };

/**
 * 开发模式：未配置 OIDC_ISSUER 时自动启用（或显式 DEV_MODE=true/false 覆盖）。
 * 跳过 OIDC，所有 API 直接以匿名 dev 用户（admin）可用，保证现有工作流不中断。
 */
export const devMode =
  env.DEV_MODE != null ? /^(1|true|yes)$/i.test(env.DEV_MODE) : !OIDC_ISSUER;

export const DEV_USER = { id: 'dev', sub: 'dev', name: '开发者', email: '', role: 'admin' };

if (devMode) ensureDevUser();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'techviz_session';

/** OIDC client（懒加载 + 缓存；discover 失败时允许下次重试） */
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = Issuer.discover(OIDC_ISSUER)
      .then(
        (issuer) =>
          new issuer.Client({
            client_id: OIDC_CLIENT_ID,
            client_secret: OIDC_CLIENT_SECRET,
            redirect_uris: [OIDC_REDIRECT_URI],
            response_types: ['code'],
          }),
      )
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

/** login → callback 之间的 state/nonce（内存保存，10 分钟过期） */
const pendingStates = new Map();
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) {
    if (now - v.createdAt > 10 * 60 * 1000) pendingStates.delete(k);
  }
}, 60 * 1000);
sweep.unref();

/** cookie 签名（简单 HMAC） */
const sign = (value) => createHmac('sha256', SESSION_SECRET).update(value).digest('hex');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** 从 cookie 中取出验签通过的 session token */
function tokenFromRequest(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const token = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(token);
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return token;
}

function sessionFromRequest(req) {
  const token = tokenFromRequest(req);
  return token ? getSession(token) : null;
}

/** 登录态中间件：开发模式直接注入 dev 用户 */
export function requireAuth(req, res, next) {
  if (devMode) {
    req.user = DEV_USER;
    return next();
  }
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ code: 1, message: '未登录' });
  req.user = session.user;
  next();
}

/** 挂载 /api/auth/* 路由（需在 requireAuth 之前注册） */
export function mountAuthRoutes(app) {
  app.get('/api/auth/login', async (_req, res) => {
    if (devMode) return res.redirect(BASE_URL);
    try {
      const client = await getClient();
      const state = randomBytes(16).toString('hex');
      const nonce = randomBytes(16).toString('hex');
      pendingStates.set(state, { nonce, createdAt: Date.now() });
      res.redirect(client.authorizationUrl({ state, nonce, scope: OIDC_SCOPES }));
    } catch (err) {
      res.status(500).send(`OIDC 初始化失败：${err?.message ?? err}`);
    }
  });

  app.get('/api/auth/callback', async (req, res) => {
    if (devMode) return res.redirect(BASE_URL);
    try {
      const { code, state } = req.query;
      const pending = typeof state === 'string' ? pendingStates.get(state) : null;
      if (typeof state === 'string') pendingStates.delete(state);
      if (!code || !pending) return res.status(400).send('登录会话已过期，请重新登录');
      const client = await getClient();
      const tokenSet = await client.callback(OIDC_REDIRECT_URI, req.query, {
        state,
        nonce: pending.nonce,
        response_type: 'code',
      });
      const claims = tokenSet.claims();
      const user = upsertUser({
        sub: claims.sub,
        name: claims.preferred_username || claims.name || claims.sub,
        email: claims.email || null,
      });
      const { token } = createSession(user.id, SESSION_TTL_MS);
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${token}.${sign(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
          SESSION_TTL_MS / 1000,
        )}`,
      );
      res.redirect(BASE_URL);
    } catch (err) {
      res.status(500).send(`OIDC 回调失败：${err?.message ?? err}`);
    }
  });

  app.get('/api/auth/me', (req, res) => {
    if (devMode) {
      return res.json({
        code: 0,
        user: { sub: DEV_USER.sub, name: DEV_USER.name, email: DEV_USER.email, role: DEV_USER.role },
      });
    }
    const session = sessionFromRequest(req);
    if (!session) return res.status(401).json({ code: 1, message: '未登录' });
    const { user } = session;
    res.json({
      code: 0,
      user: { sub: user.sub, name: user.name, email: user.email, role: user.role },
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = tokenFromRequest(req);
    if (token) deleteSession(token);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ code: 0, data: null });
  });
}
