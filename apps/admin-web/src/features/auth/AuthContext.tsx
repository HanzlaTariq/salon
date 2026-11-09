import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, login as apiLogin, logout as apiLogout, refreshSession } from '../../lib/api';
import { PLATFORM_ROLES, SessionUser, setSessionExpiredHandler } from '../../lib/session';

type Status = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface AuthState {
  status: Status;
  user: SessionUser | null;
  mfaEnrollmentRequired: boolean;
  errorMessage?: string;
  login: (email: string, password: string, mfaCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
  /** Re-read the account (e.g. after enabling MFA). */
  reloadSession: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [enroll, setEnroll] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();

  const bootstrap = useCallback(async () => {
    setStatus('loading');
    try {
      const p = await refreshSession(); // restores the session from the httpOnly cookie, if any
      if (p && PLATFORM_ROLES.includes(p.user.role)) {
        setUser(p.user);
        setEnroll(p.mfaEnrollmentRequired);
        setStatus('authenticated');
      } else {
        setStatus('anonymous');
      }
    } catch (e) {
      setErrorMessage(e instanceof ApiError ? e.message : 'Something went wrong.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void bootstrap();
    setSessionExpiredHandler(() => {
      setUser(null);
      setStatus('anonymous');
    });
    return () => setSessionExpiredHandler(null);
  }, [bootstrap]);

  const login = useCallback(async (email: string, password: string, mfaCode?: string) => {
    const p = await apiLogin(email, password, mfaCode);
    if (!PLATFORM_ROLES.includes(p.user.role)) {
      // This portal is for platform staff only: never keep a customer/owner session here.
      await apiLogout().catch(() => undefined);
      throw new ApiError(403, { code: 'FORBIDDEN', message: 'This portal is for platform administrators only.' });
    }
    setUser(p.user);
    setEnroll(p.mfaEnrollmentRequired);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setUser(null);
      setEnroll(false);
      setStatus('anonymous');
    }
  }, []);

  const reloadSession = useCallback(async () => {
    const p = await refreshSession();
    if (p) {
      setUser(p.user);
      setEnroll(p.mfaEnrollmentRequired);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, user, mfaEnrollmentRequired: enroll, errorMessage, login, logout, retry: () => void bootstrap(), reloadSession }),
    [status, user, enroll, errorMessage, login, logout, bootstrap, reloadSession],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
