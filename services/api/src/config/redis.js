'use strict';

const { createClient } = require('redis');
const config = require('./env');
const logger = require('./logger');

let client = null;
let publisher = null;
let subscriber = null;
let ready = false;

async function connectRedis() {
  if (!config.REDIS_URL) {
    logger.warn('REDIS_URL not configured; using single-instance in-memory presence and Mongo playback persistence');
    return null;
  }

  client = createClient({ url: config.REDIS_URL });
  client.on('error', (error) => {
    ready = false;
    logger.error({ err: error }, 'Redis client error');
  });
  client.on('ready', () => {
    ready = true;
    logger.info('Redis connected');
  });
  client.on('end', () => {
    ready = false;
  });
  await client.connect();

  publisher = client.duplicate();
  subscriber = client.duplicate();
  await Promise.all([publisher.connect(), subscriber.connect()]);
  return { client, publisher, subscriber };
}

function getRedis() {
  return ready ? client : null;
}

function isRedisReady() {
  return ready;
}

async function closeRedis() {
  ready = false;
  const clients = [subscriber, publisher, client].filter(Boolean);
  await Promise.allSettled(clients.map((c) => (c.isOpen ? c.quit() : Promise.resolve())));
  subscriber = null;
  publisher = null;
  client = null;
}

module.exports = {
  connectRedis,
  getRedis,
  isRedisReady,
  closeRedis,
  getRedisClients: () => ({ client, publisher, subscriber }),
};
