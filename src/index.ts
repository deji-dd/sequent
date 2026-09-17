import { existsSync } from 'node:fs';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { Elysia } from 'elysia';
import { CrashRecoveryCoordinator } from './core/crash-recovery';
import { orchestrator } from './core/orchestrator';
import { PRESET_WORKFLOWS } from './core/presets';
import { telemetryBroadcaster } from './core/telemetry';
import type { WorkflowDefinition } from './core/types';
import { initDb, isDbConnected } from './db';
import { workflowRepository } from './db/repository';

const PORT = Number(process.env.PORT || 3003);
const _isProd = process.env.NODE_ENV === 'production';

// Initialize DB and Seed Presets on Boot
(async () => {
  try {
    await initDb();
    for (const preset of PRESET_WORKFLOWS) {
      await workflowRepository.saveDefinition(preset);
    }
    // Boot crash recovery for unfinalized workflows
    await CrashRecoveryCoordinator.recoverUnfinalizedWorkflows();
  } catch (err) {
    console.error('[Sequent Boot] Error initializing database or presets:', err);
  }
})();

export const app = new Elysia()
  .use(cors())

  // Health and System Diagnostics
  .get('/api/health', () => ({
    status: 'ok',
    service: 'sequent',
    port: PORT,
    timestamp: Date.now(),
    uptime: process.uptime(),
    dbConnected: isDbConnected(),
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
      if (!def.id || !def.name || !Array.isArray(def.nodes)) {
        set.status = 400;
        return { error: 'Invalid workflow definition format' };
      }
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

    try {
      const inputPayload = (body as any)?.input || { triggeredAt: Date.now() };
      const chaosConfig = (body as any)?.chaosConfig;
      const outcome = await orchestrator.startWorkflow(def, inputPayload, undefined, chaosConfig);
      return {
        success: true,
        executionId: outcome.executionId,
        status: outcome.status,
      };
    } catch (err: any) {
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

  .get('/api/executions/:id/events', async ({ params }) => {
    return workflowRepository.getEventLog(params.id);
  })

  // Time-Travel Debugging Endpoint: Rewind graph and state to a specific sequenceId
  .get('/api/executions/:id/time-travel', async ({ params, query, set }) => {
    const targetSeq = Number(query?.sequenceId);
    if (Number.isNaN(targetSeq) || targetSeq < 1) {
      set.status = 400;
      return { error: 'Valid sequenceId parameter required' };
    }

    const execution = await workflowRepository.getExecution(params.id);
    if (!execution) {
      set.status = 404;
      return { error: 'Execution not found' };
    }

    const events = await workflowRepository.getEventsUpToSequence(params.id, targetSeq);

    // Reconstruct state at target sequence ID
    const replayedNodeStates: Record<string, any> = {};
    const contextState = { ...execution.inputPayload };

    for (const evt of events) {
      if (evt.nodeId) {
        if (!replayedNodeStates[evt.nodeId]) {
          replayedNodeStates[evt.nodeId] = { status: 'IDLE' };
        }
        if (evt.eventType === 'WorkerLeaseAcquired') {
          replayedNodeStates[evt.nodeId].status = 'RUNNING';
          replayedNodeStates[evt.nodeId].fencingToken = evt.metadata?.fencingToken;
        } else if (evt.eventType === 'ActivityCompleted') {
          replayedNodeStates[evt.nodeId].status = 'COMPLETED';
          replayedNodeStates[evt.nodeId].output = evt.payload?.result;
          contextState[evt.nodeId] = evt.payload?.result;
        } else if (evt.eventType === 'ActivityFailed') {
          replayedNodeStates[evt.nodeId].status = 'FAILED';
          replayedNodeStates[evt.nodeId].error = evt.payload?.error;
        } else if (evt.eventType === 'ActivityCancelled') {
          replayedNodeStates[evt.nodeId].status = 'CANCELLED';
        } else if (evt.eventType === 'CompensationCompleted') {
          replayedNodeStates[evt.nodeId].status = 'COMPENSATED';
        } else if (evt.eventType === 'WorkerFencingRejected') {
          replayedNodeStates[evt.nodeId].status = 'FAILED';
          replayedNodeStates[evt.nodeId].error =
            'Split-Brain Write Rejected (Fencing Token Mismatch)';
        }
      }
    }

    return {
      executionId: params.id,
      sequenceId: targetSeq,
      nodeStates: replayedNodeStates,
      contextState,
      eventSnapshot: events[events.length - 1] || null,
      totalReplayedEvents: events.length,
    };
  })

  // Simulation Controls: Trigger Zombie delay on a node
  .post('/api/executions/:id/simulate-zombie', async ({ params, body, set }) => {
    const nodeId = (body as any)?.nodeId;
    if (!nodeId) {
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
    const action = (body as any)?.action || 'RESOLVED';
    const ok = await workflowRepository.resolvePoisonPill(params.id, action);
    if (!ok) {
      set.status = 404;
      return { error: 'Poison pill item not found' };
    }
    return { success: true, status: action };
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
if (existsSync('dist')) {
  app.use(staticPlugin({ assets: 'dist', prefix: '/' }));
  // Fallback route for SPA client-side routing
  app.get('*', ({ set }) => {
    const htmlPath = 'dist/index.html';
    if (existsSync(htmlPath)) {
      set.headers['content-type'] = 'text/html';
      return Bun.file(htmlPath);
    }
    set.status = 404;
    return 'Not Found';
  });
}

app.listen(PORT);

console.log(`Sequent Engine online at http://localhost:${PORT}`);
console.log(`WebSocket Telemetry: ws://localhost:${PORT}/ws`);

export type App = typeof app;
