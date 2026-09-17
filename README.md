# Sequent

> **Deterministic Event-Sourced Distributed Workflow Engine & Visual Execution Debugger**

Sequent executes multi-step directed acyclic graphs (DAGs) with parallel branching, guarantees zero state loss across arbitrary server crashes via deterministic event replay, coordinates forward execution and backward saga rollbacks, and prevents split-brain writes using distributed worker fencing tokens.

---

## Key Capabilities & Architecture

### 1. Graph Compilation & Workflow Initialization
- **DAG Compilation**: Validates linear, branching, and parallel tasks. Performs topological sorting and cycle detection via Kahn's algorithm.
- **Join Barriers**: Automatically identifies multi-parent join nodes where parallel execution branches must synchronize before proceeding.
- **Event Sourcing**: Commits an initial `WorkflowExecutionStarted` record (sequence ID = 1) to the append-only `event_log` table.

### 2. Distributed Task Dispatch & Worker Fencing
- **Monotonic Fencing Tokens**: RAM cache-backed leases with PostgreSQL DB fallback, issued with atomic incrementing fencing tokens (`INCR`).
- **Heartbeat & TTL**: Workers maintain leases via periodic heartbeat renewals.
- **Split-Brain Write Rejection**: If a worker suffers a GC pause or network partition, its lease expires and is re-issued with a higher token ($T_{new} > T_{old}$). When the zombie worker attempts to commit its results, the transaction aborts with `WorkerFencingRejected`.

### 3. Deterministic Execution Sandbox & Side-Effect Interception
- **Deterministic Proxy**: Activities execute inside a sandbox that wraps network requests, timers, randoms, and clocks.
- **Replay Interception**: The proxy inspects historical events in `event_log`. If a completed event exists for the node, it returns the cached result immediately, executing **zero network calls**.

### 4. Parallel Branch Failure & Active Task Cancellation
- **Sibling Abort Propagation**: When one parallel branch encounters an error, the engine shifts state to `FAILING` and dispatches active `AbortSignal`s to all running sibling tasks.
- **Graceful Quorum Pause**: The orchestrator waits until all active siblings either finish safely, acknowledge abort, or timeout before initiating rollbacks.

### 5. Fault-Tolerant Saga Compensation with Retry Backoff
- **Reverse Topological Rollback**: The engine shifts to `COMPENSATING` and traverses completed steps in reverse topological order (LIFO).
- **Exponential Backoff**: Transient compensation errors are retried with exponential backoff and jitter ($t = \text{base} \times 2^{\text{attempt}}$).
- **Poison-Pill Quarantine**: If retries are exhausted, the workflow transitions to `POISON_PILL_BLOCKED`, alerts operators, and quarantines in the manual recovery queue.

### 6. Zero-Loss Crash Recovery via Event Replay
- **Automated Bootstrapping**: On server restart, the engine queries unfinalized workflows (`RUNNING`, `FAILING`, `COMPENSATING`).
- **Deterministic Replay**: Reconstructs the workflow function state by serving cached outputs from historical `event_log` records until reaching the exact uncommitted node where the crash occurred, resuming live execution.

### 7. Telemetry Streaming & Time-Travel Debugging
- **WebSocket Streaming**: Broadcasts state transitions, lease acquisitions, token progression, and compensations over `/ws`.
- **Interactive DAG Visualizer**: Rendered using XYFlow and Dagre with live token progression along edges and state badges.
- **Interactive Time-Travel Scrubber**: Rewinds the visual DAG to any historical sequence ID, allowing millisecond-level payload and state inspection.
- **Chaos Lab**: One-click triggers for **Zombie Worker Split-Brain Rejection**, **Simulated Server Crash & Instant Replay**, and **Parallel Branch Failure Saga Rollback**.

---

## Tech Stack & Setup

- **Runtime**: [Bun](https://bun.sh)
- **API Framework**: [Elysia](https://elysiajs.com) on Port `3003`
- **Database ORM**: [Drizzle ORM](https://orm.drizzle.team) with PostgreSQL (`sequent_db`) via Unix Socket (`/var/run/postgresql`) or TCP
- **Distributed State & Leases**: In-memory RAM Cache with PostgreSQL DB fallback (`worker_leases` table)
- **Frontend**: [Vite](https://vitejs.dev), [React](https://react.dev), [Tailwind CSS v4](https://tailwindcss.com), [@xyflow/react](https://reactflow.dev), [Radix UI](https://www.radix-ui.com), [Lucide Icons](https://lucide.dev)
- **Code Standards**: [Biome](https://biomejs.dev)

---

## Quick Start

### 1. Install Dependencies
```bash
bun install
```

### 2. Run in Development
```bash
# Start Elysia backend server (Port 3003)
bun run dev

# In another terminal, start Vite frontend
bun run dev:ui
```

### 3. Production Build & Start
```bash
bun run build
bun run start
```

### 4. Run Automated Test Suite
```bash
bun test
```

### 5. Type Checking & Linting
```bash
bun run typecheck
bun run lint
```

---

## Deployment (dejis-cloud)

The repository includes a production-ready multi-stage Bun `Dockerfile` and `docker-compose.yml` with host Unix domain socket volumes mounted for PostgreSQL IPC:

```bash
docker compose up -d --build
```

GitHub Actions workflow `.github/workflows/deploy.yml` deploys to `/opt/sequent` on `dejis-cloud`.
