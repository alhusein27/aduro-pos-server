// Storage. The routes talk to a store through the plain methods below
// and do not care which kind of store it is.
//
// MemoryStore keeps everything in Maps. It is only for trying the
// server out on your own computer. When the server stops, all of it
// is gone.
//
// PgStore keeps everything in PostgreSQL, so it survives restarts.
// That is the store the live server uses.

class MemoryStore {
  constructor() {
    this.shops = new Map();
    this.shopsByCode = new Map();
    this.devices = new Map();
    this.devicesByTokenHash = new Map();
    this.joinCodes = new Map();
    this.salesByShop = new Map();
    this.debtorsByShop = new Map();
    this.summaryByShop = new Map();
    this.entries = [];
    this.seqCounter = 0;
  }

  async init() {}

  async createShop(shop) {
    this.shops.set(shop.id, shop);
    this.shopsByCode.set(shop.code, shop);
    return shop;
  }

  async getShopByCode(code) {
    return this.shopsByCode.get(code) || null;
  }

  async getShopById(id) {
    return this.shops.get(id) || null;
  }

  async createDevice(device) {
    this.devices.set(device.id, device);
    this.devicesByTokenHash.set(device.tokenHash, device);
    return device;
  }

  async findDeviceByTokenHash(tokenHash) {
    return this.devicesByTokenHash.get(tokenHash) || null;
  }

  async touchDevice(id) {
    const device = this.devices.get(id);
    if (device) device.lastSeenAt = new Date().toISOString();
  }

  async createJoinCode(record) {
    this.joinCodes.set(record.id, record);
    return record;
  }

  async findJoinCode(shopId, code) {
    for (const record of this.joinCodes.values()) {
      if (record.shopId === shopId && record.code === code) return record;
    }
    return null;
  }

  async markJoinCodeUsed(id) {
    const record = this.joinCodes.get(id);
    if (record) record.usedAt = new Date().toISOString();
  }

  // Stores one sync entry. Returns true when it is new, false when this
  // shop has already sent an entry with the same id.
  async addEntry(entry) {
    const seen = this.entries.some(
      (item) => item.shopId === entry.shopId && item.entryId === entry.entryId,
    );
    if (seen) return { stored: false, seq: null };
    this.seqCounter += 1;
    this.entries.push({ ...entry, seq: this.seqCounter });
    return { stored: true, seq: this.seqCounter };
  }

  // Keeps the newest copy of a sale. A sale_update for a sale that is
  // already stored replaces the old copy.
  async upsertSale(shopId, saleId, payload) {
    if (!this.salesByShop.has(shopId)) this.salesByShop.set(shopId, new Map());
    this.salesByShop.get(shopId).set(saleId, payload);
  }

  async listSales(shopId) {
    const byId = this.salesByShop.get(shopId);
    return byId ? [...byId.values()] : [];
  }

  // Keeps the newest copy of a debtor, with the balance the till
  // worked out from its ledger.
  async upsertDebtor(shopId, debtorId, payload) {
    if (!this.debtorsByShop.has(shopId)) this.debtorsByShop.set(shopId, new Map());
    this.debtorsByShop.get(shopId).set(debtorId, payload);
  }

  async listDebtors(shopId) {
    const byId = this.debtorsByShop.get(shopId);
    return byId ? [...byId.values()] : [];
  }

  // Keeps the newest stock picture for the shop.
  async saveSummary(shopId, payload) {
    this.summaryByShop.set(shopId, payload);
  }

  async getSummary(shopId) {
    return this.summaryByShop.get(shopId) || null;
  }

  async listEntriesSince(shopId, since, limit = 500) {
    return this.entries
      .filter((item) => item.shopId === shopId && item.seq > since)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async latestSeq(shopId) {
    let latest = 0;
    for (const item of this.entries) {
      if (item.shopId === shopId && item.seq > latest) latest = item.seq;
    }
    return latest;
  }

  // Founder portal: every shop, newest first, with no token hashes.
  async listShops() {
    return [...this.shops.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(publicShop);
  }

  // Founder portal: the devices of one shop, oldest first, with no
  // token hashes.
  async listDevices(shopId) {
    return [...this.devices.values()]
      .filter((device) => device.shopId === shopId)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(publicDevice);
  }

  // Founder portal: small counts for one shop, and the last time
  // anything happened there. Activity is the latest device last seen
  // time or sale time, whichever is newer.
  async shopStats(shopId) {
    let deviceCount = 0;
    let lastActivityAt = null;
    const consider = (iso) => {
      if (iso && (!lastActivityAt || String(iso) > lastActivityAt)) {
        lastActivityAt = String(iso);
      }
    };
    for (const device of this.devices.values()) {
      if (device.shopId !== shopId) continue;
      deviceCount += 1;
      consider(device.lastSeenAt);
    }
    const byId = this.salesByShop.get(shopId);
    const sales = byId ? [...byId.values()] : [];
    for (const sale of sales) consider(sale.createdAt);
    return { deviceCount, salesCount: sales.length, lastActivityAt };
  }
}

class PgStore {
  constructor(connectionString) {
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString });
  }

  async init() {
    await this.pool.query(`
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
    `);
  }

  async createShop(shop) {
    await this.pool.query(
      `INSERT INTO shops (id, code, name, town, owner_name, owner_token_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [shop.id, shop.code, shop.name, shop.town, shop.ownerName, shop.ownerTokenHash, shop.createdAt],
    );
    return shop;
  }

  async getShopByCode(code) {
    const result = await this.pool.query('SELECT * FROM shops WHERE code = $1', [code]);
    if (result.rows.length === 0) return null;
    return rowToShop(result.rows[0]);
  }

  async getShopById(id) {
    const result = await this.pool.query('SELECT * FROM shops WHERE id = $1', [id]);
    if (result.rows.length === 0) return null;
    return rowToShop(result.rows[0]);
  }

  async createDevice(device) {
    await this.pool.query(
      `INSERT INTO devices (id, shop_id, label, staff_name, role, token_hash, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        device.id, device.shopId, device.label, device.staffName, device.role,
        device.tokenHash, device.createdAt, device.lastSeenAt,
      ],
    );
    return device;
  }

  async findDeviceByTokenHash(tokenHash) {
    const result = await this.pool.query('SELECT * FROM devices WHERE token_hash = $1', [tokenHash]);
    if (result.rows.length === 0) return null;
    return rowToDevice(result.rows[0]);
  }

  async touchDevice(id) {
    await this.pool.query('UPDATE devices SET last_seen_at = $1 WHERE id = $2', [
      new Date().toISOString(),
      id,
    ]);
  }

  async createJoinCode(record) {
    await this.pool.query(
      `INSERT INTO join_codes (id, shop_id, code, staff_name, device_label, expires_at, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id, record.shopId, record.code, record.staffName, record.deviceLabel,
        record.expiresAt, record.usedAt, record.createdAt,
      ],
    );
    return record;
  }

  async findJoinCode(shopId, code) {
    const result = await this.pool.query(
      'SELECT * FROM join_codes WHERE shop_id = $1 AND code = $2 ORDER BY created_at DESC LIMIT 1',
      [shopId, code],
    );
    if (result.rows.length === 0) return null;
    return rowToJoinCode(result.rows[0]);
  }

  async markJoinCodeUsed(id) {
    await this.pool.query('UPDATE join_codes SET used_at = $1 WHERE id = $2', [
      new Date().toISOString(),
      id,
    ]);
  }

  async addEntry(entry) {
    const result = await this.pool.query(
      `INSERT INTO entries (shop_id, entry_id, device_id, kind, device_label, sale_number, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (shop_id, entry_id) DO NOTHING
       RETURNING seq`,
      [
        entry.shopId, entry.entryId, entry.deviceId, entry.kind, entry.deviceLabel,
        entry.saleNumber, entry.payload === null ? null : JSON.stringify(entry.payload),
        entry.createdAt,
      ],
    );
    if (result.rows.length === 0) return { stored: false, seq: null };
    return { stored: true, seq: Number(result.rows[0].seq) };
  }

  async upsertSale(shopId, saleId, payload) {
    await this.pool.query(
      `INSERT INTO sales (shop_id, sale_id, payload, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop_id, sale_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [shopId, saleId, JSON.stringify(payload), new Date().toISOString()],
    );
  }

  async listSales(shopId) {
    const result = await this.pool.query('SELECT payload FROM sales WHERE shop_id = $1', [shopId]);
    return result.rows.map((row) => row.payload);
  }

  async upsertDebtor(shopId, debtorId, payload) {
    await this.pool.query(
      `INSERT INTO debtors (shop_id, debtor_id, payload, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop_id, debtor_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [shopId, debtorId, JSON.stringify(payload), new Date().toISOString()],
    );
  }

  async listDebtors(shopId) {
    const result = await this.pool.query('SELECT payload FROM debtors WHERE shop_id = $1', [shopId]);
    return result.rows.map((row) => row.payload);
  }

  async saveSummary(shopId, payload) {
    await this.pool.query(
      `INSERT INTO shop_summaries (shop_id, payload, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (shop_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [shopId, JSON.stringify(payload), new Date().toISOString()],
    );
  }

  async getSummary(shopId) {
    const result = await this.pool.query('SELECT payload FROM shop_summaries WHERE shop_id = $1', [shopId]);
    return result.rows.length ? result.rows[0].payload : null;
  }

  async listEntriesSince(shopId, since, limit = 500) {
    const result = await this.pool.query(
      `SELECT * FROM entries WHERE shop_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [shopId, since, limit],
    );
    return result.rows.map(rowToEntry);
  }

  async latestSeq(shopId) {
    const result = await this.pool.query(
      'SELECT COALESCE(MAX(seq), 0) AS latest FROM entries WHERE shop_id = $1',
      [shopId],
    );
    return Number(result.rows[0].latest);
  }

  // Founder portal: every shop, newest first, with no token hashes.
  async listShops() {
    const result = await this.pool.query(
      `SELECT id, code, name, town, owner_name, created_at FROM shops
       ORDER BY created_at DESC`,
    );
    return result.rows.map(rowToShopPublic);
  }

  // Founder portal: the devices of one shop, oldest first, with no
  // token hashes.
  async listDevices(shopId) {
    const result = await this.pool.query(
      `SELECT id, label, staff_name, role, created_at, last_seen_at FROM devices
       WHERE shop_id = $1 ORDER BY created_at ASC`,
      [shopId],
    );
    return result.rows.map(rowToDevicePublic);
  }

  // Founder portal: small counts for one shop, and the last time
  // anything happened there.
  async shopStats(shopId) {
    const devices = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM devices WHERE shop_id = $1',
      [shopId],
    );
    const sales = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM sales WHERE shop_id = $1',
      [shopId],
    );
    const activity = await this.pool.query(
      `SELECT GREATEST(
         (SELECT MAX(last_seen_at) FROM devices WHERE shop_id = $1),
         (SELECT MAX(payload ->> 'createdAt') FROM sales WHERE shop_id = $1)
       ) AS last_activity`,
      [shopId],
    );
    return {
      deviceCount: devices.rows[0].count,
      salesCount: sales.rows[0].count,
      lastActivityAt: activity.rows[0].last_activity || null,
    };
  }
}

// The shop fields the founder portal may see. The owner token hash is
// never handed out.
function publicShop(shop) {
  return {
    id: shop.id,
    code: shop.code,
    name: shop.name,
    town: shop.town,
    ownerName: shop.ownerName,
    createdAt: shop.createdAt,
  };
}

// The device fields the founder portal may see. The token hash is
// never handed out.
function publicDevice(device) {
  return {
    id: device.id,
    label: device.label,
    staffName: device.staffName,
    role: device.role,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
  };
}

function rowToShopPublic(row) {
  return publicShop({
    id: row.id,
    code: row.code,
    name: row.name,
    town: row.town,
    ownerName: row.owner_name,
    createdAt: row.created_at,
  });
}

function rowToDevicePublic(row) {
  return publicDevice({
    id: row.id,
    label: row.label,
    staffName: row.staff_name,
    role: row.role,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  });
}

function rowToShop(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    town: row.town,
    ownerName: row.owner_name,
    ownerTokenHash: row.owner_token_hash,
    createdAt: row.created_at,
  };
}

function rowToDevice(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    label: row.label,
    staffName: row.staff_name,
    role: row.role,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function rowToJoinCode(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    code: row.code,
    staffName: row.staff_name,
    deviceLabel: row.device_label,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

function rowToEntry(row) {
  return {
    seq: Number(row.seq),
    shopId: row.shop_id,
    entryId: row.entry_id,
    deviceId: row.device_id,
    kind: row.kind,
    deviceLabel: row.device_label,
    saleNumber: row.sale_number,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

module.exports = { MemoryStore, PgStore };
