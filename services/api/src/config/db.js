'use strict';

const dns = require('node:dns');

dns.setServers(['1.1.1.1', '8.8.8.8']);

console.log('[DNS]', dns.getServers());

// Existing imports below this line
const mongoose = require('mongoose');
// const dns = require('node:dns');
const config = require('./env');
const logger = require('./logger');

// Configure DNS servers for MongoDB Atlas SRV resolution
function configureDNS() {
  try {
    const dnsServers = process.env.DNS_SERVERS
      ? process.env.DNS_SERVERS.split(',').map(server => server.trim())
      : ['8.8.8.8', '8.8.4.4'];

    dns.setServers(dnsServers);

    logger.info(
      { dnsServers },
      'Custom DNS servers configured'
    );
  } catch (error) {
    logger.warn(
      { error: error.message },
      'Unable to configure custom DNS servers'
    );
  }
}

// Configure MongoDB DNS resolution
async function connectDatabase() {
  configureDNS();

  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);

  try {
    await mongoose.connect(config.MONGODB_URI, {
      serverSelectionTimeoutMS: 20000,
      connectTimeoutMS: 20000,
      socketTimeoutMS: 45000,
      maxPoolSize: config.isProduction ? 30 : 10,
      retryWrites: true,
    });

    logger.info(
      { database: mongoose.connection.name },
      'MongoDB connected successfully'
    );

    return mongoose.connection;
  } catch (error) {
    logger.error(
      {
        error: error.message,
        code: error.code,
      },
      'MongoDB connection failed'
    );

    throw error;
  }
}

async function disconnectDatabase() {
  await mongoose.disconnect();

  logger.info('MongoDB disconnected');
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  mongoose,
};