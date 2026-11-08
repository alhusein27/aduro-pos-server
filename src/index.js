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

async function main() {
  let store;
  if (process.env.DATABASE_URL) {
    store = new PgStore(process.env.DATABASE_URL);
    console.log('Using PostgreSQL storage.');
  } else {
    store = new MemoryStore();
    console.warn(
      'WARNING: DATABASE_URL is not set, so this server is keeping data in memory only. '
      + 'Everything is lost when the server restarts. Use this only for trying the server out.',
    );
  }
  await store.init();
  const app = createApp(store, { adminKey: process.env.ADMIN_KEY });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Aduro POS server is listening on port ${port}.`);
  });
}

main().catch((err) => {
  console.error('The server could not start.', err);
  process.exit(1);
});
