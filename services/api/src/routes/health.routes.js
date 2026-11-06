'use strict';

const express = require('express');
const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const config = require('../config/env');
const { isRedisReady } = require('../config/redis');

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const dbState = mongoose.connection.readyState;
    res.json({
      status: dbState === 1 ? 'ok' : 'degraded',
      service: 'vibesync-api',
      version: '1.0.0',
      time: new Date().toISOString(),
      database: dbState === 1 ? 'connected' : 'disconnected',
      redis: config.REDIS_URL ? (isRedisReady() ? 'connected' : 'disconnected') : 'not-configured',
      livekit: config.livekitEnabled ? 'configured' : 'not-configured',
    });
  }),
);

module.exports = router;
