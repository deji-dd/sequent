import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { applyMigrations } from './migrations';
import * as schema from './schema';

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;
let isInitialized = false;
let isConnectedToPostgres = false;

export async function getDb() {
  if (!isInitialized) {
    await initDb();
  }
  return dbInstance;
}

export function isDbConnected(): boolean {
  return isConnectedToPostgres;
}

/**
 * Live health probe for /api/health. Deliberately does NOT mutate the repository
 * routing flag: a transient probe failure must not silently switch a Postgres-backed
 * process to the in-memory fallback and split persistence.
 */
export async function pingDb(): Promise<boolean> {
  if (!sqlClient) return false;
  try {
    await sqlClient`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function initDb(): Promise<boolean> {
  if (isInitialized) return isConnectedToPostgres;
  isInitialized = true;

  const isProd = process.env.NODE_ENV === 'production';
  const customUrl = process.env.DATABASE_URL;

  const defaultSocketDir = existsSync('/var/run/postgresql')
    ? '/var/run/postgresql'
    : existsSync('/tmp/.s.PGSQL.5432')
      ? '/tmp'
      : undefined;
  const host = process.env.POSTGRES_HOST || defaultSocketDir;
  const database = process.env.POSTGRES_DB || 'sequent_db';
  const username = process.env.POSTGRES_USER || 'sequent_user';
  const password = process.env.POSTGRES_PASSWORD;
  const port = Number(process.env.POSTGRES_PORT || 5432);

  // If not in prod and no socket/url/host configured, stay in dev in-memory mode
  if (!customUrl && !host && !isProd) {
    console.log(
      '[Sequent DB] Running in local development mode (no PostgreSQL socket available). Persistence stored in memory.'
    );
    return false;
  }

  let client: ReturnType<typeof postgres> | null = null;
  try {
    if (customUrl) {
      client = postgres(customUrl, { connect_timeout: 3, max: 10 });
    } else {
      client = postgres({
        host: host || defaultSocketDir,
        port,
        database,
        username,
        password,
        connect_timeout: 3,
        max: 10,
      });
    }

    // Ping check
    await client`SELECT 1`;

    // Apply ordered, idempotent schema migrations (tables, indexes, repairs)
    await applyMigrations(client);

    sqlClient = client;
    dbInstance = drizzle(client, { schema });
    isConnectedToPostgres = true;

    console.log(
      `[Sequent DB] Connected to PostgreSQL (${host ? `socket/host: ${host}` : 'url'}), database "${database}".`
    );
    return true;
  } catch (err: any) {
    console.warn(
      `[Sequent DB] PostgreSQL unavailable (${err?.message || err}). Falling back to in-memory persistence.`
    );
    if (client) {
      try {
        await client.end({ timeout: 1 });
      } catch {
        // Best effort: the pool may already be unusable.
      }
    }
    isConnectedToPostgres = false;
    dbInstance = null;
    sqlClient = null;
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
    isConnectedToPostgres = false;
  }
  isInitialized = false;
}
