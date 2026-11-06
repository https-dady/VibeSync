'use strict';

const mongoose = require('mongoose');
const config = require('./env');
const logger = require('./logger');

async function connectDatabase() {
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);
  await mongoose.connect(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: config.isProduction ? 30 : 10,
  });
  logger.info({ database: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

async function disconnectDatabase() {
  await mongoose.disconnect();
}

module.exports = { connectDatabase, disconnectDatabase, mongoose };
