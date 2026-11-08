const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/store');

const ADMIN_KEY = 'test-admin-key-for-tests-only';

function accraTodayString() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Accra',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

const TODAY = accraTodayString();
const at = (time) => `${TODAY}T${time}.000Z`;

async function startServer(options) {
  const store = new MemoryStore();
  await store.init();
  const app = createApp(store, options || { adminKey: ADMIN_KEY });
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
  return { status: response.status, json };
}

// A sale record in the exact shape the Aduro POS app sends it.
function makeSale(overrides) {
  return {
    id: 's1001',
    attendant: 'Efua (Attendant A)',
    tender: 'cash',
    lines: [
      {
        medicineId: 'paracetamol',
        medicineName: 'Paracetamol 500mg',
        unitName: 'Strip',
        quantityUnits: 5,
        unitPricePesewas: 400,
        unitCostPesewas: 300,
      },
    ],
    totalPesewas: 2000,
    profitPesewas: 500,
    createdAt: at('08:40:00'),
    customerName: null,
    customerPhone: null,
    ...overrides,
  };
}

function makeEntry(sale) {
  return {
    id: `queue-${sale.id}`,
    kind: 'sale',
    device: 'Shop till',
    payload: sale,
    createdAt: sale.createdAt,
  };
}

// Creates a shop and links an owner device. Returns the pieces.
async function shopWithOwner(base) {
  const created = await call(base, 'POST', '/admin/shops', {
    headers: { 'x-admin-key': ADMIN_KEY },
    body: { name: 'Osei Chemical Store', ownerName: 'Osei', town: 'Kibi' },
  });
  assert.equal(created.status, 201);
  const owner = await call(base, 'POST', '/api/link/owner', {
    body: {
      shopCode: created.json.shopCode,
      ownerToken: created.json.ownerToken,
      deviceLabel: 'Owner phone',
    },
  });
  assert.equal(owner.status, 200);
  return { created: created.json, ownerToken: owner.json.deviceToken, shopCode: created.json.shopCode, ownerRawToken: created.json.ownerToken };
}

test('health answers with the aduro service name', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await call(base, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.service, 'aduro-pos-server');
});

test('full flow: create, link owner, join code, link till, push sale, owner sees it', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { ownerToken, created } = await shopWithOwner(base);

  const join = await call(base, 'POST', '/api/devices/join-code', {
    token: ownerToken,
    body: { staffName: 'Shop till', deviceLabel: 'Shop till' },
  });
  assert.equal(join.status, 200);
  assert.match(join.json.joinCode, /^\d{6}$/);

  const till = await call(base, 'POST', '/api/link/staff', {
    body: { shopCode: created.shopCode, joinCode: join.json.joinCode, deviceLabel: 'Shop till' },
  });
  assert.equal(till.status, 200);
  const tillToken = till.json.deviceToken;

  const sale = makeSale({});
  const push = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: { entries: [makeEntry(sale)] },
  });
  assert.equal(push.status, 200);
  assert.deepEqual(push.json.accepted, ['queue-s1001']);

  // The same entry again is a duplicate, never a second count.
  const again = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: { entries: [makeEntry(sale)] },
  });
  assert.deepEqual(again.json.duplicates, ['queue-s1001']);

  const today = await call(base, 'GET', '/api/owner/today', { token: ownerToken });
  assert.equal(today.status, 200);
  assert.equal(today.json.salesPesewas, 2000);
  assert.equal(today.json.cashPesewas, 2000);
  assert.equal(today.json.profitPesewas, 500);
  assert.equal(today.json.saleCount, 1);
  assert.equal(today.json.byAttendant['Efua (Attendant A)'], 2000);

  const day = await call(base, 'GET', `/api/owner/sales?date=${TODAY}`, { token: ownerToken });
  assert.equal(day.status, 200);
  assert.equal(day.json.sales.length, 1);
  assert.equal(day.json.sales[0].lines[0].medicineName, 'Paracetamol 500mg');
});

test('the till cannot open owner pages', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { ownerToken, created } = await shopWithOwner(base);
  const join = await call(base, 'POST', '/api/devices/join-code', {
    token: ownerToken,
    body: { staffName: 'Shop till', deviceLabel: 'Shop till' },
  });
  const till = await call(base, 'POST', '/api/link/staff', {
    body: { shopCode: created.shopCode, joinCode: join.json.joinCode },
  });
  const res = await call(base, 'GET', '/api/owner/today', { token: till.json.deviceToken });
  assert.equal(res.status, 403);
});

test('a sale missing its total is rejected in plain words', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { ownerToken } = await shopWithOwner(base);
  const bad = makeSale({ totalPesewas: undefined });
  delete bad.totalPesewas;
  const push = await call(base, 'POST', '/api/sync/push', {
    token: ownerToken,
    body: { entries: [makeEntry(bad)] },
  });
  assert.equal(push.status, 200);
  assert.equal(push.json.rejected.length, 1);
  assert.match(push.json.rejected[0].reason, /total/);
});

test('wrong shop code or owner token cannot link', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await call(base, 'POST', '/api/link/owner', {
    body: { shopCode: 'NOPE', ownerToken: 'nope' },
  });
  assert.equal(res.status, 401);
});

test('creating a shop needs the admin key', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await call(base, 'POST', '/admin/shops', {
    body: { name: 'X', ownerName: 'Y' },
  });
  assert.equal(res.status, 401);
});
