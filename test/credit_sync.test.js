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
  return { server, base: `http://127.0.0.1:${server.address().port}` };
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

async function shopOwnerTill(base) {
  const created = await call(base, 'POST', '/admin/shops', {
    headers: { 'x-admin-key': ADMIN_KEY },
    body: { name: 'Osei Chemical Store', ownerName: 'Osei', town: 'Kibi' },
  });
  const owner = await call(base, 'POST', '/api/link/owner', {
    body: { shopCode: created.json.shopCode, ownerToken: created.json.ownerToken },
  });
  const join = await call(base, 'POST', '/api/devices/join-code', {
    token: owner.json.deviceToken,
    body: { staffName: 'Shop till', deviceLabel: 'Shop till' },
  });
  const till = await call(base, 'POST', '/api/link/staff', {
    body: { shopCode: created.json.shopCode, joinCode: join.json.joinCode },
  });
  return { ownerToken: owner.json.deviceToken, tillToken: till.json.deviceToken };
}

function debtorEntry(id, balance, ledgerCount, dueDate) {
  return {
    id: `debtor-${id}-${balance}-${ledgerCount}`,
    kind: 'debtor',
    payload: {
      id,
      name: 'Ama Serwaa',
      phone: '0244000000',
      firstTakenDate: '2026-11-01T00:00:00.000Z',
      dueDate,
      balancePesewas: balance,
    },
    createdAt: '2026-11-08T09:00:00.000Z',
  };
}

test('debtors go up and the owner reads the credit book', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { ownerToken, tillToken } = await shopOwnerTill(base);

  const push = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: {
      entries: [
        debtorEntry('d1', 4500, 2, '2026-11-10T00:00:00.000Z'),
        debtorEntry('d2', 1200, 1, '2026-11-09T00:00:00.000Z'),
      ],
    },
  });
  assert.equal(push.status, 200);
  assert.equal(push.json.accepted.length, 2);

  const credit = await call(base, 'GET', '/api/owner/credit', { token: ownerToken });
  assert.equal(credit.status, 200);
  assert.equal(credit.json.totalOwedPesewas, 5700);
  assert.equal(credit.json.debtors.length, 2);
  // Sorted by due date: d2 (9th) before d1 (10th).
  assert.equal(credit.json.debtors[0].id, 'd2');

  // A part payment changes the balance; a fresh entry updates the copy.
  const pay = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: { entries: [debtorEntry('d1', 2000, 3, '2026-11-10T00:00:00.000Z')] },
  });
  assert.equal(pay.json.accepted.length, 1);
  const after = await call(base, 'GET', '/api/owner/credit', { token: ownerToken });
  assert.equal(after.json.totalOwedPesewas, 3200);

  // Fully paid debtors leave the book.
  await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: { entries: [debtorEntry('d2', 0, 2, '2026-11-09T00:00:00.000Z')] },
  });
  const cleared = await call(base, 'GET', '/api/owner/credit', { token: ownerToken });
  assert.equal(cleared.json.debtors.length, 1);
  assert.equal(cleared.json.totalOwedPesewas, 2000);
});

test('the stock summary rides to the owner today answer', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { ownerToken, tillToken } = await shopOwnerTill(base);

  const before = await call(base, 'GET', '/api/owner/today', { token: ownerToken });
  assert.equal(before.json.stockSummary, null);

  const push = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: {
      entries: [{
        id: 'summary-2026-11-08-3-12500-2',
        kind: 'stock_summary',
        payload: {
          date: '2026-11-08',
          expiringBatchCount: 3,
          valueAtRiskPesewas: 12500,
          lowStockCount: 2,
          savedAt: '2026-11-08T09:00:00.000Z',
        },
        createdAt: '2026-11-08T09:00:00.000Z',
      }],
    },
  });
  assert.equal(push.json.accepted.length, 1);

  const today = await call(base, 'GET', '/api/owner/today', { token: ownerToken });
  assert.equal(today.json.stockSummary.expiringBatchCount, 3);
  assert.equal(today.json.stockSummary.valueAtRiskPesewas, 12500);
  assert.equal(today.json.stockSummary.lowStockCount, 2);
});

test('the till cannot read the credit book, and bad debtors are refused', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const { tillToken } = await shopOwnerTill(base);

  const res = await call(base, 'GET', '/api/owner/credit', { token: tillToken });
  assert.equal(res.status, 403);

  const bad = await call(base, 'POST', '/api/sync/push', {
    token: tillToken,
    body: { entries: [{ id: 'debtor-d9-x-1', kind: 'debtor', payload: { id: 'd9' }, createdAt: '2026-11-08T09:00:00.000Z' }] },
  });
  assert.equal(bad.json.rejected.length, 1);
  assert.match(bad.json.rejected[0].reason, /balance/);
});
