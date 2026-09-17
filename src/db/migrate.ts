import { closeDb, initDb } from './index';

async function runMigrations() {
  console.log('[Sequent Migrate] Running database schema migrations...');
  const connected = await initDb();
  if (!connected) {
    console.error('[Sequent Migrate] Failed to connect to PostgreSQL. Aborting migration.');
    process.exit(1);
  }
  console.log('[Sequent Migrate] Schema migrations and indexes successfully applied.');
  await closeDb();
}

runMigrations().catch((err) => {
  console.error('[Sequent Migrate] Migration error:', err);
  process.exit(1);
});
