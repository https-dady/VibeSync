import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { authApi } from '../api/endpoints';
import {
  clearSession,
  getSessionSnapshot,
  initializeSession,
  persistSession,
} from '../api/session';
import { subscribeAuthEvents } from '../services/authEvents';
import {
  cacheUser,
  clearRecentRooms,
  getApiOverride,
  getCachedUser,
} from '../services/storage';
import { setApiBaseUrl } from '../config';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const applyUser = useCallback(async (nextUser) => {
    setUser(nextUser);
    await cacheUser(nextUser);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const override = await getApiOverride().catch(() => null);
      if (override) setApiBaseUrl(override);
      const session = await initializeSession();
      if (!session?.refreshToken) {
        setUser(null);
        return;
      }
      const cached = await getCachedUser();
      if (cached && mounted.current) setUser(cached);
      const fresh = await authApi.me();
      if (mounted.current) await applyUser(fresh);
    } catch (error) {
      if (error?.code === 'SESSION_EXPIRED') {
        if (mounted.current) {
          setUser(null);
          setNotice('Your session expired. Sign in to continue.');
        }
      } else if (mounted.current) {
        // Network failure: keep the cached profile and let individual screens
        // surface connectivity errors. Tokens remain securely stored.
        const cached = await getCachedUser().catch(() => null);
        if (cached) setUser(cached);
      }
    } finally {
      if (mounted.current) setBooting(false);
    }
  }, [applyUser]);

  useEffect(() => {
    mounted.current = true;
    bootstrap();
    const unsubscribe = subscribeAuthEvents((event) => {
      if (event.type === 'session:expired') {
        setUser(null);
        setNotice('Your session expired. Sign in again to keep listening together.');
      }
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [bootstrap]);

  const login = useCallback(
    async (email, password) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await authApi.login(email.trim().toLowerCase(), password);
        await persistSession(result);
        await applyUser(result.user);
        return result.user;
      } finally {
        setBusy(false);
      }
    },
    [applyUser],
  );

  const register = useCallback(
    async ({ name, email, password }) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await authApi.register({ name, email: email.trim().toLowerCase(), password });
        await persistSession(result);
        await applyUser(result.user);
        return result.user;
      } finally {
        setBusy(false);
      }
    },
    [applyUser],
  );

  const logout = useCallback(async () => {
    const session = getSessionSnapshot();
    try {
      if (session?.refreshToken) await authApi.logout(session.refreshToken);
    } catch {
      // Local sign-out must always succeed even if the network is unavailable.
    }
    await clearSession();
    await cacheUser(null);
    await clearRecentRooms();
    setUser(null);
    setNotice(null);
  }, []);

  const updateProfile = useCallback(
    async (updates) => {
      const updated = await authApi.updateProfile(updates);
      await applyUser(updated);
      return updated;
    },
    [applyUser],
  );

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    await authApi.changePassword(currentPassword, newPassword);
    await clearSession();
    await cacheUser(null);
    setUser(null);
    setNotice('Password changed. Sign in with your new password.');
  }, []);

  const refreshUser = useCallback(async () => {
    const fresh = await authApi.me();
    await applyUser(fresh);
    return fresh;
  }, [applyUser]);

  const value = useMemo(
    () => ({
      booting,
      user,
      notice,
      busy,
      isAuthenticated: Boolean(user),
      login,
      register,
      logout,
      updateProfile,
      changePassword,
      refreshUser,
      clearNotice: () => setNotice(null),
    }),
    [booting, user, notice, busy, login, register, logout, updateProfile, changePassword, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
