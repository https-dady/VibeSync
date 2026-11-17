'use strict';

const { trusted } = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const config = require('../config/env');
const RefreshSession = require('../models/RefreshSession');
const { randomToken, sha256, randomFamilyId } = require('../utils/ids');
const ApiError = require('../utils/ApiError');

const ISSUER = 'vibesync-api';
const AUDIENCE = 'vibesync-mobile';

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      type: 'access',
    },
    config.JWT_ACCESS_SECRET,
    {
      expiresIn: config.ACCESS_TOKEN_TTL,
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithm: 'HS256',
    },
  );
}

function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload.type !== 'access' || !payload.sub) {
      throw new Error('Wrong token type');
    }
    return payload;
  } catch {
    throw ApiError.unauthorized('Access token is invalid or expired', 'TOKEN_INVALID');
  }
}

function refreshExpiry() {
  return new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function issueRefreshToken(user, { familyId, ip = '', userAgent = '' } = {}) {
  const raw = randomToken(48);
  const tokenHash = sha256(raw);
  const session = await RefreshSession.create({
    user: user._id || user.id,
    tokenHash,
    familyId: familyId || randomFamilyId(),
    expiresAt: refreshExpiry(),
    ip,
    userAgent: userAgent.slice(0, 300),
  });
  return { raw, session };
}

function accessExpiry(accessToken) {
  const decoded = jwt.decode(accessToken);
  return decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;
}

async function issueTokenPair(user, metadata = {}) {
  const refresh = await issueRefreshToken(user, metadata);
  const accessToken = signAccessToken(user);
  return {
    accessToken,
    accessExpiresAt: accessExpiry(accessToken),
    refreshToken: refresh.raw,
    refreshExpiresAt: refresh.session.expiresAt.toISOString(),
    tokenType: 'Bearer',
  };
}

async function rotateRefreshToken(rawToken, metadata = {}) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw ApiError.unauthorized('Refresh token required', 'REFRESH_REQUIRED');
  }
  const tokenHash = sha256(rawToken);
  const session = await RefreshSession.findOne({ tokenHash }).populate('user');

  if (!session) {
    throw ApiError.unauthorized('Refresh token is invalid', 'REFRESH_INVALID');
  }

  // Reuse of a rotated token means the token was stolen. Revoke the whole family.
  if (session.revokedAt) {
    await RefreshSession.updateMany(
      { familyId: session.familyId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw ApiError.unauthorized('Refresh token reuse detected; please sign in again', 'REFRESH_REUSE');
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Refresh token expired', 'REFRESH_EXPIRED');
  }

  if (!session.user || session.user.disabledAt) {
    throw ApiError.unauthorized('Account unavailable', 'ACCOUNT_DISABLED');
  }

  const replacement = await issueRefreshToken(session.user, {
    familyId: session.familyId,
    ...metadata,
  });

  session.revokedAt = new Date();
  session.replacedByHash = sha256(replacement.raw);
  await session.save();

  const accessToken = signAccessToken(session.user);
  return {
    accessToken,
    accessExpiresAt: accessExpiry(accessToken),
    refreshToken: replacement.raw,
    refreshExpiresAt: replacement.session.expiresAt.toISOString(),
    tokenType: 'Bearer',
  };
}

async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  const tokenHash = sha256(rawToken);
  await RefreshSession.updateOne(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

async function revokeAllSessions(userId) {
  await RefreshSession.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

async function pruneSessions(userId, keepHash) {
  const keep = keepHash || crypto.randomBytes(1).toString('hex');
  await RefreshSession.deleteMany({ user: userId, tokenHash: trusted({ $ne: keep }) });
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  pruneSessions,
};
