// Security helpers: constant time secret comparison, brute force
// rate limiting with lockout, and the security headers every answer
// carries. No new packages: everything here uses node built ins.

const crypto = require('node:crypto');

// Compares two secrets without leaking, through timing, how many
// leading characters matched. Both sides are hashed first so the
// comparison always runs over the same length.
function timingSafeCompare(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

// A small in memory brute force guard. Each key (one IP plus one
// target, like a shop code) gets a few failed tries, then it is
// locked for a while. Success clears the count. Old records are
// dropped when they are next touched, so the map stays small.
function createAttemptGuard({ maxFailures = 5, lockoutMs = 15 * 60 * 1000 } = {}) {
  const records = new Map();

  function prune(now) {
    for (const [key, record] of records) {
      if (record.lockedUntil && record.lockedUntil <= now) {
        records.delete(key);
      }
    }
  }

  return {
    // Returns null when the key may try, or the lockout end time.
    lockedUntil(key) {
      const now = Date.now();
      prune(now);
      const record = records.get(key);
      if (record && record.lockedUntil && record.lockedUntil > now) {
        return record.lockedUntil;
      }
      return null;
    },
    fail(key) {
      const now = Date.now();
      prune(now);
      const record = records.get(key) || { failures: 0, lockedUntil: null };
      record.failures += 1;
      if (record.failures >= maxFailures) {
        record.lockedUntil = now + lockoutMs;
      }
      records.set(key, record);
      return record.lockedUntil;
    },
    pass(key) {
      records.delete(key);
    },
  };
}

// A simple per IP request cap, so one address cannot flood the API.
// Counts every request in a rolling window.
function createRequestCap({ windowMs = 15 * 60 * 1000, maxRequests = 1200 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const record = hits.get(key) || { count: 0, resetAt: now + windowMs };
    if (record.resetAt <= now) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }
    record.count += 1;
    hits.set(key, record);
    if (record.count > maxRequests) {
      return res.status(429).json({
        error: 'Too many requests from this address. Please wait a little and try again.',
      });
    }
    return next();
  };
}

// Headers on every answer. The admin page is the only HTML here, and
// its script lives in its own file, so scripts may only come from
// this server. Styles stay inline, which is why style-src allows
// inline styles; a style cannot run code. HSTS tells browsers to
// reach this server over HTTPS only for the next year.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  );
  return next();
}

module.exports = { timingSafeCompare, createAttemptGuard, createRequestCap, securityHeaders };
