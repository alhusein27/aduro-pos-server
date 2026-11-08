// Tokens and codes.
// A device token is a long random string. The server never stores the
// token itself, only a scrambled copy (a hash) of it. If the database
// ever leaks, the real tokens are not in it.

const crypto = require('node:crypto');

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Six readable characters. Letters and numbers that are easy to mix up
// (like O and 0, or I and 1) are left out, because the owner reads the
// code out loud or types it by hand.
function newShopCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

// Six digits, for a staff member joining the shop one time.
function newJoinCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { newToken, hashToken, newShopCode, newJoinCode, newId };
