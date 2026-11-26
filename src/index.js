// Starts the server.
//
// When DATABASE_URL is set, sales are kept in PostgreSQL and survive
// restarts. That is how the live server runs.
//
// When DATABASE_URL is not set, everything is kept in memory only.
// That is fine for trying the server out on your own computer, but
// every shop and sale is lost the moment the server stops.

const { createApp } = require('./app');
const { MemoryStore, PgStore } = require('./store');
const { createPlayVerifier, playCredentialsFromEnv } = require('./play_verify');

async function main() {
  let store;
  let storeKind;
  if (process.env.DATABASE_URL) {
    store = new PgStore(process.env.DATABASE_URL);
    storeKind = 'postgres';
    console.log('Using PostgreSQL storage.');
  } else {
    store = new MemoryStore();
    storeKind = 'memory';
    console.warn(
      'WARNING: DATABASE_URL is not set, so this server is keeping data in memory only. '
      + 'Everything is lost when the server restarts. Use this only for trying the server out.',
    );
  }
  await store.init();
  // Play purchase checking needs the Google service account made
  // in Play Console (Settings, API access). Without it the server
  // still runs; Play reports are refused plainly until it is set.
  const playVerifier = createPlayVerifier({
    credentials: playCredentialsFromEnv(),
    packageName: process.env.PLAY_PACKAGE_NAME || 'com.alhutech.aduropos',
  });
  if (!playVerifier) {
    console.warn(
      'WARNING: no Google Play service account is set '
      + '(GOOGLE_PLAY_SERVICE_ACCOUNT_JSON), so Play purchases cannot be checked yet.',
    );
  }
  const version = require('../package.json').version;
  const app = createApp(store, {
    adminKey: process.env.ADMIN_KEY,
    version,
    storeKind,
    playVerifier,
  });
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`Aduro POS server is listening on port ${port}.`);
  });
  // Coolify stops the container with SIGTERM. Close the door first,
  // then the database pool, so a restart never cuts a query short.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      try {
        await store.close();
      } catch (err) {
        console.error('Error closing the store.', err);
      }
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('The server could not start.', err);
  process.exit(1);
});
