'use strict';

const express = require('express');
const MediaAsset = require('../models/MediaAsset');
const Room = require('../models/Room');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { authenticate } = require('../middleware/authenticate');
const { activeMemberOrThrow } = require('../services/room.service');
const { absoluteMediaPath } = require('../services/media.service');
const { apiLimiter } = require('../middleware/rateLimits');

const router = express.Router();

async function streamMedia(req, res, next) {
  try {
    const media = await MediaAsset.findOne({
      _id: req.params.mediaId,
      deletedAt: null,
    }).select('+storageKey');
    if (!media) throw ApiError.notFound('Media not found', 'MEDIA_NOT_FOUND');
    const room = await Room.findById(media.room);
    if (!room) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');
    await activeMemberOrThrow(room, req.user._id);
    if (media.source !== 'upload') {
      throw ApiError.badRequest('This media is served by an external provider', 'EXTERNAL_MEDIA');
    }
    const absolute = absoluteMediaPath(media);
    if (!absolute) throw ApiError.notFound('Media file unavailable', 'MEDIA_FILE_MISSING');

    res.set({
      'Content-Type': media.mimeType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(media.title).slice(0, 120)}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.status(200).end();
    return res.sendFile(absolute, { dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) {
        next(error.code === 'ENOENT' ? ApiError.notFound('Media file missing') : error);
      }
    });
  } catch (error) {
    next(error);
  }
}

router.get('/:mediaId/stream', authenticate, apiLimiter, asyncHandler(streamMedia));
router.head('/:mediaId/stream', authenticate, apiLimiter, asyncHandler(streamMedia));

module.exports = router;
