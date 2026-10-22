# Sequent

> **Deterministic Event-Sourced Workflow Engine & Visual Execution Debugger**

Sequent executes directed acyclic graphs (DAGs) with parallel branching, replays completed work after a crash, coordinates forward execution and backward saga rollbacks, and rejects stale worker writes using per-node fencing tokens.

---

## Key Capabilities

### 1. Graph Compilation & Workflow Initialization

- **DAG Compilation**: validates linear, branching, and parallel graphs, then topologically sorts them and detects cycles via Kahn's algorithm.
- **Join Barriers**: multi-parent join nodes wait for every upstream branch before running.
- **Event Sourcing**: commits a `WorkflowExecutionStarted` record (sequence ID 1) and every subsequent state transition to the append-only `event_log`.

### 2. Per-Node Worker Fencing

- **Monotonic tokens**: each `(execution, node)` lease is issued with a strictly increasing fencing token from the RAM cache with a PostgreSQL fallback.
- **Exclusive leases**: a live lease held by another worker cannot be stolen unless the caller explicitly forces failover (used by the chaos simulation).
- **Atomic commit validation**: activity checkpoints and completions are validated against the live lease **inside the same transaction** that inserts the event. A stale worker is rejected with `WorkerFencingRejected` before any result is persisted.
- **Heartbeat watchdog**: if a heartbeat is rejected (lease expired or superseded), the task is aborted immediately instead of running until its final check.

### 3. Deterministic Execution Sandbox

- **Step checkpoints**: each `context.step(...)` writes an `ActivityStepCompleted` event only after the fence check succeeds. Node completion is a separate, single `ActivityCompleted` event.
- **Replay interception**: historical step results are served from the event log with zero network calls; node-level completion is never inferred from a step checkpoint.
- **Abortable timers**: `context.sleep(...)` observes an `AbortSignal`, so cancelled tasks stop promptly.

### 4. Parallel Branch Failure & Real Cancellation

- When a branch fails, the workflow enters `FAILING`, aborts every running sibling via `AbortSignal`, and waits (bounded) for them to settle before compensation starts.
- Late results from a killed/finished run are dropped by a per-run identity check, so they cannot write events after a terminal transition.

### 5. Fault-Tolerant Saga Compensation

- **Reverse topological rollback**: completed nodes are compensated in reverse topological order.
- **Retries**: transient compensation failures retry with exponential backoff and jitter (`retryPolicy` on the node).
- **Poison-pill quarantine**: exhausted retries create a single pending item per `(execution, node)` and transition the workflow to `POISON_PILL_BLOCKED`.
- **Strict handlers**: a missing compensation handler is treated as a failure (with retries) rather than a silent success. Demo definitions can opt into a no-op with `metadata.simulatedCompensation = true`.

### 6. Status-Aware Crash Recovery

- On boot, `RUNNING`, `FAILING`, and `COMPENSATING` executions are replayed from the shared projection in `src/core/replay.ts`.
- `RUNNING` resumes forward dispatch from the first uncommitted node; `FAILING`/`COMPENSATING` resume rollback without double-compensating already compensated nodes.
- One-shot chaos injections (`crashNodeId`, `failNodeId`, `zombieNodeId`, `poisonPillNodeId`) are cleared on replay; only pacing (`stepDelayMs`) is restored.
- Stale leases left by the previous process are expired before re-dispatch.

### 7. Telemetry & Time-Travel Debugging

- **Execution-scoped WebSocket stream**: the UI ignores frames/events for any execution other than the one it is currently inspecting. The socket is opened once per page; scrubbing time travel does not reconnect.
- **DAG visualizer**: XYFlow + Dagre layout is computed only when the workflow definition changes, so live state updates do not reset dragged node positions.
- **Time-travel scrubber**: rewinds the DAG to any sequence ID using the same replay projection as crash recovery.
- **Chaos Lab**: one-click triggers for zombie-worker rejection, simulated crash & replay, parallel sibling cancellation, and poison-pill quarantine.

---

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) (latest)
- **API**: [Elysia](https://elysiajs.com) on port `3003`
- **Database**: [Drizzle ORM](https://orm.drizzle.team) + PostgreSQL (`sequent_db`), optional in development (in-memory fallback)
- **Leases**: RAM cache with PostgreSQL fallback (`worker_leases`)
- **Frontend**: Vite, React, Tailwind CSS v4, `@xyflow/react`, Radix UI, Lucide
- **Standards**: Bun (`bun fmt`)

---

## Quick Start

### 1. Install dependencies

```bash
bun install
```

### 2. Configure environment (optional for in-memory mode)

```bash
cp .env.example .env.development
# edit PostgreSQL credentials if you want persistence
```

### 3. Run in development

```bash
bun run dev      # Elysia API on :3003
bun run dev:ui   # Vite UI on :5174
```

### 4. Build & start in production

```bash
bun run build
bun run start
```

### 5. Database migrations

```bash
bun run db:migrate
```

Migrations are ordered and idempotent. The migration that installs the unique `(workflow_execution_id, sequence_id)` index also repairs duplicate sequence IDs left by older builds, and collapses duplicate pending poison-pill rows.

### 6. Tests, type checking, and formatting

```bash
bun test
bun run check   # Bun's built-in type checker (reads tsconfig.json)
bun run format
bun run format:check
```

Postgres-specific sequencing tests are opt-in so the default suite runs without a database:

```bash
TEST_DATABASE_URL=postgres://sequent_user:...@localhost:5432/sequent_db bun run test:pg
```

---

## Configuration

| Variable                      | Purpose                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `PORT`                        | API port (default `3003`)                                                                |
| `POSTGRES_*` / `DATABASE_URL` | PostgreSQL connection; without them the engine uses in-memory persistence in development |
| `CORS_ORIGIN`                 | Comma-separated allowed origins; unset is permissive for local development               |
| `EXECUTION_RETENTION_MS`      | How long terminal executions stay in memory for inspection (default `60000`)             |
| `MAX_TRACKED_EXECUTIONS`      | Cap on in-memory execution records (default `200`)                                       |

---

## Safety Model & Limitations

- **Single orchestrator**: workers and leases are simulated in-process. Multi-instance scheduling, Redis coordination, and cross-node ownership are out of scope; the DB lease table is a fallback, not a full distributed lock service.
- **Per-node fencing tokens**: tokens are scoped to `(execution, node)`, not to a whole workflow. The UI's "Active Fence Token" is the latest token seen for the run.
- **Conditional nodes/edges are not implemented**: definitions with `type: 'conditional'` or `edge.condition` are rejected at compile time rather than silently ignored.
- **`retryPolicy` is compensation-scoped**; activity-level retries are not implemented.
- **Poison-pill resolution resumes the rollback**: “Mark Resolved” retries the failed compensation and then continues with the remaining completions; “Skip” records an explicit `CompensationSkipped` event and continues with the other compensations. Both actions resume from the durable event log and work after a restart. If a retry fails again, the workflow returns to `POISON_PILL_BLOCKED` with a new pending item.
- **In-memory mode is ephemeral**: a restart loses executions unless PostgreSQL is configured and reachable.

---

## Deployment

The repository includes a multi-stage Bun `Dockerfile` (using a Bun 1.4.4 image) and a `docker-compose.yml` with host PostgreSQL socket volumes:

```bash
docker compose up -d --build
```

The GitHub Actions workflow `.github/workflows/deploy.yml` validates, builds, and deploys to `/opt/sequent` on `dejis-cloud`. A separate `.github/workflows/ci.yml` runs `bun check`, `format:check`, tests, and the frontend build on pushes and pull requests.

Before deploying, sync the production environment file:

```bash
bun run sync:env
```

The deploy step fails fast if `/opt/sequent/.env` is missing.
