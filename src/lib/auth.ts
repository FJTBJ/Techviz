/**
 * 前端登录态存储（与 VerPD 保持一致）：
 * 只保存本系统自签 JWT 与用户信息，第三方 token 不落前端。
 */

/** 后端 user_info 的原始结构（snake_case） */
export interface AuthUserInfoPayload {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string;
  email?: string;
  role?: string;
}

/** 前端内部使用的登录用户结构 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  email: string;
  role: string;
}

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'user_info';

export function toAuthUser(payload: AuthUserInfoPayload): AuthUser {
  return {
    id: payload.id,
    username: payload.username,
    displayName: payload.display_name || payload.username,
    avatarUrl: payload.avatar_url || '',
    email: payload.email || '',
    role: payload.role || 'viewer',
  };
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUserInfoPayload;
    return parsed && typeof parsed.id === 'string' ? toAuthUser(parsed) : null;
  } catch {
    return null;
  }
}

export function setAuth(token: string, userInfo: AuthUserInfoPayload): AuthUser {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(userInfo));
  } catch (error) {
    console.warn('Failed to persist auth state:', error);
  }
  return toAuthUser(userInfo);
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch (error) {
    console.warn('Failed to clear auth state:', error);
  }
}
