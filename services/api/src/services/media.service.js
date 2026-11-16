'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MediaAsset = require('../models/MediaAsset');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const bus = require('../realtime/bus');

const {
  activeMemberOrThrow,
  hostMemberOrThrow,
} = require('./room.service');

const { mediaKind } = require('../middleware/upload');
const { resetPlaybackForMedia } = require('./playback.service');

function validateExternalUrl(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw ApiError.badRequest(
      'Media URL is not valid',
      'INVALID_MEDIA_URL',
    );
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw ApiError.badRequest(
      'Only HTTP(S) media URLs are supported',
      'INVALID_MEDIA_URL',
    );
  }

  if (url.username || url.password) {
    throw ApiError.badRequest(
      'Credentials must not be embedded in media URLs',
      'INVALID_MEDIA_URL',
    );
  }

  if (config.isProduction && url.protocol !== 'https:') {
    throw ApiError.badRequest(
      'Production media URLs must use HTTPS',
      'INSECURE_MEDIA_URL',
    );
  }

  return url.toString();
}

function validateDrm(input) {
  const scheme = String(input.drmScheme || '').toLowerCase();
  const licenseUrl = String(input.drmLicenseUrl || '').trim();

  if (!scheme && !licenseUrl) {
    return {
      drmScheme: '',
      drmLicenseUrl: '',
    };
  }

  if (!scheme) {
    throw ApiError.badRequest(
      'Choose a DRM scheme before adding a license URL',
      'DRM_SCHEME_REQUIRED',
    );
  }

  if (!licenseUrl) {
    throw ApiError.badRequest(
      'A DRM license URL is required for DRM-protected media',
      'DRM_LICENSE_REQUIRED',
    );
  }

  let parsed;

  try {
    parsed = new URL(licenseUrl);
  } catch {
    throw ApiError.badRequest(
      'DRM license URL is not valid',
      'INVALID_DRM_LICENSE_URL',
    );
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(
      'DRM license URLs must use HTTP(S)',
      'INVALID_DRM_LICENSE_URL',
    );
  }

  if (parsed.username || parsed.password) {
    throw ApiError.badRequest(
      'Credentials must not be embedded in DRM license URLs',
      'INVALID_DRM_LICENSE_URL',
    );
  }

  if (config.isProduction && parsed.protocol !== 'https:') {
    throw ApiError.badRequest(
      'Production DRM license URLs must use HTTPS',
      'INSECURE_DRM_LICENSE_URL',
    );
  }

  return {
    drmScheme: scheme,
    drmLicenseUrl: parsed.toString(),
  };
}

async function addUploadedMedia(room, userId, file, input) {
  await hostMemberOrThrow(room, userId);

  if (room.status !== 'active') {
    throw ApiError.conflict('Room has ended', 'ROOM_ENDED');
  }

  const kind = mediaKind(file.mimetype);

  if (!kind) {
    throw ApiError.badRequest(
      'Unsupported media file',
      'UNSUPPORTED_MEDIA',
    );
  }

  if (input.mediaType && input.mediaType !== kind) {
    throw ApiError.badRequest(
      'Uploaded file does not match the requested media type',
      'MEDIA_TYPE_MISMATCH',
    );
  }

  const media = await MediaAsset.create({
    room: room._id,
    owner: userId,
    title: input.title || file.originalname,
    artist: input.artist || '',
    type: kind,
    source: 'upload',
    storageKey: path.basename(file.filename),
    mimeType: file.mimetype,
    sizeBytes: file.size,
    durationMs: Math.max(0, Number(input.durationMs) || 0),
  });

  bus.emit('media.added', { room, media });

  return media;
}

async function addUrlMedia(room, userId, input) {
  await hostMemberOrThrow(room, userId);

  if (room.status !== 'active') {
    throw ApiError.conflict('Room has ended', 'ROOM_ENDED');
  }

  const drm = validateDrm(input);

  const media = await MediaAsset.create({
    room: room._id,
    owner: userId,
    title: input.title,
    artist: input.artist || '',
    type: input.type,
    source: 'url',
    url: validateExternalUrl(input.url),
    mimeType: input.mimeType || '',
    durationMs: Math.max(0, Number(input.durationMs) || 0),
    provider: input.provider || '',
    ...drm,
  });

  bus.emit('media.added', { room, media });

  return media;
}

async function listMedia(room, userId) {
  await activeMemberOrThrow(room, userId);

  const media = await MediaAsset.find({
    room: room._id,
    deletedAt: null,
  })
    .sort({ createdAt: -1 })
    .limit(100);

  return media.map((item) => item.toPublicJSON());
}

async function getAuthorizedMedia(room, userId, mediaId) {
  await activeMemberOrThrow(room, userId);

  const media = await MediaAsset.findOne({
    _id: mediaId,
    room: room._id,
    deletedAt: null,
  }).select('+storageKey');

  if (!media) {
    throw ApiError.notFound('Media not found', 'MEDIA_NOT_FOUND');
  }

  return media;
}

function absoluteMediaPath(media) {
  if (!media?.storageKey) return null;

  const safeName = path.basename(media.storageKey);
  const storageDirectory = path.resolve(config.MEDIA_STORAGE_DIR);

  return path.resolve(storageDirectory, safeName);
}

async function deleteMedia(room, userId, mediaId) {
  await hostMemberOrThrow(room, userId);

  const media = await MediaAsset.findOne({
    _id: mediaId,
    room: room._id,
    deletedAt: null,
  }).select('+storageKey');

  if (!media) {
    throw ApiError.notFound('Media not found', 'MEDIA_NOT_FOUND');
  }

  media.deletedAt = new Date();

  await media.save();

  await resetPlaybackForMedia(room, media._id);

  if (media.source === 'upload' && media.storageKey) {
    const absolute = absoluteMediaPath(media);

    if (absolute) {
      await fs.unlink(absolute).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }

  bus.emit('media.removed', {
    room,
    mediaId: media._id.toString(),
  });

  return true;
}

module.exports = {
  addUploadedMedia,
  addUrlMedia,
  listMedia,
  getAuthorizedMedia,
  deleteMedia,
  absoluteMediaPath,
  validateExternalUrl,
};