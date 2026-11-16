'use strict';

const path = require('node:path');
const { z } = require('zod');

// Load services/api/.env for local development.
// Existing process environment variables take precedence.
require('dotenv').config({
  path: path.resolve(__dirname, '..', '..', '.env'),
  quiet: true,
});

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined ? def : value === 'true' || value === '1',
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:4000'),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/vibesync'),
  REDIS_URL: z.string().optional().or(z.literal('')),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-refresh-secret-change-me'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  CORS_ORIGINS: z.string().default('*'),
  TRUST_PROXY: bool(false),

  MEDIA_STORAGE_DIR: z
    .string()
    .default(path.join(process.cwd(), 'storage', 'uploads')),

  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2048).default(500),

  STUN_URLS: z
    .string()
    .default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),

  TURN_URL: z.string().optional().or(z.literal('')),
  TURN_USERNAME: z.string().optional().or(z.literal('')),
  TURN_CREDENTIAL: z.string().optional().or(z.literal('')),
  TURN_SECRET: z.string().optional().or(z.literal('')),
  TURN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),

  LIVEKIT_URL: z.string().optional().or(z.literal('')),
  LIVEKIT_API_KEY: z.string().optional().or(z.literal('')),
  LIVEKIT_API_SECRET: z.string().optional().or(z.literal('')),

  LOG_LEVEL: z.string().default(isTest ? 'silent' : 'info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    'Invalid environment configuration',
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

const raw = parsed.data;

if (isProduction) {
  const unsafe = [];

  const placeholderAccessSecrets = new Set([
    'dev-access-secret-change-me',
    'replace-with-a-long-random-access-secret',
  ]);

  const placeholderRefreshSecrets = new Set([
    'dev-refresh-secret-change-me',
    'replace-with-a-long-random-refresh-secret',
  ]);

  if (placeholderAccessSecrets.has(raw.JWT_ACCESS_SECRET)) {
    unsafe.push('JWT_ACCESS_SECRET');
  }

  if (placeholderRefreshSecrets.has(raw.JWT_REFRESH_SECRET)) {
    unsafe.push('JWT_REFRESH_SECRET');
  }

  if (unsafe.length) {
    console.error(
      `Refusing to start in production with default secrets: ${unsafe.join(', ')}`,
    );
    process.exit(1);
  }
}

const config = {
  ...raw,

  // Always resolve media storage to an absolute filesystem path.
  MEDIA_STORAGE_DIR: path.resolve(raw.MEDIA_STORAGE_DIR),

  isProduction,
  isTest,

  corsOrigins:
    raw.CORS_ORIGINS === '*'
      ? '*'
      : raw.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),

  stunUrls: raw.STUN_URLS.split(',').map((url) => url.trim()).filter(Boolean),

  uploadMaxBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,

  livekitEnabled: Boolean(
    raw.LIVEKIT_URL &&
      raw.LIVEKIT_API_KEY &&
      raw.LIVEKIT_API_SECRET,
  ),

  roomIdAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
};

module.exports = config;