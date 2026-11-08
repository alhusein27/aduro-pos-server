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

test('the admin page loads and names Aduro POS', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const response = await fetch(base + '/admin');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Aduro POS Admin/);
});

test('admin api refuses without the key and lists shops with it', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const noKey = await fetch(base + '/admin/api/shops');
  assert.equal(noKey.status, 401);
  const created = await fetch(base + '/admin/shops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ name: 'Osei Chemical Store', ownerName: 'Osei', town: 'Kibi' }),
  });
  assert.equal(created.status, 201);
  const listResponse = await fetch(base + '/admin/api/shops', {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  const list = await listResponse.json();
  const shops = list.shops || list;
  assert.equal(shops.length, 1);
  assert.equal(shops[0].name, 'Osei Chemical Store');
});
