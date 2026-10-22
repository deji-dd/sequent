import { existsSync } from 'node:fs';
import path from 'node:path';

import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { Elysia } from 'elysia';

import { CrashRecoveryCoordinator } from './core/crash-recovery';
import { DAGCompilationError, DAGCompiler } from './core/dag-compiler';
import { PoisonPillResolutionError } from './core/errors';
import { orchestrator } from './core/orchestrator';
import { PRESET_WORKFLOWS } from './core/presets';
import { projectEvents } from './core/replay';
import { telemetryBroadcaster } from './core/telemetry';
import type { ChaosConfig, WorkflowDefinition } from './core/types';
import { closeDb, initDb, isDbConnected, pingDb } from './db';
import { workflowRepository } from './db/repository';

const PORT = Number(process.env.PORT || 3003);
const DIST_DIR = path.resolve(import.meta.dir, '../dist');

let bootCompleted = false;

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateChaosConfig(
  definition: WorkflowDefinition,
  raw: unknown
): { config?: ChaosConfig; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) return { error: 'chaosConfig must be an object' };

  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const references: Array<keyof ChaosConfig> = [
    'zombieNodeId',
    'crashNodeId',
    'failNodeId',
    'poisonPillNodeId',
  ];

  for (const key of references) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !nodeIds.has(value)) {
      return { error: `chaosConfig.${key} must reference an existing node in this workflow` };
    }
  }

  if (
    raw.stepDelayMs !== undefined &&
    (typeof raw.stepDelayMs !== 'number' ||
      !Number.isFinite(raw.stepDelayMs) ||
      raw.stepDelayMs < 0)
  ) {
    return { error: 'chaosConfig.stepDelayMs must be a non-negative number' };
  }

  return {
    config: {
      stepDelayMs: raw.stepDelayMs,
      zombieNodeId: raw.zombieNodeId,
      crashNodeId: raw.crashNodeId,
      failNodeId: raw.failNodeId,
      poisonPillNodeId: raw.poisonPillNodeId,
    },
  };
}

/**
 * Boots persistence and crash recovery. Exported so tests can await readiness
 * without starting a real listener.
 */
export async function bootstrap(): Promise<void> {
  try {
    await initDb();
    for (const preset of PRESET_WORKFLOWS) {
      await workflowRepository.saveDefinition(preset);
    }
    // Boot crash recovery for unfinalized workflows
    await CrashRecoveryCoordinator.recoverUnfinalizedWorkflows();
  } catch (err) {
    console.error('[Sequent Boot] Error initializing database or presets:', err);
  } finally {
    bootCompleted = true;
  }
}

export const ready = bootstrap();

export const app = new Elysia()
  .use(
    cors({
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',')
        : process.env.NODE_ENV !== 'production',
    })
  )

  // Health and System Diagnostics
  .get('/api/health', async () => ({
    status: 'ok',
    service: 'sequent',
    port: PORT,
    timestamp: Date.now(),
    uptime: process.uptime(),
    ready: bootCompleted,
    dbConnected: isDbConnected() ? await pingDb() : false,
  }))

  .get('/api/stats', () => ({
    metrics: orchestrator.getMetrics(),
    activeSockets: telemetryBroadcaster.getSocketCount(),
    dbConnected: isDbConnected(),
    timestamp: Date.now(),
  }))

  // Workflow Definitions API
  .get('/api/workflows', async () => {
    return workflowRepository.listDefinitions();
  })

  .get('/api/workflows/:id', async ({ params, set }) => {
    const def = await workflowRepository.getDefinition(params.id);
    if (!def) {
      set.status = 404;
      return { error: 'Workflow definition not found' };
    }
    return def;
  })

  .post('/api/workflows', async ({ body, set }) => {
    try {
      const def = body as WorkflowDefinition;
      if (!isObject(def) || !def.id || !def.name || !Array.isArray(def.nodes)) {
        set.status = 400;
        return { error: 'Invalid workflow definition format' };
      }
      // Validate the graph before persisting it so cycles/duplicate IDs fail fast.
      DAGCompiler.compile(def);
      await workflowRepository.saveDefinition(def);
      return { success: true, definition: def };
    } catch (err: any) {
      set.status = 400;
      return { error: err.message };
    }
  })

  // Workflow Trigger & Execution API
  .post('/api/workflows/:id/trigger', async ({ params, body, set }) => {
    const def = await workflowRepository.getDefinition(params.id);
    if (!def) {
      set.status = 404;
      return { error: 'Workflow definition not found' };
    }

    const bodyObj = isObject(body) ? body : {};
    const chaos = validateChaosConfig(def, bodyObj.chaosConfig);
    if (chaos.error) {
      set.status = 400;
      return { error: chaos.error };
    }

    try {
      const inputPayload = isObject(bodyObj.input) ? bodyObj.input : { triggeredAt: Date.now() };
      const outcome = await orchestrator.startWorkflow(def, inputPayload, undefined, chaos.config);
      return {
        success: true,
        executionId: outcome.executionId,
        status: outcome.status,
      };
    } catch (err: any) {
      if (err instanceof DAGCompilationError) {
        set.status = 400;
        return { error: err.message };
      }
      set.status = 500;
      return { error: err.message };
    }
  })

  .get('/api/executions', async ({ query }) => {
    const limit = Math.min(100, Math.max(1, Number(query?.limit) || 30));
    const offset = Math.max(0, Number(query?.offset) || 0);
    const workflowDefinitionId = query?.workflowDefinitionId as string | undefined;
    const status = query?.status as any;
    return workflowRepository.listExecutions({
      limit,
      offset,
      workflowDefinitionId,
      status,
    });
  })

  .get('/api/executions/:id', async ({ params, set }) => {
    const execution = await workflowRepository.getExecution(params.id);
    if (!execution) {
      set.status = 404;
      return { error: 'Execution not found' };
    }
    return execution;
  })

  .get('/api/executions/:id/events', async ({ params, query, set }) => {
    const execution = await workflowRepository.getExecution(params.id);
    if (!execution) {
      set.status = 404;
      return { error: 'Execution not found' };
    }

    let events = await workflowRepository.getEventLog(params.id);

    const afterSequence = Number(query?.afterSequence);
    if (Number.isFinite(afterSequence) && afterSequence > 0) {
      events = events.filter((evt) => evt.sequenceId > afterSequence);
    }

    const limitRaw = Number(query?.limit);
    if (Number.isFinite(limitRaw) && limitRaw > 0) {
      events = events.slice(0, Math.min(1000, Math.floor(limitRaw)));
    }

    return events;
  })

  // Time-Travel Debugging Endpoint: Rewind graph and state to a specific sequenceId
  .get('/api/executions/:id/time-travel', async ({ params, query, set }) => {
    const targetSeq = Number(query?.sequenceId);
    if (!Number.isInteger(targetSeq) || targetSeq < 1) {
      set.status = 400;
      return { error: 'Valid sequenceId parameter required' };
    }

    const execution = await workflowRepository.getExecution(params.id);
    if (!execution) {
      set.status = 404;
      return { error: 'Execution not found' };
    }

    const definition = await workflowRepository.getDefinition(execution.workflowDefinitionId);
    if (!definition) {
      set.status = 404;
      return { error: 'Workflow definition for this execution was not found' };
    }

    const events = await workflowRepository.getEventsUpToSequence(params.id, targetSeq);
    const projection = projectEvents(events, definition, execution.inputPayload || {}, 'timeline');

    return {
      executionId: params.id,
      sequenceId: targetSeq,
      nodeStates: projection.nodeStates,
      contextState: projection.contextState,
      eventSnapshot: events[events.length - 1] || null,
      totalReplayedEvents: events.length,
    };
  })

  // Simulation Controls: Trigger Zombie delay on a node
  .post('/api/executions/:id/simulate-zombie', async ({ params, body, set }) => {
    const nodeId = isObject(body) ? body.nodeId : undefined;
    if (!nodeId || typeof nodeId !== 'string') {
      set.status = 400;
      return { error: 'nodeId is required to simulate zombie delay' };
    }

    const success = orchestrator.triggerZombieDelay(params.id, nodeId);
    return {
      success,
      message: success
        ? `Zombie worker simulation primed on node '${nodeId}'. Worker lease will expire, a new lease with higher fencing token will be assigned, and stale worker commit will be rejected.`
        : `Execution ${params.id} is not currently active in orchestrator.`,
    };
  })

  // Simulation Controls: Crash orchestrator and verify recovery
  .post('/api/executions/:id/simulate-crash', async ({ params }) => {
    orchestrator.simulateCrash(params.id);

    // Wait 400ms then initiate crash recovery to simulate reboot
    setTimeout(async () => {
      console.log(`[Sequent Simulation] Initiating zero-loss recovery for ${params.id}...`);
      await orchestrator.recoverWorkflow(params.id);
    }, 400);

    return {
      success: true,
      message: `Simulated sudden process kill for execution ${params.id}. Server recovery coordinator will automatically reboot, replay deterministic events from event_log, and resume at uncommitted node.`,
    };
  })

  // Poison Pill Quarantine Management API
  .get('/api/poison-pill', async () => {
    return workflowRepository.listPoisonPillItems();
  })

  .post('/api/poison-pill/:id/resolve', async ({ params, body, set }) => {
    const requested = isObject(body) ? body.action : undefined;
    const action = requested === undefined ? 'RESOLVED' : requested;
    if (action !== 'RESOLVED' && action !== 'SKIPPED') {
      set.status = 400;
      return { error: "action must be either 'RESOLVED' or 'SKIPPED'" };
    }

    try {
      const result = await orchestrator.resolvePoisonPill(params.id, action);
      return {
        success: true,
        action,
        status: result.status,
        executionId: result.executionId,
        item: result.item,
      };
    } catch (err: any) {
      if (err instanceof PoisonPillResolutionError) {
        set.status = err.code === 'not_found' ? 404 : 409;
        return { error: err.message, code: err.code };
      }
      set.status = 500;
      return { error: err.message };
    }
  })

  // Real-Time WebSocket Telemetry
  .ws('/ws', {
    open(ws) {
      telemetryBroadcaster.addSocket(ws);
      ws.send(
        JSON.stringify({
          type: 'CONNECTED',
          data: { timestamp: Date.now(), service: 'sequent' },
        })
      );
    },
    close(ws) {
      telemetryBroadcaster.removeSocket(ws);
    },
    message(ws, message) {
      try {
        const cmd = typeof message === 'string' ? JSON.parse(message) : message;
        if (cmd?.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        }
      } catch {
        // Ignored
      }
    },
  });

// Serve static frontend in production if dist exists
if (existsSync(DIST_DIR)) {
  app.use(staticPlugin({ assets: DIST_DIR, prefix: '/' }));
  // Fallback route for SPA client-side routing
  app.get('*', ({ request, set }) => {
    // Unknown API routes must not fall through to the SPA shell.
    if (new URL(request.url).pathname.startsWith('/api/')) {
      set.status = 404;
      return { error: 'Not Found' };
    }
    const htmlPath = path.join(DIST_DIR, 'index.html');
    if (existsSync(htmlPath)) {
      set.headers['content-type'] = 'text/html';
      return Bun.file(htmlPath);
    }
    set.status = 404;
    return 'Not Found';
  });
}

if (import.meta.main) {
  ready
    .then(() => {
      app.listen(PORT);
      console.log(`Sequent Engine online at http://localhost:${PORT}`);
      console.log(`WebSocket Telemetry: ws://localhost:${PORT}/ws`);
    })
    .catch((err) => {
      console.error('[Sequent] Failed to start:', err);
      process.exit(1);
    });

  const shutdown = async (signal: string) => {
    console.log(`[Sequent] ${signal} received, shutting down...`);
    orchestrator.shutdown();
    try {
      await app.stop();
    } catch {
      // Ignore stop errors during shutdown.
    }
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export type App = typeof app;
