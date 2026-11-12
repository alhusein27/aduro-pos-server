# Changelog

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
