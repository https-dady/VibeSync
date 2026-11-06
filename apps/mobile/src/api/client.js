import axios from 'axios';
import { getApiBaseUrl } from '../config';
import {
  getValidAccessToken,
  refreshSession,
  initializeSession,
} from './session';

export const api = axios.create({
  timeout: 20000,
  headers: { Accept: 'application/json' },
});

api.interceptors.request.use(async (config) => {
  config.baseURL = getApiBaseUrl();
  await initializeSession();
  try {
    const token = await getValidAccessToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  } catch (error) {
    if (error.code === 'SESSION_EXPIRED') throw error;
    // For a network outage, attempt the request without a refreshed token and
    // let the request itself produce the canonical error.
  }
  return config;
});

function isRefreshEndpoint(url = '') {
  return url.includes('/api/auth/refresh') || url.includes('/api/auth/login') || url.includes('/api/auth/register');
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;
    if (
      status === 401 &&
      original &&
      !original._retried &&
      !isRefreshEndpoint(original.url) &&
      (await initializeSession())?.refreshToken
    ) {
      original._retried = true;
      try {
        const token = await refreshSession();
        original.headers = original.headers || {};
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch (refreshError) {
        return Promise.reject(refreshError);
      }
    }
    return Promise.reject(error);
  },
);

export function apiError(error) {
  if (error?.code === 'SESSION_EXPIRED') {
    return { message: 'Your session expired. Please sign in again.', code: 'SESSION_EXPIRED' };
  }
  if (error?.code === 'ECONNABORTED') {
    return { message: 'The request timed out. Check your connection.', code: 'TIMEOUT' };
  }
  if (!error?.response) {
    return {
      message: 'Cannot reach VibeSync. Check your internet connection or server address.',
      code: 'NETWORK_ERROR',
    };
  }
  const payload = error.response.data?.error;
  return {
    message: payload?.message || `Request failed (${error.response.status})`,
    code: payload?.code || 'REQUEST_FAILED',
    details: payload?.details,
    status: error.response.status,
  };
}

export function absoluteMediaUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${getApiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}
