# Changelog

## 1.6.0 - 26 November 2026 - Google Play purchases

- The Play build of the app sells the licence through Google
  Play Billing. Two new routes serve it; the shop build never
  touches them and keeps paying through the pay hub.
- POST /api/play/report takes a device ID, a product
  (aduro_monthly or aduro_yearly) and the Google purchase
  token. The server asks Google whether the token is real and
  live before it believes it (src/play_verify.js, the
  TraderBooks Plus pattern: the service account signs its own
  token with node:crypto, no new packages). The token is
  recorded once in a new play_purchases table, so reporting
  the same purchase again extends nothing, and a token that
  belongs to another phone is refused. A renewal stacks on
  the time still left, so paying early never loses days.
- GET /api/play/status?deviceId= answers active, grace
  (7 days past the paid until date), expired or none, with
  the paid until date.
- Without a Google service account the server still runs;
  Play reports are refused plainly until one is set
  (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, or a file path in
  GOOGLE_PLAY_SERVICE_ACCOUNT_FILE; the package name can be
  set with PLAY_PACKAGE_NAME and defaults to
  com.alhutech.aduropos).
- Tests: 11 new in test/play.test.js; the Postgres store side
  was proven on a scratch database (record, read back,
  duplicate token keeps the first record, latest until wins).

## 1.5.0 - 25 November 2026 - The widened sync pipe

- Three new sync kinds ride the same push:
  - medicine: one entry per medicine, the newest copy kept
    in a new medicines table, with the units in stock the
    till worked out from its batches.
  - batch: one entry per batch, kept in a new batches table.
  - books: one snapshot entry carrying the shop expenses,
    suppliers with their lines, and staff names, kept whole
    in a new shop_books table. A snapshot replaces the last,
    so a line removed on the till is removed here too.
- Staff PIN material never syncs: a books entry whose staff
  list carries a pinHash or pinSalt is refused whole.
- Two new owner reads: GET /api/owner/stock (medicines by
  name, batches by expiry) and GET /api/owner/books (the
  newest books snapshot, or empty lists when none has come).
- The app in 1.4.10 sends these with every sync and shows
  them in the owner viewer: a Shop stock screen, plus Spent
  today and Owed to suppliers banners.

## 1.4.0 - 25 November 2026 - Sale returns

- Owner totals now leave out a sale whose payload carries
  returned: true. The app in 1.4.6 can return a wrong sale;
  the sale stays in the record, marked returned, and no total
  counts it. Payloads with no returned field count as
  standing, so old sales are untouched.
- New sync kind sale_return: the till sends the full sale
  with the returned mark under its own entry id, and the
  server replaces its copy of that sale (upsertSale), so the
  owner views agree with the till. A sale_return without the
  returned mark is rejected. The entry is stored once, like
  every other kind.
- No table changes. Pairs with app 1.4.6.

## 1.3.0 - 21 November 2026 - Server side trial, faster owner views

- Free trial recorded on the server: POST /api/trial/register
  takes a device ID and fixes the trial start date. Asking
  again returns the same first date, so clearing the app on
  the phone cannot restart the trial. The trial is 7 days from
  the first day the server hears about the device. New trials
  table, created on start if missing. The app in v1.4.3 uses
  this and falls back to its local trial date when offline.
- Owner views no longer load the whole sales history: today,
  one day's sales and the portal page now filter by day in the
  database (listSalesForDate) and take only the newest 20
  sales (listRecentSales). Ghana has no daylight saving time
  and Accra is UTC+0, so an Accra day is exactly a UTC day.
- New indexes: devices by token hash (every authenticated
  request looks a device up this way), entries by shop and
  sequence, join codes by shop and code.
- Health now reports the version and the store kind
  (postgres or memory), so the live version and the storage
  can be checked from outside without reading the deploy log.
- Graceful shutdown: SIGTERM and SIGINT close the server and
  the database pool, so a Coolify restart never cuts a query
  short.
- The request cap and the brute force guard now drop old
  quiet records, so their maps cannot grow without bound.
- The Docker image now runs as the plain node user, not root.
- Migration check: scripts/migration-check.js builds the
  v1.2.0 schema with sample rows on a scratch database, runs
  the new init(), and proves the old rows survive, the trials
  table and the three indexes appear, and init() passes twice.
  Run it before any deploy that changes the schema.
- Tests: 34 pass, 0 fail (was 25). New test/trial.test.js
  (9 tests: trial register and idempotency, first seen date
  honoured and future dates clamped, bad device IDs, health
  version and store, day range, date filtered and recent
  sales, guard pruning).

## 1.2.0 - 12 November 2026 - Security hardening

- Brute force lockout: five wrong tries lock the caller out
  for fifteen minutes on the admin key, the owner link and the
  staff join code, with a 429 answer. The right secret is
  refused too while locked. A success clears the count. The
  join code is only six digits, so this lockout is what stops
  it being guessed inside its thirty minute life.
- A request cap: 1,200 requests per address per fifteen
  minutes, so one address cannot flood the API.
- Secrets compared in constant time now (admin key, owner
  token hash), so timing cannot leak how many characters
  matched.
- Join code claim is one step in the store now
  (claimJoinCode): only an unused code is marked used. Two
  phones sending the same code at the same moment cannot both
  win.
- Device revoke: the owner can remove one of his own shop's
  devices (DELETE /api/devices/:id, never his own), and the
  founder can remove any device from the portal (DELETE
  /admin/api/devices/:id, with a Revoke button on each device).
  A removed token stops working at once.
- Push validation: entry kinds must match a plain shape
  (lowercase letters, digits, underscores), sale totals and
  debtor balances must be whole pesewas from 0 to GHc1,000,000.
  Negative, fractional and huge totals are refused in plain
  words.
- Security headers on every answer (no framing, no MIME sniff,
  no referrer, HSTS for one year, scripts only from this
  server). The portal script moved out of admin.html into
  public/admin.js, served at GET /admin.js. X-Powered-By is
  off. Trust proxy is on, so the limits see real addresses
  behind Coolify.
- Checked and already safe, no change: all database queries
  parameterized, portal escapes every value, 256 bit random
  tokens hashed, roles enforced server side, error answers in
  plain words with no raw codes, no debug prints, no source
  maps, no CORS (deny by default).
- Tests: 25 pass, 0 fail (was 15). New test/security.test.js
  (10 tests).

## 1.1.0 - 8 November 2026 - Credit book and stock picture (Stage 4)

- Push now also takes debtor entries (the debtor record plus
  the balance the till worked out from its ledger) and one
  stock summary entry (batches inside the 90 day expiry
  window, their value, and the running low count). Repeats are
  duplicates as before; a changed balance arrives as a fresh
  entry and replaces the stored copy.
- New owner page: GET /api/owner/credit returns the debtors
  with a balance, sorted by due date, plus the total owed.
  Owner role only; a till token gets a plain 403.
- GET /api/owner/today now also carries stockSummary, the last
  stock picture the till sent, or null when none has arrived.
- New tables on the PostgreSQL store: debtors and
  shop_summaries, created on start if missing. The live server
  picks them up on its next deploy.
- Tests: 15 passing (12 before, plus 3 for the credit book and
  the stock summary, including the part payment update and the
  paid off debtor leaving the book).

## 1.0.0 - 8 November 2026 - First build

- Sync server for Aduro POS, built in the proven TraderBooks
  Plus shape (same store, token and linking design), adapted to
  the Aduro sale record: attendant, tender (cash, momo, credit),
  total and profit in pesewas, medicine lines.
- Founder creates a shop at /admin or POST /admin/shops and
  gets a shop code and a one time shown owner token (hash only
  is stored). Owner links a viewer phone; owner makes 6 digit
  join codes (30 minutes, one use) for the shop till.
- Tills push sale entries; repeats are duplicates and never
  double count. Owner pages: today totals and one day's sales,
  owner role only.
- Counting: every recorded sale counts, profit is summed from
  the till figures, days are Africa/Accra. Credit book, stock
  and cash counts do not sync in this version.
- Tests: 12 passing on the memory store, plus a live local run
  (create shop, link owner, push a GHc64 MoMo sale, owner today
  returned the right totals). The PostgreSQL path has not run
  against a real database yet; the Coolify deploy is its first
  real check, the same note the Plus server carried.
