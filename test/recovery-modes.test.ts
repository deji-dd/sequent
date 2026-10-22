import { beforeEach, describe, expect, it } from 'bun:test';

import { ramCache } from '../src/cache';
import { orchestrator } from '../src/core/orchestrator';
import { sagaCompensator } from '../src/core/saga-compensator';
import type { WorkflowDefinition } from '../src/core/types';
import { workflowRepository } from '../src/db/repository';
import { waitFor } from './support/helpers';

function recoveryDefinition(id: string, compensationType: string): WorkflowDefinition {
  return {
    id,
    name: 'Recovery mode regression',
    version: 1,
    nodes: [
      {
        id: 's1',
        name: 'S1',
        type: 'task',
        activityType: 's1',
        compensationType,
        retryPolicy: { maxRetries: 1, initialBackoffMs: 10, backoffMultiplier: 1 },
      },
      { id: 's2', name: 'S2', type: 'task', activityType: 's2' },
    ],
    edges: [{ id: 'e1', source: 's1', target: 's2' }],
  };
}

async function seedExecution(
  definition: WorkflowDefinition,
  executionId: string,
  status: 'FAILING' | 'COMPENSATING',
  partialCompensation: boolean
): Promise<void> {
  await workflowRepository.saveDefinition(definition);
  await workflowRepository.createExecution({
    id: executionId,
    workflowDefinitionId: definition.id,
    status,
    inputPayload: { seeded: true },
  });

  const append = (event: Parameters<typeof workflowRepository.appendEvent>[0]) =>
    workflowRepository.appendEvent(event);

  await append({
    workflowExecutionId: executionId,
    eventType: 'WorkflowExecutionStarted',
    payload: { inputPayload: { seeded: true } },
    metadata: { timestamp: Date.now() },
  });
  await append({
    workflowExecutionId: executionId,
    nodeId: 's1',
    eventType: 'WorkerLeaseAcquired',
    payload: { workerId: 'w1' },
    metadata: { timestamp: Date.now(), fencingToken: 1, workerId: 'w1' },
  });
  await append({
    workflowExecutionId: executionId,
    nodeId: 's1',
    eventType: 'ActivityCompleted',
    payload: { result: { ok: true } },
    metadata: { timestamp: Date.now(), fencingToken: 1, workerId: 'w1' },
  });
  await append({
    workflowExecutionId: executionId,
    nodeId: 's2',
    eventType: 'ActivityFailed',
    payload: { error: 'boom' },
    metadata: { timestamp: Date.now() },
  });
  await append({
    workflowExecutionId: executionId,
    eventType: 'WorkflowFailing',
    payload: { failedNodeId: 's2', error: 'boom' },
    metadata: { timestamp: Date.now() },
  });

  if (status === 'COMPENSATING') {
    await append({
      workflowExecutionId: executionId,
      eventType: 'WorkflowCompensating',
      payload: { reason: 'boom' },
      metadata: { timestamp: Date.now() },
    });
    await append({
      workflowExecutionId: executionId,
      nodeId: 's1',
      eventType: 'CompensationScheduled',
      payload: { compensationType: definition.nodes[0].compensationType },
      metadata: { timestamp: Date.now() },
    });
    if (partialCompensation) {
      await append({
        workflowExecutionId: executionId,
        nodeId: 's1',
        eventType: 'CompensationStarted',
        payload: { attempt: 1 },
        metadata: { timestamp: Date.now(), attempt: 1 },
      });
    }
  }
}

describe('Status-aware crash recovery', () => {
  beforeEach(() => {
    ramCache.clear();
    orchestrator.resetForTests();
  });

  it('resumes compensation for a FAILING execution', async () => {
    let calls = 0;
    const compensationType = `rb_failing_${Date.now()}`;
    sagaCompensator.registerHandler(compensationType, async () => {
      calls++;
    });

    const definition = recoveryDefinition(`rec_failing_${Date.now()}`, compensationType);
    const executionId = `exec_rec_failing_${Date.now()}`;
    await seedExecution(definition, executionId, 'FAILING', false);

    expect(await orchestrator.recoverWorkflow(executionId)).toBe(true);
    await waitFor(
      async () => (await workflowRepository.getExecution(executionId))?.status === 'FAILED'
    );

    const events = await workflowRepository.getEventLog(executionId);
    expect(calls).toBe(1);
    expect(events.some((event) => event.eventType === 'CompensationCompleted')).toBe(true);
    expect(events.filter((event) => event.eventType === 'WorkflowFailed')).toHaveLength(1);
  });

  it('resumes an interrupted COMPENSATING execution without double-compensating', async () => {
    let calls = 0;
    const compensationType = `rb_compensating_${Date.now()}`;
    sagaCompensator.registerHandler(compensationType, async () => {
      calls++;
    });

    const definition = recoveryDefinition(`rec_compensating_${Date.now()}`, compensationType);
    const executionId = `exec_rec_compensating_${Date.now()}`;
    await seedExecution(definition, executionId, 'COMPENSATING', true);

    expect(await orchestrator.recoverWorkflow(executionId)).toBe(true);
    await waitFor(
      async () => (await workflowRepository.getExecution(executionId))?.status === 'FAILED'
    );

    const events = await workflowRepository.getEventLog(executionId);
    expect(calls).toBe(1);
    expect(events.filter((event) => event.eventType === 'CompensationCompleted')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'WorkflowCompensating')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'WorkflowFailed')).toHaveLength(1);
  });
});
