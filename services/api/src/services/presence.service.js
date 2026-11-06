'use strict';

const { getRedis } = require('../config/redis');

const localPresence = new Map();
const TTL_SECONDS = 90;

function key(roomId, userId) {
  return `vibesync:presence:${roomId}:${userId}`;
}

function localKey(roomId, userId) {
  return `${roomId}:${userId}`;
}

async function markOnline(roomId, userId, socketId) {
  const redis = getRedis();
  if (redis) {
    const cacheKey = key(roomId, userId);
    try {
      await redis.sAdd(cacheKey, socketId);
      await redis.expire(cacheKey, TTL_SECONDS);
      const count = await redis.sCard(cacheKey);
      return count === 1;
    } catch {
      // fall back to local tracking
    }
  }
  const k = localKey(roomId, userId);
  const set = localPresence.get(k) || new Set();
  const first = set.size === 0;
  set.add(socketId);
  localPresence.set(k, set);
  return first;
}

async function markOffline(roomId, userId, socketId) {
  const redis = getRedis();
  if (redis) {
    const cacheKey = key(roomId, userId);
    try {
      await redis.sRem(cacheKey, socketId);
      const count = await redis.sCard(cacheKey);
      if (count > 0) return false;
      await redis.del(cacheKey);
    } catch {
      // fall through
    }
  }
  const k = localKey(roomId, userId);
  const set = localPresence.get(k);
  if (!set) return true;
  set.delete(socketId);
  if (set.size === 0) {
    localPresence.delete(k);
    return true;
  }
  return false;
}

async function onlineUsers(roomId) {
  const redis = getRedis();
  if (redis) {
    try {
      const prefix = `vibesync:presence:${roomId}:`;
      const keys = [];
      for await (const batch of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
        keys.push(...batch);
      }
      return keys.map((item) => item.slice(prefix.length));
    } catch {
      // fall through
    }
  }
  const users = [];
  for (const item of localPresence.keys()) {
    if (item.startsWith(`${roomId}:`)) users.push(item.slice(roomId.length + 1));
  }
  return users;
}

async function touchPresence(roomId, userId) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const cacheKey = key(roomId, userId);
    if ((await redis.exists(cacheKey)) === 1) await redis.expire(cacheKey, TTL_SECONDS);
  } catch {
    // best effort
  }
}

module.exports = { markOnline, markOffline, onlineUsers, touchPresence };
