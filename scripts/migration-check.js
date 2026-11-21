// Migration check: proves the current PgStore init() upgrades a
// database that already holds the previous schema, without losing
// a row. Run against a scratch database only, never production:
//
//   node scripts/migration-check.js
//
// It creates a scratch database, builds the old (v1.2.0) schema
// with sample rows, runs the new init(), checks the old rows
// survived and the new table and indexes exist, then drops the
// scratch database again. The password comes from PGPASSWORD or
// defaults to the local scratch password.

const { Client, Pool } = require('pg');
const { PgStore } = require('../src/store');

const SCRATCH_DB = 'aduro_migration_scratch';
const config = (database) => ({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database,
});

// The v1.2.0 schema: every table except trials, and no indexes.
const OLD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS shops (
    id text PRIMARY KEY,
    code text UNIQUE NOT NULL,
    name text NOT NULL,
    town text NOT NULL DEFAULT '',
    owner_name text NOT NULL,
    owner_token_hash text NOT NULL,
    created_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id text PRIMARY KEY,
    shop_id text NOT NULL REFERENCES shops(id),
    label text NOT NULL,
    staff_name text NOT NULL DEFAULT '',
    role text NOT NULL,
    token_hash text NOT NULL,
    created_at text NOT NULL,
    last_seen_at text
  );
  CREATE TABLE IF NOT EXISTS join_codes (
    id text PRIMARY KEY,
    shop_id text NOT NULL REFERENCES shops(id),
    code text NOT NULL,
    staff_name text NOT NULL,
    device_label text NOT NULL DEFAULT '',
    expires_at text NOT NULL,
    used_at text,
    created_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sales (
    shop_id text NOT NULL REFERENCES shops(id),
    sale_id text NOT NULL,
    payload jsonb NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (shop_id, sale_id)
  );
  CREATE TABLE IF NOT EXISTS debtors (
    shop_id text NOT NULL REFERENCES shops(id),
    debtor_id text NOT NULL,
    payload jsonb NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (shop_id, debtor_id)
  );
  CREATE TABLE IF NOT EXISTS shop_summaries (
    shop_id text PRIMARY KEY REFERENCES shops(id),
    payload jsonb NOT NULL,
    updated_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    seq bigserial PRIMARY KEY,
    shop_id text NOT NULL REFERENCES shops(id),
    entry_id text NOT NULL,
    device_id text,
    kind text NOT NULL,
    device_label text,
    sale_number text,
    payload jsonb,
    created_at text NOT NULL,
    UNIQUE (shop_id, entry_id)
  );
`;

function check(name, ok) {
  if (!ok) throw new Error(`FAILED: ${name}`);
  console.log(`ok: ${name}`);
}

async function main() {
  const admin = new Client(config('postgres'));
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  const pool = new Pool(config(SCRATCH_DB));
  try {
    await pool.query(OLD_SCHEMA);
    await pool.query(
      `INSERT INTO shops (id, code, name, town, owner_name, owner_token_hash, created_at)
       VALUES ('shop-old', 'OLD123', 'Old Shop', 'Osino', 'Ama', 'hash', '2026-11-01T00:00:00.000Z')`,
    );
    await pool.query(
      `INSERT INTO devices (id, shop_id, label, staff_name, role, token_hash, created_at, last_seen_at)
       VALUES ('dev-old', 'shop-old', 'Till', 'Efua', 'staff', 'tokhash', '2026-11-01T00:00:00.000Z', null)`,
    );
    await pool.query(
      `INSERT INTO sales (shop_id, sale_id, payload, updated_at)
       VALUES ('shop-old', 'sale-old', '{"id":"sale-old","totalPesewas":5000,"createdAt":"2026-11-21T10:00:00.000Z"}', '2026-11-21T10:00:00.000Z')`,
    );

    // The new init() runs against the old schema.
    const store = new PgStore(
      `postgres://postgres:${encodeURIComponent(process.env.PGPASSWORD || 'postgres')}@127.0.0.1:5432/${SCRATCH_DB}`,
    );
    await store.init();

    const shop = await store.getShopByCode('OLD123');
    check('old shop row survives the upgrade', shop && shop.name === 'Old Shop');
    const device = await store.findDeviceByTokenHash('tokhash');
    check('old device row survives the upgrade', device && device.id === 'dev-old');
    const daySales = await store.listSalesForDate('shop-old', '2026-11-21');
    check('date filtered sales read the old sale', daySales.length === 1 && daySales[0].id === 'sale-old');
    const otherDay = await store.listSalesForDate('shop-old', '2026-11-20');
    check('date filter excludes another day', otherDay.length === 0);
    const recent = await store.listRecentSales('shop-old', 5);
    check('recent sales read the old sale', recent.length === 1);

    const trial = await store.registerTrial('device-9', '2026-11-21T12:00:00.000Z');
    check('trial records on the upgraded schema', trial.trialStart === '2026-11-21T12:00:00.000Z');
    const again = await store.registerTrial('device-9', '2026-11-22T12:00:00.000Z');
    check('second register keeps the first start', again.trialStart === '2026-11-21T12:00:00.000Z');

    const indexes = await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('devices', 'entries', 'join_codes')",
    );
    const names = indexes.rows.map((r) => r.indexname);
    check('token hash index exists', names.includes('devices_token_hash_idx'));
    check('entries shop seq index exists', names.includes('entries_shop_seq_idx'));
    check('join codes index exists', names.includes('join_codes_shop_code_idx'));

    // init() a second time must also pass: redeploys run it again.
    await store.init();
    check('second init passes', true);
    await store.close();
    console.log('Migration check passed.');
  } finally {
    await pool.end();
    const admin2 = new Client(config('postgres'));
    await admin2.connect();
    await admin2.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin2.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
