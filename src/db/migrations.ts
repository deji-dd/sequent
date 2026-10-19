/**
 * Ordered, idempotent schema migrations. The app bootstraps these before it starts
 * accepting requests; `db:migrate` applies the same list explicitly.
 *
 * Migration 2 repairs databases created by the old runtime DDL: it renumbers any
 * duplicate event sequence IDs, then installs the uniqueness constraint that makes
 * the append path safe.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const INITIAL_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS "workflow_definitions" (
    "id" text PRIMARY KEY,
    "name" text NOT NULL,
    "description" text,
    "version" integer DEFAULT 1 NOT NULL,
    "definition" jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "workflow_executions" (
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
  );`,
  `CREATE TABLE IF NOT EXISTS "event_log" (
    "id" text PRIMARY KEY,
    "workflow_execution_id" text NOT NULL,
    "sequence_id" integer NOT NULL,
    "node_id" text,
    "event_type" text NOT NULL,
    "payload" jsonb NOT NULL,
    "metadata" jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS "worker_leases" (
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
  );`,
  `CREATE TABLE IF NOT EXISTS "poison_pill_queue" (
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
  );`,
];

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    statements: INITIAL_SCHEMA,
  },
  {
    version: 2,
    name: 'event_sequence_uniqueness_and_indexes',
    statements: [
      // Repair duplicate sequence IDs created by the old SELECT-max + INSERT path.
      `WITH ranked AS (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "workflow_execution_id"
                 ORDER BY "sequence_id" ASC, "created_at" ASC, "id" ASC
               ) AS rn
        FROM "event_log"
      )
      UPDATE "event_log" SET "sequence_id" = ranked.rn
      FROM ranked
      WHERE "event_log"."id" = ranked."id";`,
      `UPDATE "workflow_executions" e
       SET "current_sequence_id" = COALESCE(
         (SELECT MAX(ev."sequence_id") FROM "event_log" ev WHERE ev."workflow_execution_id" = e."id"),
         0
       );`,
      // Collapse duplicate pending poison pills before adding the partial unique index.
      `DELETE FROM "poison_pill_queue" p
       USING "poison_pill_queue" q
       WHERE p."status" = 'PENDING'
         AND q."status" = 'PENDING'
         AND p."workflow_execution_id" = q."workflow_execution_id"
         AND p."node_id" = q."node_id"
         AND p."id" > q."id";`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_event_log_exec_seq_unique"
       ON "event_log" ("workflow_execution_id", "sequence_id");`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_poison_pill_pending_unique"
       ON "poison_pill_queue" ("workflow_execution_id", "node_id")
       WHERE "status" = 'PENDING';`,
      `CREATE INDEX IF NOT EXISTS "idx_worker_leases_expires"
       ON "worker_leases" ("expires_at");`,
      `CREATE INDEX IF NOT EXISTS "idx_poison_pill_status"
       ON "poison_pill_queue" ("status");`,
      `CREATE INDEX IF NOT EXISTS "idx_executions_status"
       ON "workflow_executions" ("status");`,
      `ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "chaos_config" jsonb;`,
    ],
  },
];

/**
 * Applies all pending migrations. `client` is a postgres-js client (typed loosely to
 * avoid importing driver internals into the migration module).
 */
export async function applyMigrations(client: any): Promise<number[]> {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "schema_migrations" (
      "version" integer PRIMARY KEY,
      "name" text NOT NULL,
      "applied_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);

  const rows = await client.unsafe(`SELECT "version" FROM "schema_migrations"`);
  const applied = new Set<number>(
    (rows as Array<{ version: number }>).map((row) => Number(row.version))
  );

  const newlyApplied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    for (const statement of migration.statements) {
      await client.unsafe(statement);
    }
    await client.unsafe(
      `INSERT INTO "schema_migrations" ("version", "name") VALUES ($1, $2) ON CONFLICT ("version") DO NOTHING`,
      [migration.version, migration.name]
    );
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}
