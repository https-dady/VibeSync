import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

const nativeModule = NativeModules.VibeSyncNearby || null;
const emitter = nativeModule ? new NativeEventEmitter(nativeModule) : null;

const REQUEST_TIMEOUT_MS = 8000;

export const NEARBY_SUPPORTED = Boolean(nativeModule);

export const nearbyEvents = {
  PEER_FOUND: 'VibeSyncNearbyPeer',
  PEER_LOST: 'VibeSyncNearbyPeerLost',
  SCAN_STATE: 'VibeSyncNearbyScanState',
  HOST_STATE: 'VibeSyncNearbyHostState',
};

function requireNative() {
  if (!nativeModule) {
    const error = new Error(
      'Nearby mode needs the VibeSync native module. Build and run the Android or iOS app to use it.',
    );
    error.code = 'NEARBY_UNAVAILABLE';
    throw error;
  }
  return nativeModule;
}

function withTimeout(promise, message = 'The local room did not respond') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.code = 'NEARBY_TIMEOUT';
      reject(error);
    }, REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function request(baseUrl, path, { method = 'GET', token, body } = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const headers = { Accept: 'application/json' };
  if (token) headers['X-VibeSync-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await withTimeout(
      fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );
  } catch (error) {
    if (error.code === 'NEARBY_TIMEOUT') throw error;
    const networkError = new Error(
      'Could not reach the nearby room. Stay on the same Wi-Fi network or the host hotspot.',
    );
    networkError.code = 'NEARBY_UNREACHABLE';
    throw networkError;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `Local room request failed (${response.status})`);
    error.code = payload?.code || 'NEARBY_REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function normalizeNearbyAddress(value) {
  let input = String(value || '').trim();
  if (!input) throw new Error('Enter the host address');
  if (!/^https?:\/\//i.test(input)) input = `http://${input}`;
  // React Native's URL polyfill does not reliably expose .port/.origin, so the
  // address is parsed explicitly instead.
  const match = input.match(/^(https?):\/\/([^/\s:?#]+|\[[^\]]+\])(?::(\d{1,5}))?(?:[/?#].*)?$/i);
  if (!match) throw new Error('Enter an address like 192.168.1.20:8787');
  const [, protocol, host, port] = match;
  if (!port) throw new Error('Include the host port, for example 192.168.1.20:8787');
  if (Number(port) < 1 || Number(port) > 65535) throw new Error('The host port must be between 1 and 65535');
  return `${protocol.toLowerCase()}://${host}:${port}`;
}

export function nearbyMediaUrl(baseUrl, session) {
  const source = session?.media?.url;
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) return source;
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, '')}${source}`;
}

export async function getCapabilities() {
  if (!nativeModule) {
    return {
      supported: false,
      ble: false,
      localServer: false,
      wifiDirect: false,
      platform: Platform.OS,
      reason: 'Native nearby transport is not compiled into this build.',
    };
  }
  try {
    const capabilities = await nativeModule.getCapabilities();
    return { supported: true, platform: Platform.OS, ...capabilities };
  } catch (error) {
    return {
      supported: false,
      ble: false,
      localServer: false,
      wifiDirect: false,
      platform: Platform.OS,
      reason: error?.message || 'Nearby transport is unavailable.',
    };
  }
}

export async function startHost(options) {
  const module = requireNative();
  return module.startHost(options);
}

export async function stopHost() {
  if (!nativeModule) return;
  await nativeModule.stopHost();
}

export async function getHostSession() {
  const module = requireNative();
  return module.getSession();
}

export async function updatePlayback(playback) {
  const module = requireNative();
  return module.updatePlayback(playback);
}

export async function sendHostMessage(body) {
  const module = requireNative();
  return module.sendHostMessage(body);
}

export async function startDiscovery(displayName = '') {
  const module = requireNative();
  return module.startScan({ displayName });
}

export async function stopDiscovery() {
  if (!nativeModule) return;
  await nativeModule.stopScan();
}

export async function joinNearbyRoom(baseUrl, name) {
  const origin = normalizeNearbyAddress(baseUrl);
  const result = await request(origin, '/vibesync/join', {
    method: 'POST',
    body: { name: String(name || '').trim() || 'Guest' },
  });
  return { ...result, baseUrl: origin };
}

export async function fetchNearbySession(baseUrl, token) {
  const origin = normalizeNearbyAddress(baseUrl);
  const sentAt = Date.now();
  const result = await request(origin, '/vibesync/session', { token });
  const receivedAt = Date.now();
  return {
    ...result,
    baseUrl: origin,
    receivedAt,
    // The host stamps serverNow while handling the request, so the midpoint
    // of the request window cancels most of the local round-trip latency.
    offsetMs: Number(result.serverNow || 0) - (sentAt + receivedAt) / 2,
  };
}

export async function sendNearbyMessage(baseUrl, token, body) {
  const origin = normalizeNearbyAddress(baseUrl);
  const result = await request(origin, '/vibesync/messages', {
    method: 'POST',
    token,
    body: { body: String(body || '').trim() },
  });
  return result.message;
}

export async function leaveNearbyRoom(baseUrl, token) {
  const origin = normalizeNearbyAddress(baseUrl);
  await request(origin, '/vibesync/leave', { method: 'POST', token }).catch(() => {});
}

export function subscribePeerFound(listener) {
  if (!emitter) return () => {};
  const subscription = emitter.addListener(nearbyEvents.PEER_FOUND, listener);
  return () => subscription.remove();
}

export function subscribePeerLost(listener) {
  if (!emitter) return () => {};
  const subscription = emitter.addListener(nearbyEvents.PEER_LOST, listener);
  return () => subscription.remove();
}

export function subscribeScanState(listener) {
  if (!emitter) return () => {};
  const subscription = emitter.addListener(nearbyEvents.SCAN_STATE, listener);
  return () => subscription.remove();
}

export function subscribeHostState(listener) {
  if (!emitter) return () => {};
  const subscription = emitter.addListener(nearbyEvents.HOST_STATE, listener);
  return () => subscription.remove();
}

export function expectedNearbyPosition(session, localNow, offsetMs = 0) {
  const playback = session?.playback;
  if (!playback) return 0;
  const base = Number(playback.positionMs) || 0;
  if (playback.status !== 'playing') return base;
  const serverNow = localNow + offsetMs;
  const elapsed = Math.max(0, serverNow - Number(playback.updatedAt || 0));
  return base + elapsed * (Number(playback.rate) || 1);
}

export function formatNearbyCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}
