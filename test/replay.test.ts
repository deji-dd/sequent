import { describe, expect, it } from 'bun:test';

import { projectEvents } from '../src/core/replay';
import type { EventRecord, WorkflowDefinition } from '../src/core/types';

const definition: WorkflowDefinition = {
  id: 'replay_def',
  name: 'Replay',
  version: 1,
  nodes: [
    { id: 'n1', name: 'N1', type: 'task', activityType: 'n1' },
    { id: 'n2', name: 'N2', type: 'task', activityType: 'n2' },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
};

function event(
  sequenceId: number,
  eventType: EventRecord['eventType'],
  nodeId: string | undefined,
  payload: Record<string, any> = {},
  metadata: Record<string, any> = {}
): EventRecord {
  return {
    id: `evt_${sequenceId}`,
    workflowExecutionId: 'exec_replay',
    sequenceId,
    eventType,
    nodeId,
    payload,
    metadata: { timestamp: 1700000000000 + sequenceId, ...metadata },
    createdAt: new Date(),
  };
}

describe('Shared replay projector', () => {
  it('does not mark a node complete on a step checkpoint', () => {
    const events = [
      event(1, 'WorkerLeaseAcquired', 'n1', { workerId: 'w1' }, { fencingToken: 1 }),
      event(2, 'ActivityStepCompleted', 'n1', { stepKey: 'n1:main_1', result: { ok: true } }),
    ];

    const timeline = projectEvents(events, definition, {});
    expect(timeline.nodeStates.n1.status).toBe('RUNNING');

    const recovery = projectEvents(events, definition, {}, 'recovery');
    expect(recovery.nodeStates.n1.status).toBe('IDLE');
  });

  it('reconstructs completions, failures, and the failed node id', () => {
    const events = [
      event(1, 'WorkerLeaseAcquired', 'n1', {}, { fencingToken: 1 }),
      event(2, 'ActivityStepCompleted', 'n1', { stepKey: 'n1:main_1', result: { ok: true } }),
      event(3, 'ActivityCompleted', 'n1', { result: { ok: true } }, { fencingToken: 1 }),
      event(4, 'WorkerLeaseAcquired', 'n2', {}, { fencingToken: 1 }),
      event(5, 'ActivityFailed', 'n2', { error: 'boom' }),
      event(6, 'WorkflowFailing', undefined, { failedNodeId: 'n2', error: 'boom' }),
    ];

    const projection = projectEvents(events, definition, { seeded: true });
    expect(projection.nodeStates.n1.status).toBe('COMPLETED');
    expect(projection.nodeStates.n2.status).toBe('FAILED');
    expect(projection.contextState.n1).toEqual({ ok: true });
    expect(projection.contextState.seeded).toBe(true);
    expect(projection.failedNodeId).toBe('n2');
    expect(projection.error).toBe('boom');
  });

  it('retries an interrupted compensation in recovery mode', () => {
    const events = [
      event(1, 'ActivityCompleted', 'n1', { result: { ok: true } }),
      event(2, 'CompensationStarted', 'n1', { attempt: 1 }, { attempt: 1 }),
    ];

    const timeline = projectEvents(events, definition, {});
    expect(timeline.nodeStates.n1.status).toBe('COMPENSATING');

    const recovery = projectEvents(events, definition, {}, 'recovery');
    expect(recovery.nodeStates.n1.status).toBe('COMPLETED');
  });

  it('records compensated nodes idempotently', () => {
    const events = [
      event(1, 'ActivityCompleted', 'n1', { result: { ok: true } }),
      event(2, 'CompensationCompleted', 'n1', { attempt: 1 }, { attempt: 1 }),
      event(3, 'CompensationCompleted', 'n1', { attempt: 2 }, { attempt: 2 }),
    ];

    const projection = projectEvents(events, definition, {});
    expect(projection.nodeStates.n1.status).toBe('COMPENSATED');
    expect(projection.compensatedNodes).toEqual(['n1']);
  });
});
