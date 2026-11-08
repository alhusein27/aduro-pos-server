# Aduro POS Sync Server

The sync server for Aduro POS (Chemical Shop Edition). Shop tills
push their sales here when they get internet, so the shop owner
can open the same app on his own phone, link as the owner, and
see today sales, profit and who sold what, from anywhere.

Stack: Node, Express, PostgreSQL (pg). With no DATABASE_URL set,
it keeps data in memory, which is fine for local tests only.

## How it works

- The founder creates a shop (POST /admin/shops, header
  x-admin-key) and gets a shop code plus an owner token. The
  token is shown once; the server keeps only its SHA-256 hash.
  The founder portal is at /admin.
- The owner links his phone with the shop code and owner token
  (POST /api/link/owner) and gets a device token.
- The owner makes a 6 digit join code in the app (30 minutes,
  one use). The shop till joins with it (POST /api/link/staff).
- Tills push sale entries (POST /api/sync/push). A repeat entry
  is reported as a duplicate and never counts twice. Sales are
  stored by (shop, sale id).
- The owner reads GET /api/owner/today (totals for the Accra
  day: sales, cash, MoMo, credit, profit, count, by attendant)
  and GET /api/owner/sales?date=YYYY-MM-DD (that day's sales).
  Owner role only; a till token gets a plain 403.
- Sync covers sales only in this version. Stock, the credit
  book and cash counts stay on the till, the same rule as
  TraderBooks Plus.

## Counting rules

Every recorded sale counts; Aduro POS has no approval step.
Profit is the sum of the profitPesewas the till worked out at
sale time. Dates are Africa/Accra days. See src/totals.js.

## Run it

1. Copy .env.example to .env and set ADMIN_KEY (long random).
   Set DATABASE_URL for real use.
2. npm install
3. npm start (or npm test to run the tests)

## Deploy

Dockerfile included. In Coolify: new app from this repo, set
ADMIN_KEY and DATABASE_URL, give it the domain
aduro.alhutech.com. First deploy is the first real PostgreSQL
run; the local tests run on the memory store.
