'use strict';

/**
 * Small per-socket fixed-window limiter. Chat rate limiting is additionally
 * enforced per room/user in chat.service so reconnecting sockets cannot bypass
 * room policy.
 */
const buckets = new WeakMap();

function consume(socket, key, limit, windowMs = 60_000) {
  const now = Date.now();
  let socketBuckets = buckets.get(socket);
  if (!socketBuckets) {
    socketBuckets = new Map();
    buckets.set(socket, socketBuckets);
  }
  const entry = socketBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    socketBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

module.exports = { consume };
