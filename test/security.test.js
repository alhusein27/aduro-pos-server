const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/store');
const { timingSafeCompare, createAttemptGuard } = require('../src/security');

const ADMIN_KEY = 'test-admin-key-for-tests-only';

async function startServer() {
  const store = new MemoryStore();
  await store.init();
  const app = createApp(store, { adminKey: ADMIN_KEY });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function call(base, method, path, { body, token, headers } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json, headers: response.headers };
}

async function makeShop(base) {
  const res = await call(base, 'POST', '/admin/shops', {
    headers: { 'x-admin-key': ADMIN_KEY },
    body: { name: 'Test Chemical Store', ownerName: 'Test Owner' },
  });
  assert.equal(res.status, 201);
  return res.json;
}

async function linkOwner(base, shop) {
  const res = await call(base, 'POST', '/api/link/owner', {
    body: { shopCode: shop.shopCode, ownerToken: shop.ownerToken },
  });
  assert.equal(res.status, 200);
  return res.json;
}

async function makeJoinCode(base, ownerToken, staffName) {
  const res = await call(base, 'POST', '/api/devices/join-code', {
    token: ownerToken,
    body: { staffName, deviceLabel: staffName },
  });
  assert.equal(res.status, 200);
  return res.json.joinCode;
}

test('timingSafeCompare matches equal secrets and rejects different ones', () => {
  assert.equal(timingSafeCompare('abc', 'abc'), true);
  assert.equal(timingSafeCompare('abc', 'abd'), false);
  assert.equal(timingSafeCompare('short', 'a much longer secret'), false);
});

test('the attempt guard locks after five failures and a success clears it', () => {
  const guard = createAttemptGuard({ maxFailures: 5, lockoutMs: 15 * 60 * 1000 });
  for (let i = 0; i < 4; i += 1) {
    guard.fail('k1');
    assert.equal(guard.lockedUntil('k1'), null);
  }
  guard.fail('k1');
  assert.ok(guard.lockedUntil('k1') > Date.now());
  guard.fail('k2');
  guard.pass('k2');
  for (let i = 0; i < 4; i += 1) {
    guard.fail('k2');
    assert.equal(guard.lockedUntil('k2'), null);
  }
});

test('security headers are on every answer and X-Powered-By is gone', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('strict-transport-security') || '', /max-age=31536000/);
  const csp = response.headers.get('content-security-policy') || '';
  // Scripts may only come from this server. Styles allow inline
  // because the portal styles stay inline; a style cannot run code.
  assert.match(csp, /script-src 'self';/);
  assert.equal(response.headers.get('x-powered-by'), null);
});

test('the admin page carries no inline script; the script lives in /admin.js', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const page = await fetch(`${base}/admin`);
  const html = await page.text();
  assert.match(html, /src="\/admin.js"/);
  assert.doesNotMatch(html, /var KEY_NAME/);
  const script = await fetch(`${base}/admin.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') || '', /javascript/);
  assert.match(await script.text(), /renderShops/);
});

test('five wrong owner tokens lock the shop link out', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const shop = await makeShop(base);
  for (let i = 0; i < 5; i += 1) {
    const res = await call(base, 'POST', '/api/link/owner', {
      body: { shopCode: shop.shopCode, ownerToken: 'wrong-token' },
    });
    assert.equal(res.status, 401);
  }
  const locked = await call(base, 'POST', '/api/link/owner', {
    body: { shopCode: shop.shopCode, ownerToken: 'wrong-token' },
  });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  // The right token is refused too while locked.
  const right = await call(base, 'POST', '/api/link/owner', {
    body: { shopCode: shop.shopCode, ownerToken: shop.ownerToken },
  });
  assert.equal(right.status, 429);
});

test('five wrong join codes lock the staff link out', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const shop = await makeShop(base);
  for (let i = 0; i < 5; i += 1) {
    const res = await call(base, 'POST', '/api/link/staff', {
      body: { shopCode: shop.shopCode, joinCode: '000000' },
    });
    assert.equal(res.status, 400);
  }
  const locked = await call(base, 'POST', '/api/link/staff', {
    body: { shopCode: shop.shopCode, joinCode: '000000' },
  });
  assert.equal(locked.status, 429);
});

test('two phones sending the same join code at once cannot both win', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const shop = await makeShop(base);
  const owner = await linkOwner(base, shop);
  const code = await makeJoinCode(base, owner.deviceToken, 'Till One');
  const [first, second] = await Promise.all([
    call(base, 'POST', '/api/link/staff', {
      body: { shopCode: shop.shopCode, joinCode: code },
    }),
    call(base, 'POST', '/api/link/staff', {
      body: { shopCode: shop.shopCode, joinCode: code },
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  const loser = first.status === 400 ? first : second;
  assert.match(loser.json.error, /already been used/);
});

test('push refuses bad kinds and bad totals, and accepts a good sale', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const shop = await makeShop(base);
  const owner = await linkOwner(base, shop);
  const goodSale = {
    id: 'sale-good', attendant: 'Efua', tender: 'cash',
    lines: [], totalPesewas: 500, createdAt: new Date().toISOString(),
  };
  const res = await call(base, 'POST', '/api/sync/push', {
    token: owner.deviceToken,
    body: {
      entries: [
        { id: 'e1', kind: 'sale', payload: goodSale },
        { id: 'e2', kind: 'Sale!', payload: goodSale },
        { id: 'e3', kind: 'sale', payload: { ...goodSale, id: 's-neg', totalPesewas: -100 } },
        { id: 'e4', kind: 'sale', payload: { ...goodSale, id: 's-frac', totalPesewas: 10.5 } },
        { id: 'e5', kind: 'sale', payload: { ...goodSale, id: 's-huge', totalPesewas: 100000001 } },
        { id: 'e6', kind: 'debtor', payload: { id: 'd1', balancePesewas: -50 } },
        { id: 'e7', kind: 'debtor', payload: { id: 'd2', balancePesewas: 2500 } },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.accepted, ['e1', 'e7']);
  assert.deepEqual(res.json.rejected.map((r) => r.id), ['e2', 'e3', 'e4', 'e5', 'e6']);
});

test('a device can be revoked, and a revoked token stops working', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const shop = await makeShop(base);
  const owner = await linkOwner(base, shop);
  const code = await makeJoinCode(base, owner.deviceToken, 'Till One');
  const staff = await call(base, 'POST', '/api/link/staff', {
    body: { shopCode: shop.shopCode, joinCode: code },
  });
  assert.equal(staff.status, 200);
  const staffDeviceId = staff.json.device.id;
  // A staff device cannot revoke.
  const staffTry = await call(base, 'DELETE', `/api/devices/${owner.device.id}`, {
    token: staff.json.deviceToken,
  });
  assert.equal(staffTry.status, 403);
  // The owner cannot revoke his own device.
  const selfTry = await call(base, 'DELETE', `/api/devices/${owner.device.id}`, {
    token: owner.deviceToken,
  });
  assert.equal(selfTry.status, 400);
  // The owner revokes the till.
  const revoked = await call(base, 'DELETE', `/api/devices/${staffDeviceId}`, {
    token: owner.deviceToken,
  });
  assert.equal(revoked.status, 200);
  // The revoked token is refused at once.
  const after = await call(base, 'POST', '/api/sync/push', {
    token: staff.json.deviceToken,
    body: { entries: [] },
  });
  assert.equal(after.status, 401);
  // The founder can revoke from the portal side too.
  const code2 = await makeJoinCode(base, owner.deviceToken, 'Till Two');
  const staff2 = await call(base, 'POST', '/api/link/staff', {
    body: { shopCode: shop.shopCode, joinCode: code2 },
  });
  assert.equal(staff2.status, 200);
  const adminRevoke = await call(base, 'DELETE', `/admin/api/devices/${staff2.json.device.id}`, {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert.equal(adminRevoke.status, 200);
});

// This test locks the admin key for this address, so it runs last:
// no later test in this file may need the admin key.
test('five wrong admin keys lock the founder portal out', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  for (let i = 0; i < 5; i += 1) {
    const res = await call(base, 'GET', '/admin/api/shops', {
      headers: { 'x-admin-key': 'wrong-key' },
    });
    assert.equal(res.status, 401);
  }
  const locked = await call(base, 'GET', '/admin/api/shops', {
    headers: { 'x-admin-key': 'wrong-key' },
  });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
});
