'use strict';

const config = require('../config/env');
const ApiError = require('../utils/ApiError');

const VALID_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'renegotiate', 'bye']);

function sanitizeSignal(data) {
  if (!data || typeof data !== 'object') {
    throw ApiError.badRequest('Signal payload required', 'INVALID_SIGNAL');
  }
  const type = data.type;
  if (!VALID_TYPES.has(type)) throw ApiError.badRequest('Unsupported signal type', 'INVALID_SIGNAL');
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > 64 * 1024) {
    throw ApiError.badRequest('Signal payload too large', 'INVALID_SIGNAL');
  }
  return { type, sdp: data.sdp || null, candidate: data.candidate || null, sessionId: data.sessionId || null };
}

function turnCredentials(userId) {
  if (config.TURN_SECRET) {
    // coturn REST API ephemeral credentials (RFC 5766 long-term credentials).
    const username = `${Math.floor(Date.now() / 1000) + config.TURN_TTL_SECONDS}:${userId}`;
    const credential = require('node:crypto')
      .createHmac('sha1', config.TURN_SECRET)
      .update(username)
      .digest('base64');
    return { username, credential };
  }
  return {
    username: config.TURN_USERNAME || undefined,
    credential: config.TURN_CREDENTIAL || undefined,
  };
}

function iceServers(userId) {
  const servers = [{ urls: config.stunUrls }];
  if (config.TURN_URL) {
    const { username, credential } = turnCredentials(userId);
    servers.push({
      urls: config.TURN_URL.split(',').map((url) => url.trim()).filter(Boolean),
      username,
      credential,
    });
  }
  return {
    iceServers: servers,
    voiceTransport: config.livekitEnabled ? 'livekit' : 'mesh',
    userId,
  };
}

async function livekitTokenFor(room, member, user) {
  if (!config.livekitEnabled) {
    throw ApiError.notFound('LiveKit is not configured', 'LIVEKIT_DISABLED');
  }
  // Lazy require keeps LiveKit an optional dependency until configured.
  let AccessToken;
  try {
    ({ AccessToken } = require('livekit-server-sdk'));
  } catch {
    throw ApiError.internal('LiveKit SDK is not installed on the server');
  }
  const canPublish = Boolean(
    member.permissions.canSpeak && !member.permissions.mutedByHost && member.status === 'active',
  );
  const token = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
    identity: String(user._id),
    name: user.name,
    ttl: '2h',
    metadata: JSON.stringify({ roomId: room.roomId, role: member.role }),
  });
  token.addGrant({
    roomJoin: true,
    room: `vibesync:${room.roomId}`,
    canPublish,
    canPublishAudio: canPublish,
    canPublishVideo: false,
    canPublishData: false,
    canSubscribe: true,
    roomAdmin: member.role === 'host',
  });
  return {
    token: await token.toJwt(),
    url: config.LIVEKIT_URL,
    roomName: `vibesync:${room.roomId}`,
    canPublish,
  };
}

module.exports = { sanitizeSignal, iceServers, livekitTokenFor };
