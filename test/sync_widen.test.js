const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/store');

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
  return { status: response.status, json };
}

async function shopWithTill(base) {
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
  const join = await call(base, 'POST', '/api/devices/join-code', {
    token: owner.json.deviceToken,
    body: { staffName: 'Shop till', deviceLabel: 'Shop till' },
  });
  assert.equal(join.status, 200);
  const till = await call(base, 'POST', '/api/link/staff', {
    body: {
      shopCode: created.json.shopCode,
      joinCode: join.json.joinCode,
      deviceLabel: 'Shop till',
    },
  });
  assert.equal(till.status, 200);
  return { ownerToken: owner.json.deviceToken, tillToken: till.json.deviceToken };
}

const MEDICINE = {
  id: 'paracetamol',
  name: 'Paracetamol 500mg',
  unitName: 'Strip',
  sellPerUnitPesewas: 400,
  unitsInStock: 42,
  batchCount: 3,
};

const BATCH = {
  id: 'b1',
  medicineId: 'paracetamol',
  batchNumber: 'P-100',
  expiryDate: '2027-05-01T00:00:00.000Z',
  quantityUnits: 17,
  quarantined: false,
};

function booksPayload(staff) {
  return {
    expenses: [
      {
        id: 'e1',
        category: 'Transport',
        amountPesewas: 2000,
        note: '',
        attendant: 'Efua',
        date: '2026-11-25T00:00:00.000Z',
      },
    ],
    suppliers: [{ id: 's1', name: 'Ekow Pharma Wholesale', phone: '' }],
    supplierLines: [
      {
        id: 'l1',
        supplierId: 's1',
        kind: 'supply',
        amountPesewas: 45000,
        note: '',
        date: '2026-11-20T00:00:00.000Z',
      },
    ],
    staff: staff || [{ id: 'staff-a', name: 'Efua (Attendant A)', active: true, hasPin: false }],
  };
}

test('the widened pipe: medicine, batch and books reach the owner reads', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { ownerToken, tillToken } = await shopWithTill(base);

  const push = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: {
      entries: [
        { id: 'med-paracetamol-42-3-400', kind: 'medicine', payload: MEDICINE, createdAt: '2026-11-25T08:00:00.000Z' },
        { id: 'batch-b1-17-0', kind: 'batch', payload: BATCH, createdAt: '2026-11-25T08:00:00.000Z' },
        { id: 'books-abc123', kind: 'books', payload: booksPayload(), createdAt: '2026-11-25T08:00:00.000Z' },
      ],
    },
  });
  assert.equal(push.status, 200);
  assert.equal(push.json.accepted.length, 3);
  assert.equal(push.json.rejected.length, 0);

  const stock = await call(base, 'GET', '/api/owner/stock', { token: ownerToken });
  assert.equal(stock.status, 200);
  assert.equal(stock.json.medicines.length, 1);
  assert.equal(stock.json.medicines[0].unitsInStock, 42);
  assert.equal(stock.json.batches.length, 1);
  assert.equal(stock.json.batches[0].batchNumber, 'P-100');

  const books = await call(base, 'GET', '/api/owner/books', { token: ownerToken });
  assert.equal(books.status, 200);
  assert.equal(books.json.expenses.length, 1);
  assert.equal(books.json.suppliers[0].name, 'Ekow Pharma Wholesale');
  assert.equal(books.json.staff[0].hasPin, false);

  // A newer medicine state replaces the units.
  const push2 = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: {
      entries: [
        {
          id: 'med-paracetamol-40-3-400',
          kind: 'medicine',
          payload: { ...MEDICINE, unitsInStock: 40 },
          createdAt: '2026-11-25T09:00:00.000Z',
        },
      ],
    },
  });
  assert.equal(push2.json.accepted.length, 1);
  const stock2 = await call(base, 'GET', '/api/owner/stock', { token: ownerToken });
  assert.equal(stock2.json.medicines.length, 1);
  assert.equal(stock2.json.medicines[0].unitsInStock, 40);
});

test('a books entry carrying staff PIN material is refused whole', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { ownerToken, tillToken } = await shopWithTill(base);

  const dirty = booksPayload([
    { id: 'staff-a', name: 'Efua', active: true, pinHash: 'deadbeef', pinSalt: 'salt' },
  ]);
  const push = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: {
      entries: [
        { id: 'books-dirty1', kind: 'books', payload: dirty, createdAt: '2026-11-25T08:00:00.000Z' },
      ],
    },
  });
  assert.equal(push.status, 200);
  assert.equal(push.json.accepted.length, 0);
  assert.equal(push.json.rejected.length, 1);
  assert.match(push.json.rejected[0].reason, /PIN/);

  const books = await call(base, 'GET', '/api/owner/books', { token: ownerToken });
  assert.equal(books.status, 200);
  assert.deepEqual(books.json, { expenses: [], suppliers: [], supplierLines: [], staff: [] });
});

test('the till cannot read the owner stock or books, and bad shapes are refused', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { tillToken } = await shopWithTill(base);

  const stock = await call(base, 'GET', '/api/owner/stock', { token: tillToken });
  assert.equal(stock.status, 403);
  const books = await call(base, 'GET', '/api/owner/books', { token: tillToken });
  assert.equal(books.status, 403);

  const push = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: {
      entries: [
        { id: 'med-x', kind: 'medicine', payload: { name: 'No id' }, createdAt: '2026-11-25T08:00:00.000Z' },
        { id: 'books-x', kind: 'books', payload: { expenses: [] }, createdAt: '2026-11-25T08:00:00.000Z' },
      ],
    },
  });
  assert.equal(push.json.accepted.length, 0);
  assert.equal(push.json.rejected.length, 2);
});
