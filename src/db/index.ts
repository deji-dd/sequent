import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
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

  try {
    let client: ReturnType<typeof postgres>;
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

    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS "workflow_definitions" (
        "id" text PRIMARY KEY,
        "name" text NOT NULL,
        "description" text,
        "version" integer DEFAULT 1 NOT NULL,
        "definition" jsonb NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "workflow_executions" (
        "id" text PRIMARY KEY,
        "workflow_definition_id" text NOT NULL,
        "status" text NOT NULL,
        "current_sequence_id" integer DEFAULT 0 NOT NULL,
        "active_fencing_token" integer DEFAULT 0 NOT NULL,
        "input_payload" jsonb NOT NULL,
        "output_payload" jsonb,
        "context_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "node_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
        "chaos_config" jsonb,
        "error" text,
        "started_at" timestamp with time zone NOT NULL,
        "completed_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "event_log" (
        "id" text PRIMARY KEY,
        "workflow_execution_id" text NOT NULL,
        "sequence_id" integer NOT NULL,
        "node_id" text,
        "event_type" text NOT NULL,
        "payload" jsonb NOT NULL,
        "metadata" jsonb NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "worker_leases" (
        "id" text PRIMARY KEY,
        "workflow_execution_id" text NOT NULL,
        "node_id" text NOT NULL,
        "worker_id" text NOT NULL,
        "fencing_token" integer NOT NULL,
        "ttl_ms" integer NOT NULL,
        "status" text DEFAULT 'active' NOT NULL,
        "acquired_at" timestamp with time zone NOT NULL,
        "expires_at" timestamp with time zone NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS "poison_pill_queue" (
        "id" text PRIMARY KEY,
        "workflow_execution_id" text NOT NULL,
        "node_id" text NOT NULL,
        "activity_type" text NOT NULL,
        "compensation_type" text NOT NULL,
        "attempts" integer NOT NULL,
        "last_error" text NOT NULL,
        "payload" jsonb NOT NULL,
        "status" text DEFAULT 'PENDING' NOT NULL,
        "blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
        "resolved_at" timestamp with time zone
      );
    `);

    // Ensure schema migrations for existing databases
    await client.unsafe(`
      ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "chaos_config" jsonb;
    `);

    // Create index on event_log for fast sequential lookups & replay
    await client.unsafe(`
      CREATE INDEX IF NOT EXISTS "idx_event_log_exec_seq" 
      ON "event_log" ("workflow_execution_id", "sequence_id" ASC);

      CREATE INDEX IF NOT EXISTS "idx_executions_status" 
      ON "workflow_executions" ("status");
    `);

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
    isConnectedToPostgres = false;
    dbInstance = null;
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
}
