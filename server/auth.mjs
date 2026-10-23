import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  upsertUser,
  registerSession,
  getSessionByJti,
  deleteSession,
  ensureDevUser,
  saveOidcState,
  consumeOidcState,
  seedUserScenes,
} from './db.mjs';

/**
 * 登录对接（OIDC 授权码流程），实现口径与 VerPD 保持一致：
 *   1. 本服务生成一次性 state 落库，返回第三方 authorize_url
 *   2. 浏览器整页跳转到认证中心
 *   3. 认证中心回调站点根路径（携带 code/state），前端把 code/state 交回本服务
 *   4. 本服务消费 state → 用 code 换 token → 取 userinfo
 *   5. 按 sub 查找/创建本地用户 → 签发本系统自己的 JWT（HS256）
 *
 * 登录态：JWT 自校验 + 服务端会话白名单（jti），退出登录后旧 token 立即失效。
 * 第三方 token 不落前端，只把 id_token 存在服务端会话里，供退出时拼第三方登出地址。
 */

function readString(name, fallback = '') {
  const raw = process.env[name];
  return (raw ?? '').trim() || fallback;
}

function readBool(name, fallback) {
  const raw = readString(name).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`环境变量 ${name} 需为布尔值（true/false），当前为 "${raw}"`);
}

function readPositiveInt(name, fallback) {
  const raw = readString(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`环境变量 ${name} 需为正整数，当前为 "${raw}"`);
  }
  return parsed;
}

const jwtAlgorithm = readString('JWT_ALGORITHM', 'HS256');
if (jwtAlgorithm !== 'HS256') {
  throw new Error(`当前仅支持 JWT_ALGORITHM=HS256，当前为 "${jwtAlgorithm}"`);
}

export const authEnabled = readBool('AUTH_REQUIRED', false);

export const authConfig = {
  enabled: authEnabled,
  jwtSecretKey: readString('JWT_SECRET_KEY'),
  jwtAlgorithm,
  jwtExpireSeconds: readPositiveInt('JWT_EXPIRE_SECONDS', 7 * 24 * 60 * 60),
  oidc: {
    clientId: readString('OIDC_CLIENT_ID'),
    clientSecret: readString('OIDC_CLIENT_SECRET'),
    discoveryUrl: readString('OIDC_DISCOVERY_URL'),
    redirectUri: readString('OIDC_REDIRECT_URI'),
    scope: readString('OIDC_SCOPE', 'openid email profile'),
    stateTtlSeconds: readPositiveInt('OIDC_STATE_TTL_SECONDS', 300),
    verifySsl: readBool('OIDC_VERIFY_SSL', true),
    discoveryCacheSeconds: readPositiveInt('OIDC_DISCOVERY_CACHE_SECONDS', 600),
    changePasswordUrl: readString('OIDC_CHANGE_PASSWORD_URL'),
  },
};

const REQUIRED_OIDC_KEYS = [
  ['clientId', 'OIDC_CLIENT_ID'],
  ['clientSecret', 'OIDC_CLIENT_SECRET'],
  ['discoveryUrl', 'OIDC_DISCOVERY_URL'],
  ['redirectUri', 'OIDC_REDIRECT_URI'],
];

export function getMissingOidcConfigKeys() {
  return REQUIRED_OIDC_KEYS.filter(([field]) => !authConfig.oidc[field]).map(([, envName]) => envName);
}

export const isOidcConfigured = () => getMissingOidcConfigKeys().length === 0;

/** 未开启登录门禁时使用的匿名用户，保证本地开发工作流不中断 */
export const DEV_USER = {
  id: 'dev',
  sub: 'dev',
  username: 'dev',
  displayName: '开发者',
  avatarUrl: '',
  email: '',
  role: 'admin',
};

if (!authEnabled) ensureDevUser();

/** 与 kmoke4 / VerPD 对齐的认证错误码 */
const AUTH_ERROR_CODES = {
  400: 'PARAM_ERROR',
  401: 'UNAUTHORIZED',
  4011: 'TOKEN_EXPIRED',
  4012: 'TOKEN_INVALID',
  403: 'PERMISSION_DENIED',
  500: 'SYSTEM_ERROR',
  502: 'EXTERNAL_SERVICE_ERROR',
};

export class AuthError extends Error {
  constructor(message, code = 500) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }

  get httpStatus() {
    return this.code === 4011 || this.code === 4012 ? 401 : this.code;
  }
}

function toErrorPayload(error) {
  if (error instanceof AuthError) {
    return {
      status: error.httpStatus,
      body: { code: error.code, error: AUTH_ERROR_CODES[error.code], message: error.message },
    };
  }
  return {
    status: 500,
    body: { code: 500, error: AUTH_ERROR_CODES[500], message: error instanceof Error ? error.message : '未知错误' },
  };
}

/** 极简 JSON HTTP 客户端：按请求控制 TLS 校验（对应 OIDC_VERIFY_SSL） */
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

function requestJson(url, options = {}) {
  const { method = 'GET', headers = {}, form, verifySsl = true, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = options;
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? https : http;

  const requestHeaders = { Accept: 'application/json', ...headers };
  let body = '';
  if (form) {
    body = new URLSearchParams(form).toString();
    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    requestHeaders['Content-Length'] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: requestHeaders,
        ...(isHttps ? { rejectUnauthorized: verifySsl } : {}),
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status} ${url} ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`响应不是合法 JSON：${url}`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let discoveryCache = null;

async function fetchDiscoveryDocument() {
  const missing = getMissingOidcConfigKeys();
  if (missing.length > 0) {
    throw new AuthError(`OIDC 基础配置不完整，缺少：${missing.join(', ')}`, 500);
  }
  const now = Date.now();
  if (discoveryCache && discoveryCache.expiresAt > now) return discoveryCache.document;

  try {
    const document = await requestJson(authConfig.oidc.discoveryUrl, {
      verifySsl: authConfig.oidc.verifySsl,
    });
    discoveryCache = {
      document,
      expiresAt: now + authConfig.oidc.discoveryCacheSeconds * 1000,
    };
    console.log(
      `[auth] OIDC discovery 已加载：authorization_endpoint=${document.authorization_endpoint} ` +
        `token_endpoint=${document.token_endpoint} userinfo_endpoint=${document.userinfo_endpoint}`,
    );
    return document;
  } catch (error) {
    discoveryCache = null;
    console.error(`[auth] OIDC discovery 请求失败：${String(error)}`);
    throw new AuthError('无法加载 OIDC discovery 文档，请检查 OIDC_DISCOVERY_URL 与网络', 502);
  }
}

/** 生成第三方授权地址，并把一次性 state 落库 */
async function createAuthorizeUrl({ prompt } = {}) {
  const redirectUri = authConfig.oidc.redirectUri;
  if (!redirectUri) throw new AuthError('OIDC 回调地址未配置（OIDC_REDIRECT_URI）', 500);

  const normalizedPrompt = (prompt || '').trim();
  if (normalizedPrompt && normalizedPrompt !== 'none') {
    throw new AuthError('OIDC prompt 参数不合法，当前仅支持 none', 400);
  }

  const discovery = await fetchDiscoveryDocument();
  if (!discovery.authorization_endpoint) {
    throw new AuthError('OIDC discovery 文档缺少 authorization_endpoint', 500);
  }

  const state = randomBytes(48).toString('base64url');
  saveOidcState(state, redirectUri, authConfig.oidc.stateTtlSeconds);

  const target = new URL(discovery.authorization_endpoint);
  target.searchParams.set('response_type', 'code');
  target.searchParams.set('client_id', authConfig.oidc.clientId);
  target.searchParams.set('redirect_uri', redirectUri);
  target.searchParams.set('scope', authConfig.oidc.scope);
  target.searchParams.set('state', state);
  if (normalizedPrompt) target.searchParams.set('prompt', normalizedPrompt);

  console.log(`[auth] OIDC 授权地址已生成：redirect_uri=${redirectUri} silent=${normalizedPrompt === 'none'}`);
  return { authorize_url: target.toString() };
}

/** 用授权码换取 token，并拉取 userinfo */
async function exchangeCodeForUserinfo({ code, state }) {
  const redirectUri = consumeOidcState(state);
  if (!redirectUri) throw new AuthError('登录校验状态已过期，请重新登录', 400);

  const discovery = await fetchDiscoveryDocument();
  const { token_endpoint: tokenEndpoint, userinfo_endpoint: userinfoEndpoint } = discovery;
  if (!tokenEndpoint || !userinfoEndpoint) {
    throw new AuthError('OIDC discovery 文档缺少 token 或 userinfo 端点', 500);
  }

  let token;
  try {
    token = await requestJson(tokenEndpoint, {
      method: 'POST',
      verifySsl: authConfig.oidc.verifySsl,
      // client_secret_post：与 VerPD / kmoke4 的 token_endpoint_auth_method 一致
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: authConfig.oidc.clientId,
        client_secret: authConfig.oidc.clientSecret,
      },
    });
  } catch (error) {
    console.error(`[auth] OIDC 换取 token 失败：${String(error)}`);
    throw new AuthError('OIDC 换取 token 失败', 502);
  }

  if (!token.access_token) throw new AuthError('OIDC token 响应缺少 access_token', 502);

  let userinfo;
  try {
    userinfo = await requestJson(userinfoEndpoint, {
      verifySsl: authConfig.oidc.verifySsl,
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
  } catch (error) {
    console.error(`[auth] OIDC 获取 userinfo 失败：${String(error)}`);
    throw new AuthError('OIDC 获取用户信息失败', 502);
  }

  console.log(`[auth] OIDC userinfo 已获取：keys=${Object.keys(userinfo).sort().join(',')}`);
  return { userinfo, idToken: token.id_token ?? null };
}

/** 拼第三方登出地址；没有 id_token 或认证中心未提供 end_session_endpoint 时返回 null */
async function buildEndSessionUrl(idTokenHint) {
  if (!idTokenHint) return null;
  try {
    const discovery = await fetchDiscoveryDocument();
    if (!discovery.end_session_endpoint) {
      console.log('[auth] OIDC 未提供 end_session_endpoint，跳过第三方登出');
      return null;
    }
    const target = new URL(discovery.end_session_endpoint);
    target.searchParams.set('id_token_hint', idTokenHint);
    target.searchParams.set('post_logout_redirect_uri', authConfig.oidc.redirectUri);
    return target.toString();
  } catch (error) {
    console.warn(`[auth] 生成 OIDC 登出地址失败，仅完成本地登出：${String(error)}`);
    return null;
  }
}

// ---------- 系统自签 JWT（HS256） ----------

function resolveSecret() {
  if (!authConfig.jwtSecretKey) {
    throw new AuthError('JWT_SECRET_KEY 未配置，无法签发或校验登录态', 500);
  }
  return Buffer.from(authConfig.jwtSecretKey, 'utf-8');
}

const signInput = (input) => createHmac('sha256', resolveSecret()).update(input).digest('base64url');
const nowSeconds = () => Math.floor(Date.now() / 1000);

function issueAccessToken(userId) {
  const jti = randomBytes(24).toString('base64url');
  const exp = nowSeconds() + authConfig.jwtExpireSeconds;
  const header = Buffer.from(JSON.stringify({ alg: authConfig.jwtAlgorithm, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: String(userId), jti, exp })).toString('base64url');
  const input = `${header}.${payload}`;
  return { token: `${input}.${signInput(input)}`, jti, expiresAt: exp };
}

function verifyAccessToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('token 格式不正确', 4012);
  const [header, payload, signature] = parts;

  const expected = Buffer.from(signInput(`${header}.${payload}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthError('token 签名校验失败', 4012);
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    throw new AuthError('token 载荷不是合法 JSON', 4012);
  }
  if (!decoded?.sub || !decoded?.jti || !decoded?.exp) {
    throw new AuthError('token 载荷缺少必要字段', 4012);
  }
  if (decoded.exp <= nowSeconds()) throw new AuthError('token 已过期', 4011);
  return decoded;
}

// ---------- 用户信息 ----------

function pickString(source, key) {
  const value = source?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function pickNested(profile, nestedKey, keys) {
  const nested = profile?.[nestedKey];
  if (!nested || typeof nested !== 'object') return '';
  for (const key of keys) {
    const value = pickString(nested, key);
    if (value) return value;
  }
  return '';
}

const normalize = (value) => value.replace(/[\s\u200b-\u200d\ufeff]+/g, ' ').trim();

/** 从第三方 userinfo 提取本地用户字段，取值优先级与 VerPD / kmoke4 对齐 */
function buildUserProfile(sub, profile) {
  const email = pickString(profile, 'email');
  const username =
    pickString(profile, 'preferred_username') ||
    pickString(profile, 'username') ||
    pickString(profile, 'nickname') ||
    (email.includes('@') ? email.split('@')[0] : '') ||
    `oidc_${sub.slice(0, 12)}`;
  const displayName =
    pickString(profile, 'name') || pickString(profile, 'given_name') || pickString(profile, 'preferred_username') || username;
  const avatarUrl =
    pickNested(profile, 'dingtalk_profile', ['avatar_url']) ||
    pickString(profile, 'picture') ||
    pickString(profile, 'photo');

  return {
    sub,
    username: normalize(username).slice(0, 64),
    name: normalize(displayName).slice(0, 64) || 'oidc_user',
    email: email.slice(0, 128),
    avatarUrl: avatarUrl.slice(0, 512),
  };
}

function toUserInfo(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName || user.name || user.username,
    avatar_url: user.avatarUrl || '',
    email: user.email || '',
    role: user.role || 'viewer',
  };
}

// ---------- 中间件与路由 ----------

async function authenticate(authorizationHeader) {
  const match = /^Bearer\s+(.+)$/i.exec((authorizationHeader || '').trim());
  if (!match) throw new AuthError('未登录或缺少 Authorization 头', 401);

  const payload = verifyAccessToken(match[1].trim());
  const session = getSessionByJti(payload.jti);
  if (!session || session.user.id !== payload.sub) {
    throw new AuthError('登录态已失效，请重新登录', 4012);
  }
  return { user: session.user, jti: payload.jti, oidcIdToken: session.oidcIdToken };
}

/** 登录态中间件：AUTH_REQUIRED=false 时直接注入 dev 用户 */
export async function requireAuth(req, res, next) {
  if (!authEnabled) {
    req.user = DEV_USER;
    return next();
  }
  try {
    const { user, jti, oidcIdToken } = await authenticate(req.header('authorization'));
    req.user = user;
    req.jti = jti;
    req.authSession = { oidcIdToken };
    next();
  } catch (error) {
    if (!(error instanceof AuthError) || error.httpStatus >= 500) {
      console.error('[auth] 鉴权处理异常：', error);
    }
    const { status, body } = toErrorPayload(error);
    res.status(status).json(body);
  }
}

/** 挂载 /api/auth/* 路由（需在 api 级 requireAuth 之前注册） */
export function mountAuthRoutes(app) {
  app.get('/api/auth/config', (_req, res) => {
    res.json({
      login_required: authConfig.enabled,
      oidc_configured: isOidcConfigured(),
      change_password_url: authConfig.oidc.changePasswordUrl || null,
    });
  });

  app.get('/api/auth/oidc/authorize-url', async (req, res) => {
    try {
      const prompt = typeof req.query.prompt === 'string' ? req.query.prompt : null;
      res.json(await createAuthorizeUrl({ prompt }));
    } catch (error) {
      const { status, body } = toErrorPayload(error);
      res.status(status).json(body);
    }
  });

  app.post('/api/auth/oidc/callback', async (req, res) => {
    try {
      const code = String(req.body?.code ?? '').trim();
      const state = String(req.body?.state ?? '').trim();
      if (!code || !state) throw new AuthError('code 与 state 不能为空', 400);

      const { userinfo, idToken } = await exchangeCodeForUserinfo({ code, state });
      const sub = String(userinfo.sub ?? '').trim();
      if (!sub) throw new AuthError('OIDC userinfo 缺少 sub 字段', 502);

      const user = upsertUser(buildUserProfile(sub, userinfo));
      // 新用户首次登录：以现有方案为模板复制一份，之后各自独立修改
      seedUserScenes(user.id);

      const { token, jti, expiresAt } = issueAccessToken(user.id);
      registerSession(jti, user.id, new Date(expiresAt * 1000).toISOString(), idToken);

      console.log(`[auth] OIDC 登录完成：user_id=${user.id} username=${user.username}`);
      res.json({ access_token: token, token_type: 'bearer', user_info: toUserInfo(user) });
    } catch (error) {
      const { status, body } = toErrorPayload(error);
      res.status(status).json(body);
    }
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user_info: toUserInfo(req.user) });
  });

  app.post('/api/auth/logout', requireAuth, async (req, res) => {
    try {
      if (req.jti) deleteSession(req.jti);
      const logoutUrl = await buildEndSessionUrl(req.authSession?.oidcIdToken ?? null);
      res.json({ logout_url: logoutUrl });
    } catch (error) {
      const { status, body } = toErrorPayload(error);
      res.status(status).json(body);
    }
  });
}

/** 启动时打印一次配置体检结果 */
export function logAuthConfigSummary() {
  console.log(
    `[auth] 登录门禁 AUTH_REQUIRED=${authConfig.enabled}；` +
      `OIDC discovery=${authConfig.oidc.discoveryUrl || '(未配置)'}；` +
      `回调地址=${authConfig.oidc.redirectUri || '(未配置)'}`,
  );
  if (authConfig.enabled) {
    const missing = getMissingOidcConfigKeys();
    if (missing.length > 0) {
      console.warn(`[auth] 已开启登录门禁，但 OIDC 配置不完整，缺少：${missing.join(', ')}`);
    }
    if (!authConfig.jwtSecretKey) {
      console.warn('[auth] JWT_SECRET_KEY 未配置，无法签发登录态');
    }
  } else {
    console.log('[auth] 未开启登录门禁：所有请求按匿名 dev 用户处理');
  }
}
