const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/store');
const { accraDayRange } = require('../src/dates');
const { createAttemptGuard } = require('../src/security');

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

test('trial register creates a 7 day trial', async () => {
  const { server, base } = await startServer();
  try {
    const { status, body } = await call(base, 'POST', '/api/trial/register', {
      deviceId: 'device-1',
    });
    assert.equal(status, 200);
    assert.equal(body.deviceId, 'device-1');
    const start = new Date(body.trialStart).getTime();
    const end = new Date(body.trialEnd).getTime();
    assert.equal(end - start, 7 * 24 * 60 * 60 * 1000);
    assert.equal(body.daysLeft, 7);
  } finally {
    server.close();
  }
});

test('trial register again returns the same first start date', async () => {
  const { server, base } = await startServer();
  try {
    const first = await call(base, 'POST', '/api/trial/register', { deviceId: 'device-2' });
    const second = await call(base, 'POST', '/api/trial/register', { deviceId: 'device-2' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.trialStart, first.body.trialStart);
    assert.equal(second.body.trialEnd, first.body.trialEnd);
  } finally {
    server.close();
  }
});

test('trial register refuses a bad device id', async () => {
  const { server, base } = await startServer();
  try {
    for (const bad of ['', '   ', 'has space', 'bad/id', 'x'.repeat(200), 123, null]) {
      const { status, body } = await call(base, 'POST', '/api/trial/register', {
        deviceId: bad,
      });
      assert.equal(status, 400, `deviceId ${JSON.stringify(bad)}`);
      assert.equal(typeof body.error, 'string');
    }
  } finally {
    server.close();
  }
});

test('trial register honours an earlier first seen date', async () => {
  const { server, base } = await startServer();
  try {
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { status, body } = await call(base, 'POST', '/api/trial/register', {
      deviceId: 'device-early',
      firstSeenAt: past,
    });
    assert.equal(status, 200);
    assert.equal(body.trialStart, past);
    assert.equal(body.daysLeft, 4);
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const clamped = await call(base, 'POST', '/api/trial/register', {
      deviceId: 'device-future',
      firstSeenAt: future,
    });
    assert.equal(clamped.status, 200);
    assert.ok(new Date(clamped.body.trialStart).getTime() <= Date.now());
  } finally {
    server.close();
  }
});

test('two devices get their own trials', async () => {
  const { server, base } = await startServer();
  try {
    const a = await call(base, 'POST', '/api/trial/register', { deviceId: 'device-a' });
    const b = await call(base, 'POST', '/api/trial/register', { deviceId: 'device-b' });
    assert.equal(a.body.deviceId, 'device-a');
    assert.equal(b.body.deviceId, 'device-b');
  } finally {
    server.close();
  }
});

test('health reports the version and the store kind', async () => {
  const { server, base } = await startServer({
    adminKey: ADMIN_KEY,
    version: '1.3.0',
    storeKind: 'memory',
  });
  try {
    const { status, body } = await call(base, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'aduro-pos-server');
    assert.equal(body.version, '1.3.0');
    assert.equal(body.store, 'memory');
  } finally {
    server.close();
  }
});

test('accra day range is one UTC day and refuses bad dates', () => {
  const range = accraDayRange('2026-11-21');
  assert.equal(range.start, '2026-11-21T00:00:00.000Z');
  assert.equal(range.end, '2026-11-22T00:00:00.000Z');
  assert.equal(accraDayRange('2026-13-01'), null);
  assert.equal(accraDayRange('2026-02-30'), null);
  assert.equal(accraDayRange('not a date'), null);
  assert.equal(accraDayRange(''), null);
});

test('sales for one date only, and recent sales newest first', async () => {
  const store = new MemoryStore();
  await store.init();
  const sale = (id, at) => ({
    id,
    totalPesewas: 100,
    profitPesewas: 10,
    createdAt: at,
  });
  await store.upsertSale('shop-1', 's1', sale('s1', '2026-11-20T10:00:00.000Z'));
  await store.upsertSale('shop-1', 's2', sale('s2', '2026-11-21T09:00:00.000Z'));
  await store.upsertSale('shop-1', 's3', sale('s3', '2026-11-21T18:00:00.000Z'));
  await store.upsertSale('shop-1', 's4', sale('s4', '2026-11-22T08:00:00.000Z'));

  const day = await store.listSalesForDate('shop-1', '2026-11-21');
  assert.deepEqual(day.map((s) => s.id), ['s2', 's3']);
  const recent = await store.listRecentSales('shop-1', 2);
  assert.deepEqual(recent.map((s) => s.id), ['s4', 's3']);
  const none = await store.listSalesForDate('shop-1', '2026-11-23');
  assert.deepEqual(none, []);
});

test('attempt guard drops a quiet record after the idle time', async () => {
  const guard = createAttemptGuard({ maxFailures: 2, lockoutMs: 60000, idleMs: 5 });
  guard.fail('quiet-key');
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The first failure was dropped, so this failure is the first
  // again and does not lock. A second failure then locks.
  assert.equal(guard.fail('quiet-key'), null);
  assert.notEqual(guard.fail('quiet-key'), null);
  assert.notEqual(guard.lockedUntil('quiet-key'), null);
});
