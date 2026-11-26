const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/store');
const { addMonths } = require('../src/dates');

const ADMIN_KEY = 'test-admin-key-for-tests-only';

async function startServer(options) {
  const store = new MemoryStore();
  await store.init();
  const app = createApp(store, options || { adminKey: ADMIN_KEY });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, store };
}

async function call(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

const goodVerifier = async () => ({ valid: true });
const badVerifier = async () => ({ valid: false });
const downVerifier = async () => {
  throw new Error('Google timed out.');
};

function monthsBetween(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12
    + (to.getUTCMonth() - from.getUTCMonth());
}

test('addMonths adds calendar months and clamps the day', () => {
  assert.equal(addMonths('2026-01-15T10:00:00.000Z', 1), '2026-02-15T10:00:00.000Z');
  assert.equal(addMonths('2026-01-31T10:00:00.000Z', 1), '2026-02-28T10:00:00.000Z');
  assert.equal(addMonths('2026-11-26T10:00:00.000Z', 12), '2027-11-26T10:00:00.000Z');
  assert.equal(addMonths('not a date', 1), null);
});

test('play report is refused plainly when no verifier is set up', async () => {
  const { server, base } = await startServer();
  try {
    const { status, body } = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(status, 503);
    assert.match(body.error, /not set up/);
  } finally {
    server.close();
  }
});

test('play report refuses a bad device ID, product and token', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: goodVerifier });
  try {
    const dotted = await call(base, 'POST', '/api/play/report', {
      deviceId: 'TP1A.220624.014',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(dotted.status, 400);

    const product = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_weekly',
      purchaseToken: 'token-1',
    });
    assert.equal(product.status, 400);

    const token = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: '',
    });
    assert.equal(token.status, 400);
  } finally {
    server.close();
  }
});

test('play report refuses a purchase Google cannot confirm', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: badVerifier });
  try {
    const { status, body } = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(status, 400);
    assert.match(body.error, /could not confirm/);
  } finally {
    server.close();
  }
});

test('play report answers try again when Google cannot be reached', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: downVerifier });
  try {
    const { status, body } = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(status, 503);
    assert.match(body.error, /could not be reached/);
  } finally {
    server.close();
  }
});

test('a confirmed monthly purchase gives about one month and status active', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: goodVerifier });
  try {
    const before = new Date().toISOString();
    const { status, body } = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      phone: '0545301093',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(monthsBetween(before, body.until), 1);

    const check = await call(base, 'GET', '/api/play/status?deviceId=device-1');
    assert.equal(check.status, 200);
    assert.equal(check.body.status, 'active');
    assert.equal(check.body.expiryDate, body.until);
  } finally {
    server.close();
  }
});

test('the same token reported again extends nothing', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: goodVerifier });
  try {
    const first = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    const second = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.until, first.body.until);
  } finally {
    server.close();
  }
});

test('a token from another phone is refused', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: goodVerifier });
  try {
    const first = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(first.status, 200);
    const other = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-2',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(other.status, 400);
    assert.match(other.body.error, /another phone/);
  } finally {
    server.close();
  }
});

test('a yearly purchase stacks on the months still left', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: goodVerifier });
  try {
    const monthly = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_monthly',
      purchaseToken: 'token-1',
    });
    assert.equal(monthly.status, 200);
    const yearly = await call(base, 'POST', '/api/play/report', {
      deviceId: 'device-1',
      productId: 'aduro_yearly',
      purchaseToken: 'token-2',
    });
    assert.equal(yearly.status, 200);
    assert.equal(monthsBetween(monthly.body.until, yearly.body.until), 12);
  } finally {
    server.close();
  }
});

test('play status is none for a device that never paid', async () => {
  const { server, base } = await startServer({ adminKey: ADMIN_KEY, playVerifier: goodVerifier });
  try {
    const { status, body } = await call(base, 'GET', '/api/play/status?deviceId=device-9');
    assert.equal(status, 200);
    assert.equal(body.status, 'none');
    assert.equal(body.expiryDate, null);
  } finally {
    server.close();
  }
});

test('play status turns grace then expired after the until date', async () => {
  const { server, base, store } = await startServer({ adminKey: ADMIN_KEY, playVerifier: goodVerifier });
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await store.recordPlayPurchase({
      purchaseToken: 'token-old',
      deviceId: 'device-1',
      phone: '',
      productId: 'aduro_monthly',
      until: threeDaysAgo,
      createdAt: threeDaysAgo,
    });
    const grace = await call(base, 'GET', '/api/play/status?deviceId=device-1');
    assert.equal(grace.body.status, 'grace');

    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await store.recordPlayPurchase({
      purchaseToken: 'token-older',
      deviceId: 'device-2',
      phone: '',
      productId: 'aduro_monthly',
      until: longAgo,
      createdAt: longAgo,
    });
    const expired = await call(base, 'GET', '/api/play/status?deviceId=device-2');
    assert.equal(expired.body.status, 'expired');
  } finally {
    server.close();
  }
});
