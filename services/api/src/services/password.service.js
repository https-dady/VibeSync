'use strict';

const bcrypt = require('bcryptjs');

const ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, verifyPassword };
