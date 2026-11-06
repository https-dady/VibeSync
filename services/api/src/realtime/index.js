'use strict';

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const config = require('../config/env');
const logger = require('../config/logger');
const { getRedisClients } = require('../config/redis');
const User = require('../models/User');
const { verifyAccessToken } = require('../services/token.service');
const { registerHandlers, registerBridge } = require('./handlers');
const { consume } = require('./rateLimit');
const presence = require('../services/presence.service');

function originAllowed(origin) {
  if (!origin) return true; // native apps often send no Origin header
  if (config.corsOrigins === '*') return true;
  return config.corsOrigins.includes(origin);
}

async function authenticateSocket(socket, next) {
  try {
    const header = socket.handshake.headers?.authorization || '';
    const token =
      socket.handshake.auth?.token ||
      (header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) return next(new Error('AUTH_REQUIRED'));
    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub);
    if (!user || user.disabledAt) return next(new Error('ACCOUNT_DISABLED'));
    socket.user = user;
    socket.data.userId = String(user._id);
    socket.data.tokenExpiresAt = payload.exp ? payload.exp * 1000 : null;
    return next();
  } catch (error) {
    return next(new Error(error.code === 'TOKEN_INVALID' ? 'AUTH_INVALID' : 'AUTH_FAILED'));
  }
}

function createRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 20_000,
    pingTimeout: 25_000,
    transports: ['websocket', 'polling'],
    cors: {
      origin: (origin, callback) => {
        if (originAllowed(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed'));
      },
      credentials: false,
    },
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },
  });

  const { publisher, subscriber } = getRedisClients();
  if (publisher && subscriber) {
    io.adapter(createAdapter(publisher, subscriber));
    logger.info('Socket.IO Redis adapter enabled');
  }

  io.use(authenticateSocket);
  io.use((socket, next) => {
    if (!consume(socket, 'connections', 20, 60_000)) {
      return next(new Error('CONNECTION_RATE_LIMITED'));
    }
    return next();
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    socket.join(`user:${user._id}`);
    socket.emit('connected', {
      userId: String(user._id),
      serverTime: Date.now(),
      socketId: socket.id,
      recovered: socket.recovered,
    });

    registerHandlers(io, socket);

    const presenceTimer = setInterval(() => {
      for (const roomId of socket.data.rooms || []) {
        presence.touchPresence(roomId, String(user._id)).catch(() => {});
      }
    }, 45_000);
    if (presenceTimer.unref) presenceTimer.unref();

    let expiryTimer = null;
    if (socket.data.tokenExpiresAt) {
      const delay = Math.max(0, socket.data.tokenExpiresAt - Date.now());
      expiryTimer = setTimeout(() => {
        socket.emit('auth:expired', { message: 'Access token expired; reconnect with a fresh token' });
        socket.disconnect(true);
      }, delay);
      if (expiryTimer.unref) expiryTimer.unref();
    }

    socket.on('disconnect', () => {
      clearInterval(presenceTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
    });
  });

  registerBridge(io);
  return io;
}

module.exports = { createRealtime, originAllowed, authenticateSocket };
