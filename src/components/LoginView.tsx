import { useEffect, useRef, useState } from 'react';
import { setAuth, type AuthUserInfoPayload } from '../lib/auth';
import {
  clearOidcQueryParams,
  clearSilentLoginAttempted,
  completeLogin,
  consumeExplicitLogout,
  fetchAuthPublicConfig,
  fetchAuthorizeUrl,
  isSilentLoginError,
  markSilentLoginAttempted,
  readOidcCallbackParams,
  type AuthPublicConfig,
} from '../lib/oidc';

type LoginStatus = 'checking' | 'idle' | 'processing' | 'error';

interface LoginViewProps {
  onAuthenticated: (userInfo: AuthUserInfoPayload) => void;
}

export function LoginView({ onAuthenticated }: LoginViewProps) {
  const [status, setStatus] = useState<LoginStatus>('checking');
  const [errorMessage, setErrorMessage] = useState('');
  const [config, setConfig] = useState<AuthPublicConfig | null>(null);
  /** 组件实例级标记：避免 StrictMode 重复挂载导致静默登录发起两次；重新挂载时仍会重新校验 */
  const bootstrapStartedRef = useRef(false);

  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;

  const applyLoginResult = (result: { access_token: string; user_info: AuthUserInfoPayload }) => {
    setAuth(result.access_token, result.user_info);
    onAuthenticatedRef.current(result.user_info);
  };

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;

    const startAuthorize = async (silent: boolean) => {
      try {
        const authorizeUrl = await fetchAuthorizeUrl(silent ? { prompt: 'none' } : {});
        window.location.href = authorizeUrl;
      } catch (error) {
        console.warn('[auth] 发起 OIDC 授权失败：', error);
        if (silent) {
          setStatus('idle');
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus('error');
      }
    };

    const bootstrap = async () => {
      const { code, state, error, errorDescription } = readOidcCallbackParams();

      // 1. 第三方直接回传错误（如静默登录时用户无登录态）
      if (error) {
        clearOidcQueryParams();
        if (isSilentLoginError(error)) {
          setStatus('idle');
        } else {
          setErrorMessage(errorDescription || '统一身份登录失败，请重试');
          setStatus('error');
        }
        return;
      }

      // 2. 第三方回调：用 code/state 换取本系统的登录态
      if (code && state) {
        setStatus('processing');
        try {
          const result = await completeLogin(code, state);
          clearOidcQueryParams();
          clearSilentLoginAttempted();
          applyLoginResult(result);
        } catch (err) {
          clearOidcQueryParams();
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
        return;
      }

      // 3. 读取服务端配置，确认 OIDC 是否可用
      let publicConfig: AuthPublicConfig | null = null;
      try {
        publicConfig = await fetchAuthPublicConfig();
      } catch (err) {
        console.warn('[auth] 读取登录配置失败：', err);
      }
      setConfig(publicConfig);

      if (!publicConfig?.oidc_configured) {
        setErrorMessage('服务端未配置可用的登录方式，请联系管理员');
        setStatus('error');
        return;
      }

      // 4. 用户主动退出后不再自动静默登录，避免被立即重新登入
      if (consumeExplicitLogout()) {
        setStatus('idle');
        return;
      }

      // 5. 首次进入：尝试一次静默登录（第三方已有登录态时免交互进入）
      if (!markSilentLoginAttempted()) {
        setStatus('idle');
        return;
      }
      setStatus('checking');
      await startAuthorize(true);
    };

    bootstrap();
  }, []);

  const handleLogin = async () => {
    setErrorMessage('');
    setStatus('checking');
    try {
      const authorizeUrl = await fetchAuthorizeUrl();
      window.location.href = authorizeUrl;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStatus('error');
    }
  };

  const busy = status === 'checking' || status === 'processing';

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <span className="logo">TECHVIZ</span>
          <span className="login-sub">技术预演工作台</span>
        </div>
        <p className="login-desc">使用公司统一账号登录，每位成员拥有独立的方案数据。</p>

        {errorMessage ? <div className="login-error">{errorMessage}</div> : null}

        {config?.oidc_configured ? (
          <>
            <button className="login-btn" onClick={handleLogin} disabled={busy}>
              {busy ? (status === 'processing' ? '正在完成登录…' : '正在跳转登录…') : '统一身份登录'}
            </button>
            <p className="login-hint">若浏览器已登录统一身份，将自动免密进入。</p>
          </>
        ) : status === 'checking' ? (
          <div className="login-hint">正在读取登录配置…</div>
        ) : (
          <button className="login-btn" onClick={() => window.location.reload()} disabled={busy}>
            重新加载
          </button>
        )}
      </div>
    </div>
  );
}
