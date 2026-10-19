import type { EventRecord, NodeRuntimeState, WorkflowDefinition } from './types';

export type ReplayMode = 'timeline' | 'recovery';

export interface ReplayProjection {
  nodeStates: Record<string, NodeRuntimeState>;
  contextState: Record<string, any>;
  failedNodeId?: string;
  error?: string;
  compensatedNodes: string[];
}

/**
 * Single source of truth for turning an event log into node/context state.
 *
 * - `timeline` is used by the time-travel endpoint: it reflects exactly what a
 *   node was doing at the requested sequence (including running leases).
 * - `recovery` is used after a restart: nodes that were merely leased/running at
 *   crash time are reset to IDLE so they can be re-dispatched, while completed,
 *   failed, cancelled and compensated nodes keep their durable state.
 */
export function projectEvents(
  events: EventRecord[],
  definition: WorkflowDefinition,
  inputPayload: Record<string, any> = {},
  mode: ReplayMode = 'timeline'
): ReplayProjection {
  const nodeStates: Record<string, NodeRuntimeState> = {};
  for (const node of definition.nodes) {
    nodeStates[node.id] = { status: 'IDLE', attempts: 0 };
  }

  const contextState: Record<string, any> = { ...inputPayload };
  const compensatedNodes: string[] = [];
  let failedNodeId: string | undefined;
  let error: string | undefined;

  for (const evt of events) {
    if (!evt.nodeId) {
      if (evt.eventType === 'WorkflowFailing') {
        failedNodeId = failedNodeId || evt.payload?.failedNodeId;
        error = error || evt.payload?.error;
      }
      continue;
    }

    const state = nodeStates[evt.nodeId];
    if (!state) continue;
    const timestamp = Number(evt.metadata?.timestamp || evt.createdAt?.getTime?.() || Date.now());

    switch (evt.eventType) {
      case 'WorkerLeaseAcquired':
        // After a crash there is no live worker; the node must be re-dispatched.
        if (mode === 'timeline') {
          state.status = 'RUNNING';
          state.workerId = evt.metadata?.workerId;
          state.fencingToken = evt.metadata?.fencingToken;
          state.startedAt = timestamp;
        }
        break;

      case 'ActivityStepCompleted':
        // Step checkpoints are replayed by DeterministicProxy; they do not mean
        // the node itself completed.
        break;

      case 'ActivityCompleted':
        state.status = 'COMPLETED';
        state.output = evt.payload?.result;
        state.completedAt = timestamp;
        contextState[evt.nodeId] = evt.payload?.result;
        break;

      case 'ActivityFailed':
        state.status = 'FAILED';
        state.error = evt.payload?.error;
        failedNodeId = failedNodeId || evt.nodeId;
        error = error || evt.payload?.error;
        break;

      case 'ActivityCancelled':
        state.status = 'CANCELLED';
        break;

      case 'CompensationScheduled':
      case 'CompensationStarted':
        state.status = 'COMPENSATING';
        state.compensationAttempts = evt.metadata?.attempt ?? state.compensationAttempts;
        break;

      case 'CompensationCompleted':
        state.status = 'COMPENSATED';
        state.isCompensated = true;
        state.compensationAttempts = evt.metadata?.attempt ?? state.compensationAttempts;
        if (!compensatedNodes.includes(evt.nodeId)) compensatedNodes.push(evt.nodeId);
        break;

      case 'CompensationFailed':
        // Still eligible for a retry on recovery.
        state.status = 'COMPLETED';
        state.error = evt.payload?.error;
        state.compensationAttempts = evt.metadata?.attempt ?? state.compensationAttempts;
        break;

      case 'CompensationSkipped':
        state.status = 'COMPENSATED';
        state.isCompensated = false;
        state.error = evt.payload?.reason || 'Compensation skipped by operator';
        break;

      case 'WorkflowPoisonPillBlocked':
        state.status = 'POISON_PILL_BLOCKED';
        state.error = evt.payload?.error || state.error;
        break;

      case 'PoisonPillResolved':
      case 'PoisonPillSkipped':
        // Operator audit events; the subsequent compensation events drive node state.
        break;

      case 'WorkerFencingRejected':
        state.status = 'FAILED';
        state.error = 'Split-Brain Write Rejected (Fencing Token Mismatch)';
        failedNodeId = failedNodeId || evt.nodeId;
        error = error || state.error;
        break;

      default:
        break;
    }
  }

  if (mode === 'recovery') {
    for (const state of Object.values(nodeStates)) {
      if (state.status === 'RUNNING' || state.status === 'SCHEDULED') {
        state.status = 'IDLE';
        state.workerId = undefined;
        state.fencingToken = undefined;
        state.startedAt = undefined;
      } else if (state.status === 'COMPENSATING') {
        // A compensation was interrupted mid-flight: make it eligible for retry.
        state.status = 'COMPLETED';
      }
    }
  }

  return { nodeStates, contextState, failedNodeId, error, compensatedNodes };
}
