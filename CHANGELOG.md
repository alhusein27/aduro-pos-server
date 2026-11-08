# Changelog

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
