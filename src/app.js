// The Aduro POS sync server.
//
// Shops sell offline in the app all day. When a phone or till gets
// data, it pushes its queue of entries here. The server keeps the
// newest copy of every sale, so the owner can open any linked device
// and see the shop as it stands.
//
// Every error is answered as {error: "plain words"}. No error codes
// are ever sent in a message.

const path = require('path');
const express = require('express');
const { newToken, hashToken, newShopCode, newJoinCode, newId } = require('./tokens');
const { computeTotals } = require('./totals');
const { accraDateOf, accraToday, addMonths } = require('./dates');
const {
  timingSafeCompare,
  createAttemptGuard,
  createRequestCap,
  securityHeaders,
} = require('./security');

const JOIN_CODE_MINUTES = 30;
const MAX_PUSH_ENTRIES = 200;
const MAX_PULL_RECORDS = 500;
// The largest sale or debtor balance the server accepts: GHc1,000,000
// in pesewas. A chemical shop never sells that much in one sale.
const MAX_TOTAL_PESEWAS = 100000000;
const KIND_SHAPE = /^[a-z][a-z0-9_]{0,31}$/;

// Five wrong tries, then locked out for fifteen minutes.
const adminGuard = createAttemptGuard();
const ownerGuard = createAttemptGuard();
const staffGuard = createAttemptGuard();

function lockedAnswer(res, lockedUntil) {
  const waitSeconds = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
  res.setHeader('Retry-After', String(waitSeconds));
  return res.status(429).json({
    error: 'Too many wrong tries. Please wait a little and try again.',
  });
}

function createApp(store, options = {}) {
  const adminKey = options.adminKey !== undefined ? options.adminKey : process.env.ADMIN_KEY;
  const version = options.version || 'unknown';
  const storeKind = options.storeKind || 'unknown';
  // Checks Play purchase tokens with Google. Null when the server
  // has no Google service account yet; Play reports are then
  // refused plainly instead of being trusted unchecked.
  const playVerifier = options.playVerifier || null;

  const app = express();
  // Behind Coolify the real caller address comes from the proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(createRequestCap());
  app.use(express.json({ limit: '2mb' }));

  const health = (req, res) => {
    res.status(200).json({ ok: true, service: 'aduro-pos-server', version, store: storeKind });
  };
  app.get('/', health);
  app.get('/health', health);

  // ---- Free trial, recorded on the server. ----
  // A phone asks once with its device ID and the server fixes the
  // trial start date. Asking again returns the same first date, so
  // clearing the app on the phone cannot restart the trial. This
  // route needs no device token, because a new phone is not linked
  // yet; the global request cap is the flood guard.
  const DEVICE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
  app.post('/api/trial/register', async (req, res, next) => {
    try {
      const body = req.body || {};
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
      if (!DEVICE_ID_SHAPE.test(deviceId)) {
        return res.status(400).json({ error: 'Please send a device ID.' });
      }
      // The phone may have opened days before it first reached the
      // server. It may send the day it first opened, and the trial
      // starts then, never later than now: a phone cannot stretch
      // its trial by staying offline, and a future date is clamped.
      const now = new Date();
      let startAt = now;
      if (typeof body.firstSeenAt === 'string') {
        const claimed = new Date(body.firstSeenAt);
        if (!Number.isNaN(claimed.getTime()) && claimed.getTime() < now.getTime()) {
          startAt = claimed;
        }
      }
      const record = await store.registerTrial(deviceId, startAt.toISOString());
      // Whole days left, rounded up, so a trial with any time left
      // shows at least 1. The app still works its own days out from
      // the trial start; this number is only for display.
      const daysLeft = Math.max(
        0,
        Math.ceil((new Date(record.trialEnd).getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
      );
      return res.status(200).json({
        deviceId: record.deviceId,
        trialStart: record.trialStart,
        trialEnd: record.trialEnd,
        daysLeft,
      });
    } catch (err) {
      return next(err);
    }
  });

  // ---- Google Play purchases (the Play build of the app). ----
  // The Play build sells the licence through Google Play Billing.
  // The app reports each purchase here with its device ID; the
  // server asks Google whether the purchase token is real before
  // it believes it, records the token so it is never counted
  // twice, and works out the paid until date. The shop build
  // never touches these routes; it pays through the pay hub.
  const PLAY_PRODUCTS = new Map([
    ['aduro_monthly', 1],
    ['aduro_yearly', 12],
  ]);
  // Days after the paid until date when the plan still counts as
  // grace, the same shape the pay hub answers with.
  const PLAY_GRACE_DAYS = 7;

  app.post('/api/play/report', async (req, res, next) => {
    try {
      const body = req.body || {};
      const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
      if (!DEVICE_ID_SHAPE.test(deviceId)) {
        return res.status(400).json({ error: 'Please send a device ID.' });
      }
      const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
      if (!PLAY_PRODUCTS.has(productId)) {
        return res.status(400).json({ error: 'Please send a valid Play product.' });
      }
      const purchaseToken = typeof body.purchaseToken === 'string' ? body.purchaseToken.trim() : '';
      if (!purchaseToken || purchaseToken.length > 2000) {
        return res.status(400).json({ error: 'Please send a valid purchase token.' });
      }
      const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 32) : '';
      const seen = await store.findPlayPurchaseByToken(purchaseToken);
      if (seen) {
        // Already recorded: answer the stored date, extend nothing.
        if (seen.deviceId !== deviceId) {
          return res.status(400).json({ error: 'That purchase belongs to another phone.' });
        }
        return res.status(200).json({ ok: true, until: seen.until });
      }
      if (!playVerifier) {
        return res.status(503).json({
          error: 'Play purchases are not set up on this server yet.',
        });
      }
      let check;
      try {
        check = await playVerifier(productId, purchaseToken);
      } catch {
        return res.status(503).json({
          error: 'Google could not be reached. Please try again.',
        });
      }
      if (!check || !check.valid) {
        return res.status(400).json({
          error: 'Google could not confirm that purchase. Please try again.',
        });
      }
      // A renewal stacks on the time still left, so a shop that
      // pays early never loses days it already bought.
      const now = new Date();
      const existing = await store.playUntilForDevice(deviceId);
      const base = existing && new Date(existing).getTime() > now.getTime()
        ? existing
        : now.toISOString();
      const until = addMonths(base, PLAY_PRODUCTS.get(productId));
      await store.recordPlayPurchase({
        purchaseToken,
        deviceId,
        phone,
        productId,
        until,
        createdAt: now.toISOString(),
      });
      return res.status(200).json({ ok: true, until });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/play/status', async (req, res, next) => {
    try {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      if (!DEVICE_ID_SHAPE.test(deviceId)) {
        return res.status(400).json({ error: 'Please send a device ID.' });
      }
      const until = await store.playUntilForDevice(deviceId);
      if (!until) {
        return res.status(200).json({ status: 'none', expiryDate: null });
      }
      const now = Date.now();
      const untilMs = new Date(until).getTime();
      let status = 'expired';
      if (untilMs > now) {
        status = 'active';
      } else if (now - untilMs <= PLAY_GRACE_DAYS * 24 * 60 * 60 * 1000) {
        status = 'grace';
      }
      return res.status(200).json({ status, expiryDate: until });
    } catch (err) {
      return next(err);
    }
  });

  // ---- Founder only pages. The admin key guards every one of them. ----
  // Five wrong keys from one address lock that address out for
  // fifteen minutes, and the key is compared in constant time so
  // timing cannot leak how many characters matched.
  function requireAdmin(req, res, next) {
    if (!adminKey) {
      return res.status(503).json({
        error: 'This server has no admin key set yet, so shops cannot be created.',
      });
    }
    const key = (req.ip || 'unknown') + ':admin';
    const lockedUntil = adminGuard.lockedUntil(key);
    if (lockedUntil) return lockedAnswer(res, lockedUntil);
    const given = req.headers['x-admin-key'];
    if (typeof given !== 'string' || !timingSafeCompare(given, adminKey)) {
      adminGuard.fail(key);
      return res.status(401).json({ error: 'The admin key is not right.' });
    }
    adminGuard.pass(key);
    return next();
  }

  // ---- Founder only: create a shop after the owner has paid. ----
  app.post('/admin/shops', requireAdmin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const ownerName = typeof body.ownerName === 'string' ? body.ownerName.trim() : '';
      const town = typeof body.town === 'string' ? body.town.trim() : '';
      if (!name || !ownerName) {
        return res.status(400).json({
          error: 'Please give the shop name and the owner name.',
        });
      }

      let code = null;
      for (let attempt = 0; attempt < 10 && !code; attempt += 1) {
        const candidate = newShopCode();
        const clash = await store.getShopByCode(candidate);
        if (!clash) code = candidate;
      }
      if (!code) {
        return res.status(500).json({ error: 'A shop code could not be made. Please try again.' });
      }

      const ownerToken = newToken();
      const shop = {
        id: newId('shop'),
        code,
        name,
        town,
        ownerName,
        ownerTokenHash: hashToken(ownerToken),
        createdAt: new Date().toISOString(),
      };
      await store.createShop(shop);

      // The full owner token is shown only here, in this one answer.
      // After this, the server only holds a scrambled copy of it.
      return res.status(201).json({ shopId: shop.id, shopCode: shop.code, ownerToken });
    } catch (err) {
      return next(err);
    }
  });

  // ---- The founder portal page and its data pages. ----
  // The page itself is open: anyone can load it. It can do nothing
  // without the admin key, which the page sends with every call below.
  app.get('/admin', (req, res) => {
    res.type('html').sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  // The portal script lives in its own file, so the content policy
  // can refuse inline scripts. Same folder as the page itself.
  app.get('/admin.js', (req, res) => {
    res.type('js').sendFile(path.join(__dirname, '..', 'public', 'admin.js'));
  });

  app.get('/admin/api/shops', requireAdmin, async (req, res, next) => {
    try {
      const shops = await store.listShops();
      const withStats = [];
      for (const shop of shops) {
        const stats = await store.shopStats(shop.id);
        withStats.push({ ...shop, ...stats });
      }
      return res.status(200).json({ shops: withStats });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/admin/api/shops/:id', requireAdmin, async (req, res, next) => {
    try {
      const fullShop = await store.getShopById(req.params.id);
      if (!fullShop) {
        return res.status(404).json({ error: 'That shop could not be found.' });
      }
      const stats = await store.shopStats(fullShop.id);
      // Only the safe fields are handed out. The scrambled owner token
      // stays inside the server.
      const shop = {
        id: fullShop.id,
        code: fullShop.code,
        name: fullShop.name,
        town: fullShop.town,
        ownerName: fullShop.ownerName,
        createdAt: fullShop.createdAt,
        ...stats,
      };
      const devices = await store.listDevices(fullShop.id);
      const today = accraToday();
      const todaysSales = await store.listSalesForDate(fullShop.id, today);
      const recentSales = await store.listRecentSales(fullShop.id, 20);
      return res.status(200).json({
        shop,
        devices,
        today: computeTotals(todaysSales),
        recentSales,
      });
    } catch (err) {
      return next(err);
    }
  });

  // ---- Linking: turn a shop code plus a token into a device. ----
  function deviceAnswer(deviceToken, shop, device) {
    return {
      deviceToken,
      shop: { id: shop.id, name: shop.name, town: shop.town },
      device: { id: device.id, label: device.label, role: device.role },
    };
  }

  async function makeDevice(shop, fields) {
    const deviceToken = newToken();
    const now = new Date().toISOString();
    const device = {
      id: newId('device'),
      shopId: shop.id,
      label: fields.label,
      staffName: fields.staffName,
      role: fields.role,
      tokenHash: hashToken(deviceToken),
      createdAt: now,
      lastSeenAt: now,
    };
    await store.createDevice(device);
    return { deviceToken, device };
  }

  app.post('/api/link/owner', async (req, res, next) => {
    try {
      const body = req.body || {};
      const shopCode = typeof body.shopCode === 'string' ? body.shopCode.trim() : '';
      const key = (req.ip || 'unknown') + ':owner:' + shopCode;
      const lockedUntil = ownerGuard.lockedUntil(key);
      if (lockedUntil) return lockedAnswer(res, lockedUntil);
      const shop = shopCode ? await store.getShopByCode(shopCode) : null;
      if (!shop || typeof body.ownerToken !== 'string'
        || !timingSafeCompare(hashToken(body.ownerToken), shop.ownerTokenHash)) {
        ownerGuard.fail(key);
        return res.status(401).json({
          error: 'The shop code or the owner token is not right.',
        });
      }
      ownerGuard.pass(key);
      const { deviceToken, device } = await makeDevice(shop, {
        label: typeof body.deviceLabel === 'string' && body.deviceLabel.trim()
          ? body.deviceLabel.trim()
          : 'Owner phone',
        staffName: typeof body.staffName === 'string' && body.staffName.trim()
          ? body.staffName.trim()
          : shop.ownerName,
        role: 'owner',
      });
      return res.status(200).json(deviceAnswer(deviceToken, shop, device));
    } catch (err) {
      return next(err);
    }
  });

  app.post('/api/link/staff', async (req, res, next) => {
    try {
      const body = req.body || {};
      const shopCode = typeof body.shopCode === 'string' ? body.shopCode.trim() : '';
      const key = (req.ip || 'unknown') + ':staff:' + shopCode;
      const lockedUntil = staffGuard.lockedUntil(key);
      if (lockedUntil) return lockedAnswer(res, lockedUntil);
      const shop = shopCode ? await store.getShopByCode(shopCode) : null;
      if (!shop) {
        staffGuard.fail(key);
        return res.status(400).json({ error: 'That shop code is not right.' });
      }
      const joinCode = typeof body.joinCode === 'string' ? body.joinCode.trim() : '';
      const record = joinCode ? await store.findJoinCode(shop.id, joinCode) : null;
      if (!record) {
        staffGuard.fail(key);
        return res.status(400).json({ error: 'That join code is not right.' });
      }
      if (record.usedAt) {
        return res.status(400).json({ error: 'That join code has already been used.' });
      }
      if (new Date(record.expiresAt).getTime() <= Date.now()) {
        return res.status(400).json({
          error: 'That join code has expired. Please ask the owner for a new one.',
        });
      }
      // The claim is one step in the store: two phones sending the
      // same code at the same moment cannot both win.
      const claimed = await store.claimJoinCode(record.id);
      if (!claimed) {
        return res.status(400).json({ error: 'That join code has already been used.' });
      }
      staffGuard.pass(key);
      const { deviceToken, device } = await makeDevice(shop, {
        label: typeof body.deviceLabel === 'string' && body.deviceLabel.trim()
          ? body.deviceLabel.trim()
          : (record.deviceLabel || 'Staff phone'),
        staffName: record.staffName,
        role: 'staff',
      });
      return res.status(200).json(deviceAnswer(deviceToken, shop, device));
    } catch (err) {
      return next(err);
    }
  });

  // ---- Auth for everything below: a linked device token. ----
  async function requireDevice(req, res, next) {
    try {
      const header = req.headers.authorization || '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) {
        return res.status(401).json({ error: 'This device is not linked yet.' });
      }
      const device = await store.findDeviceByTokenHash(hashToken(match[1].trim()));
      if (!device) {
        return res.status(401).json({
          error: 'This device is not linked. Please link it again.',
        });
      }
      req.device = device;
      await store.touchDevice(device.id);
      return next();
    } catch (err) {
      return next(err);
    }
  }

  function requireOwner(req, res, next) {
    if (!req.device || req.device.role !== 'owner') {
      return res.status(403).json({ error: 'Only the shop owner can do this.' });
    }
    return next();
  }

  // ---- Taking a device off the shop. ----
  // The owner removes one of his own shop's devices, for example a
  // till that was stolen or a staff phone that left. The founder
  // can remove any device from the portal. A removed device token
  // stops working at once.
  async function revokeDevice(req, res, shopId) {
    const device = await store.getDeviceById(req.params.id);
    if (!device || (shopId && device.shopId !== shopId)) {
      return res.status(404).json({ error: 'That device could not be found.' });
    }
    if (req.device && device.id === req.device.id) {
      return res.status(400).json({ error: 'A device cannot remove itself. Use another device or ask the founder.' });
    }
    await store.deleteDevice(device.id);
    return res.status(200).json({ ok: true });
  }

  app.delete('/api/devices/:id', requireDevice, requireOwner, async (req, res, next) => {
    try {
      return await revokeDevice(req, res, req.device.shopId);
    } catch (err) {
      return next(err);
    }
  });

  app.delete('/admin/api/devices/:id', requireAdmin, async (req, res, next) => {
    try {
      return await revokeDevice(req, res, null);
    } catch (err) {
      return next(err);
    }
  });

  // ---- The owner makes a one time code so a staff phone can join. ----
  app.post('/api/devices/join-code', requireDevice, requireOwner, async (req, res, next) => {
    try {
      const body = req.body || {};
      const staffName = typeof body.staffName === 'string' ? body.staffName.trim() : '';
      const deviceLabel = typeof body.deviceLabel === 'string' ? body.deviceLabel.trim() : '';
      if (!staffName) {
        return res.status(400).json({ error: 'Please give the staff member name.' });
      }
      let code = null;
      for (let attempt = 0; attempt < 10 && !code; attempt += 1) {
        const candidate = newJoinCode();
        const clash = await store.findJoinCode(req.device.shopId, candidate);
        if (!clash || clash.usedAt || new Date(clash.expiresAt).getTime() <= Date.now()) {
          code = candidate;
        }
      }
      if (!code) {
        return res.status(500).json({ error: 'A join code could not be made. Please try again.' });
      }
      const now = new Date();
      const record = {
        id: newId('join'),
        shopId: req.device.shopId,
        code,
        staffName,
        deviceLabel,
        expiresAt: new Date(now.getTime() + JOIN_CODE_MINUTES * 60 * 1000).toISOString(),
        usedAt: null,
        createdAt: now.toISOString(),
      };
      await store.createJoinCode(record);
      return res.status(200).json({ joinCode: record.code, expiresAt: record.expiresAt });
    } catch (err) {
      return next(err);
    }
  });

  // ---- Sync: devices push their queue, and pull what others sent. ----
  app.post('/api/sync/push', requireDevice, async (req, res, next) => {
    try {
      const entries = req.body ? req.body.entries : undefined;
      if (!Array.isArray(entries)) {
        return res.status(400).json({ error: 'Please send the entries as a list.' });
      }
      if (entries.length > MAX_PUSH_ENTRIES) {
        return res.status(400).json({
          error: `Please send at most ${MAX_PUSH_ENTRIES} entries at a time.`,
        });
      }
      const accepted = [];
      const duplicates = [];
      const rejected = [];
      for (const entry of entries) {
        const reject = (reason) => {
          rejected.push({
            id: entry && typeof entry.id === 'string' ? entry.id : null,
            reason,
          });
        };
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          reject('This entry is not in the right shape.');
          continue;
        }
        if (typeof entry.id !== 'string' || entry.id === '') {
          reject('This entry has no id.');
          continue;
        }
        if (typeof entry.kind !== 'string' || !KIND_SHAPE.test(entry.kind)) {
          reject('This entry has no kind, or the kind is not in the right shape.');
          continue;
        }
        if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) {
          reject('This entry is missing its details.');
          continue;
        }
        const isSaleKind = entry.kind === 'sale' || entry.kind === 'sale_return';
        if (isSaleKind) {
          const payload = entry.payload;
          const hasId = typeof payload.id === 'string' && payload.id !== '';
          const total = payload.totalPesewas;
          const totalOk = Number.isSafeInteger(total) && total >= 0 && total <= MAX_TOTAL_PESEWAS;
          if (!hasId || !totalOk) {
            reject('This sale is missing its id, or its total is not a whole number of pesewas between 0 and GHc1,000,000.');
            continue;
          }
          if (entry.kind === 'sale_return' && payload.returned !== true) {
            reject('This sale return does not carry the returned mark.');
            continue;
          }
        }
        if (entry.kind === 'debtor') {
          const payload = entry.payload;
          const hasId = typeof payload.id === 'string' && payload.id !== '';
          const balance = payload.balancePesewas;
          const balanceOk = Number.isSafeInteger(balance)
            && balance >= 0 && balance <= MAX_TOTAL_PESEWAS;
          if (!hasId || !balanceOk) {
            reject('This debtor is missing its id, or its balance is not a whole number of pesewas between 0 and GHc1,000,000.');
            continue;
          }
        }
        if (entry.kind === 'stock_summary') {
          const payload = entry.payload;
          if (typeof payload.date !== 'string' || payload.date === '') {
            reject('This stock summary is missing its date.');
            continue;
          }
        }
        if (entry.kind === 'medicine' || entry.kind === 'batch') {
          const payload = entry.payload;
          if (typeof payload.id !== 'string' || payload.id === '') {
            reject('This stock entry is missing its id.');
            continue;
          }
        }
        if (entry.kind === 'books') {
          const payload = entry.payload;
          const listsOk = ['expenses', 'suppliers', 'supplierLines', 'staff']
            .every((key) => Array.isArray(payload[key]));
          if (!listsOk) {
            reject('This books entry is missing one of its lists.');
            continue;
          }
          // Staff PIN material never rides the sync pipe. A
          // books entry carrying a hash is refused whole.
          const staffDirty = payload.staff.some(
            (m) => m && (typeof m.pinHash === 'string' || typeof m.pinSalt === 'string'),
          );
          if (staffDirty) {
            reject('This books entry carries staff PIN material, which never syncs.');
            continue;
          }
        }
        const record = {
          shopId: req.device.shopId,
          entryId: entry.id,
          deviceId: req.device.id,
          kind: entry.kind,
          deviceLabel: typeof entry.device === 'string' ? entry.device : null,
          saleNumber: typeof entry.saleNumber === 'string'
            ? entry.saleNumber
            : null,
          payload: entry.payload,
          createdAt: typeof entry.createdAt === 'string'
            ? entry.createdAt
            : new Date().toISOString(),
        };
        const result = await store.addEntry(record);
        if (!result.stored) {
          duplicates.push(entry.id);
          continue;
        }
        accepted.push(entry.id);
        if (isSaleKind) {
          await store.upsertSale(req.device.shopId, entry.payload.id, entry.payload);
        }
        if (entry.kind === 'debtor') {
          await store.upsertDebtor(req.device.shopId, entry.payload.id, entry.payload);
        }
        if (entry.kind === 'medicine') {
          await store.upsertMedicine(req.device.shopId, entry.payload.id, entry.payload);
        }
        if (entry.kind === 'batch') {
          await store.upsertBatch(req.device.shopId, entry.payload.id, entry.payload);
        }
        if (entry.kind === 'books') {
          await store.saveBooks(req.device.shopId, entry.payload);
        }
        if (entry.kind === 'stock_summary') {
          await store.saveSummary(req.device.shopId, entry.payload);
        }
      }
      return res.status(200).json({ accepted, duplicates, rejected });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/sync/pull', requireDevice, async (req, res, next) => {
    try {
      const parsed = Number.parseInt(req.query.since, 10);
      const since = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      const rows = await store.listEntriesSince(req.device.shopId, since, MAX_PULL_RECORDS);
      const records = rows.map((row) => ({
        seq: row.seq,
        entryId: row.entryId,
        kind: row.kind,
        device: row.deviceLabel,
        saleNumber: row.saleNumber,
        payload: row.payload,
        fromDeviceId: row.deviceId,
        createdAt: row.createdAt,
      }));
      const latestSeq = await store.latestSeq(req.device.shopId);
      return res.status(200).json({ records, latestSeq });
    } catch (err) {
      return next(err);
    }
  });

  // ---- Owner views, worked out from the stored sales. ----
  app.get('/api/owner/today', requireDevice, requireOwner, async (req, res, next) => {
    try {
      const today = accraToday();
      const todaysSales = await store.listSalesForDate(req.device.shopId, today);
      const stockSummary = await store.getSummary(req.device.shopId);
      return res.status(200).json({
        date: today,
        ...computeTotals(todaysSales),
        stockSummary,
      });
    } catch (err) {
      return next(err);
    }
  });

  app.get('/api/owner/sales', requireDevice, requireOwner, async (req, res, next) => {
    try {
      const date = typeof req.query.date === 'string' ? req.query.date : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || accraDateOf(`${date}T12:00:00.000Z`) !== date) {
        return res.status(400).json({
          error: 'Please give the date like this: 2026-10-29.',
        });
      }
      const sales = await store.listSalesForDate(req.device.shopId, date);
      return res.status(200).json({ date, sales });
    } catch (err) {
      return next(err);
    }
  });

  // ---- The credit book, as the till last sent it up. ----
  app.get('/api/owner/credit', requireDevice, requireOwner, async (req, res, next) => {
    try {
      const all = await store.listDebtors(req.device.shopId);
      const debtors = all
        .filter((d) => d && typeof d.balancePesewas === 'number' && d.balancePesewas > 0)
        .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
      const totalOwedPesewas = debtors.reduce((sum, d) => sum + d.balancePesewas, 0);
      return res.status(200).json({ debtors, totalOwedPesewas });
    } catch (err) {
      return next(err);
    }
  });

  // ---- The stock picture, as the till last sent it up. ----
  app.get('/api/owner/stock', requireDevice, requireOwner, async (req, res, next) => {
    try {
      const medicines = (await store.listMedicines(req.device.shopId))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      const batches = (await store.listBatches(req.device.shopId))
        .sort((a, b) => String(a.expiryDate || '').localeCompare(String(b.expiryDate || '')));
      return res.status(200).json({ medicines, batches });
    } catch (err) {
      return next(err);
    }
  });

  // ---- The books, as the till last sent them up. ----
  app.get('/api/owner/books', requireDevice, requireOwner, async (req, res, next) => {
    try {
      const books = await store.getBooks(req.device.shopId);
      return res.status(200).json(
        books || { expenses: [], suppliers: [], supplierLines: [], staff: [] },
      );
    } catch (err) {
      return next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'That page does not exist on this server.' });
  });

  // Any failure lands here. Plain words only, no raw codes.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return res.status(400).json({ error: 'The request body is not valid JSON.' });
    }
    console.error('Server error:', err);
    return res.status(500).json({
      error: 'Something went wrong on the server. Please try again.',
    });
  });

  return app;
}

module.exports = { createApp };
