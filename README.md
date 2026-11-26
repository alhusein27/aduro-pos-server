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
- Sync covers sales, the credit book and the stock summary.
  Since v1.1.0 the till also pushes debtor entries (each debtor
  with the balance the till worked out) and one stock summary
  entry (batches inside the 90 day expiry window, their value,
  and the running low count). Stock batches and cash counts
  stay on the till, the same rule as TraderBooks Plus.
- The free trial is recorded here: POST /api/trial/register
  with a device ID fixes the trial start date (7 days). Asking
  again returns the same first date, so clearing the app on
  the phone cannot restart the trial. No device token is
  needed, because a new phone is not linked yet.
- The health answer carries the version and the store kind:
  GET /health returns ok, service, version and store
  (postgres or memory). If store says memory on the live
  server, DATABASE_URL is not set and every shop and sale is
  lost on restart. Fix it in Coolify at once.

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
aduropos.alhutech.com. First deploy is the first real PostgreSQL
run; the local tests run on the memory store.

After a deploy, check GET /health: version must match the
release and store must say postgres. Redeploy one app at a
time, never several together.

## Google Play purchases

The Play build of the app (built with --dart-define=STORE=play)
sells the licence through Google Play Billing and reports each
purchase to POST /api/play/report. The server checks the
purchase token with Google before believing it, so it needs
the service account JSON key made in Play Console (Settings,
API access). Set it in Coolify as
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (the whole JSON), or put the
file on the server and set GOOGLE_PLAY_SERVICE_ACCOUNT_FILE to
its path. PLAY_PACKAGE_NAME can override the app package and
defaults to com.alhutech.aduropos. With no service account set
the server still runs and Play reports are refused plainly.
The products are aduro_monthly (GHc50) and aduro_yearly
(GHc500), made as subscriptions in Play Console.

## Backup and recovery

The database holds every shop, device link, sale, debtor and
trial. Losing it means every shop must link again and all
synced history is gone, so it gets a daily backup.

1. In Coolify, open the PostgreSQL database this server uses,
   open Backups, and switch on a daily scheduled backup. Keep
   7 days. This is the same shape as the TraderBooks Plus
   server backup.
2. Once a month, prove a backup restores: make a scratch
   database, restore the newest backup file into it, and check
   the shops table lists the shops. A backup never tested is
   not a backup.
3. Manual backup, from any machine with pg_dump and the
   database password:
   pg_dump -h HOST -U USER -d DATABASE -F c -f aduro-backup.dump
4. Manual restore into an empty database:
   pg_restore -h HOST -U USER -d DATABASE aduro-backup.dump
   Then restart the server app in Coolify.
5. Backup files hold shop and sale records. Never put one in
   git, in a public folder, or on a shared link. Keep them in
   the Coolify backup store or on the founder PC only.
