import { clearAuth, getToken } from './auth';

/**
 * 统一请求入口：自动带上 Authorization: Bearer <token>。
 * 401 视为登录态失效，清理本地登录态并通知外层回到登录页。
 */

type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(input, { ...init, headers });

  if (response.status === 401) {
    clearAuth();
    onUnauthorized?.();
  }

  return response;
}

/** 读取后端错误响应的 message，便于界面直接展示 */
export async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.message === 'string' && payload.message) {
      return payload.message;
    }
  } catch {
    // 忽略非 JSON 错误响应
  }
  return `${fallback}（HTTP ${response.status}）`;
}
