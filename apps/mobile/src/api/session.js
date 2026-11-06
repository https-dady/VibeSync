import axios from 'axios';
import { getApiBaseUrl } from '../config';
import {
  clearSessionTokens,
  loadSessionTokens,
  saveSessionTokens,
} from '../services/storage';
import { emitAuthEvent } from '../services/authEvents';

let currentSession = null;
let refreshPromise = null;
let initialized = false;

function accessIsFresh(marginMs = 45000) {
  if (!currentSession?.accessToken) return false;
  if (!currentSession.accessExpiresAt) return true;
  return new Date(currentSession.accessExpiresAt).getTime() - Date.now() > marginMs;
}

function refreshIsValid() {
  if (!currentSession?.refreshToken) return false;
  if (!currentSession.refreshExpiresAt) return true;
  return new Date(currentSession.refreshExpiresAt).getTime() > Date.now();
}

export async function initializeSession() {
  if (initialized) return currentSession;
  currentSession = await loadSessionTokens();
  initialized = true;
  return currentSession;
}

export async function persistSession(tokens) {
  currentSession = {
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
  };
  initialized = true;
  await saveSessionTokens(currentSession);
  emitAuthEvent({ type: 'session:updated' });
  return currentSession;
}

export async function clearSession() {
  currentSession = null;
  initialized = true;
  refreshPromise = null;
  await clearSessionTokens();
  emitAuthEvent({ type: 'session:cleared' });
}

export function getSessionSnapshot() {
  return currentSession;
}

export async function refreshSession() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    if (!currentSession?.refreshToken) {
      await clearSession();
      emitAuthEvent({ type: 'session:expired', reason: 'missing_refresh' });
      const error = new Error('Session expired');
      error.code = 'SESSION_EXPIRED';
      throw error;
    }
    if (!refreshIsValid()) {
      await clearSession();
      emitAuthEvent({ type: 'session:expired', reason: 'refresh_expired' });
      const error = new Error('Session expired');
      error.code = 'SESSION_EXPIRED';
      throw error;
    }

    try {
      const response = await axios.post(
        `${getApiBaseUrl()}/api/auth/refresh`,
        { refreshToken: currentSession.refreshToken },
        {
          timeout: 15000,
          headers: { 'Content-Type': 'application/json' },
        },
      );
      currentSession = {
        ...currentSession,
        ...response.data,
      };
      await saveSessionTokens(currentSession);
      emitAuthEvent({ type: 'session:refreshed' });
      return currentSession.accessToken;
    } catch (error) {
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        await clearSession();
        emitAuthEvent({
          type: 'session:expired',
          reason: error.response?.data?.error?.code || 'refresh_rejected',
        });
        const sessionError = new Error('Session expired. Please sign in again.');
        sessionError.code = 'SESSION_EXPIRED';
        throw sessionError;
      }
      throw error;
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function getValidAccessToken({ forceRefresh = false } = {}) {
  await initializeSession();
  if (!forceRefresh && accessIsFresh()) return currentSession?.accessToken || null;
  return refreshSession();
}
