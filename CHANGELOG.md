# Changelog

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
