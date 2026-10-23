import { apiFetch, readErrorMessage } from './api';
import type { AuthUserInfoPayload } from './auth';

/**
 * OIDC 登录流程（与 VerPD 对齐）。
 *
 * 本应用没有路由，第三方回调直接回到站点根路径（/?code=...&state=...），
 * 由登录页读取参数后把 code/state 交回后端完成登录。
 */

const SILENT_LOGIN_ATTEMPTED_KEY = 'oidc_silent_login_attempted';
const EXPLICIT_LOGOUT_KEY = 'oidc_explicit_logout';

/** 静默登录失败时属于「第三方当前无登录态」，不应报错打断用户 */
const SILENT_LOGIN_ERRORS = new Set([
  'login_required',
  'interaction_required',
  'consent_required',
  'account_selection_required',
]);

export interface AuthPublicConfig {
  login_required: boolean;
  oidc_configured: boolean;
  change_password_url: string | null;
}

export interface OidcCallbackParams {
  code: string;
  state: string;
  error: string;
  errorDescription: string;
}

export function readOidcCallbackParams(): OidcCallbackParams {
  const params = new URLSearchParams(window.location.search);
  return {
    code: params.get('code') || '',
    state: params.get('state') || '',
    error: params.get('error') || '',
    errorDescription: params.get('error_description') || '',
  };
}

/** 清掉地址栏里的回调参数，避免刷新时重复提交 code */
export function clearOidcQueryParams(): void {
  const url = new URL(window.location.href);
  ['code', 'state', 'error', 'error_description', 'logged_out'].forEach((key) =>
    url.searchParams.delete(key),
  );
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function isSilentLoginError(errorCode: string): boolean {
  return SILENT_LOGIN_ERRORS.has(errorCode);
}

/** 每个页面会话只尝试一次静默登录，避免与第三方来回跳转 */
export function markSilentLoginAttempted(): boolean {
  if (sessionStorage.getItem(SILENT_LOGIN_ATTEMPTED_KEY) === '1') return false;
  sessionStorage.setItem(SILENT_LOGIN_ATTEMPTED_KEY, '1');
  return true;
}

export function clearSilentLoginAttempted(): void {
  sessionStorage.removeItem(SILENT_LOGIN_ATTEMPTED_KEY);
}

/** 记录「用户主动退出」，避免退出后立刻被静默登录重新登进来 */
export function markExplicitLogout(): void {
  try {
    sessionStorage.setItem(EXPLICIT_LOGOUT_KEY, '1');
  } catch {
    // 忽略存储不可用
  }
}

export function consumeExplicitLogout(): boolean {
  const flagged = sessionStorage.getItem(EXPLICIT_LOGOUT_KEY) === '1';
  sessionStorage.removeItem(EXPLICIT_LOGOUT_KEY);
  return flagged;
}

export async function fetchAuthPublicConfig(): Promise<AuthPublicConfig> {
  const response = await apiFetch('/api/auth/config');
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, '读取登录配置失败'));
  }
  return response.json();
}

export async function fetchAuthorizeUrl(options: { prompt?: 'none' } = {}): Promise<string> {
  const params = new URLSearchParams();
  if (options.prompt) params.set('prompt', options.prompt);
  const query = params.toString();

  const response = await apiFetch(`/api/auth/oidc/authorize-url${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, '获取登录地址失败'));
  }
  const payload = await response.json();
  if (!payload?.authorize_url) {
    throw new Error('登录地址响应异常');
  }
  return payload.authorize_url as string;
}

export async function completeLogin(
  code: string,
  state: string,
): Promise<{ access_token: string; user_info: AuthUserInfoPayload }> {
  const response = await apiFetch('/api/auth/oidc/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, '登录失败'));
  }
  return response.json();
}

export async function fetchCurrentUser(): Promise<{ user_info: AuthUserInfoPayload }> {
  const response = await apiFetch('/api/auth/me');
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, '读取当前用户失败'));
  }
  return response.json();
}

/** 退出登录：先失效服务端会话，再尽量同时登出第三方 */
export async function requestLogout(): Promise<string | null> {
  const response = await apiFetch('/api/auth/logout', { method: 'POST' });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, '退出登录失败'));
  }
  const payload = await response.json();
  return (payload.logout_url as string | null) ?? null;
}
