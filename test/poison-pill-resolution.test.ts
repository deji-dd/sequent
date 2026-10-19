import { beforeEach, describe, expect, it } from 'bun:test';
import { ramCache } from '../src/cache';
import { orchestrator } from '../src/core/orchestrator';
import { sagaCompensator } from '../src/core/saga-compensator';
import type { WorkflowDefinition } from '../src/core/types';
import { workflowRepository } from '../src/db/repository';
import { waitFor } from './support/helpers';

function poisonDefinition(id: string, compensationType: string): WorkflowDefinition {
  return {
    id,
    name: 'Poison resolution',
    version: 1,
    nodes: [
      {
        id: 's1',
        name: 'S1',
        type: 'task',
        activityType: 's1',
        compensationType,
        retryPolicy: { maxRetries: 1, initialBackoffMs: 10, backoffMultiplier: 1 },
        metadata: { simulatedLatencyMs: 20 },
      },
      {
        id: 's2',
        name: 'S2',
        type: 'task',
        activityType: 's2',
        metadata: { simulatedLatencyMs: 20 },
      },
    ],
    edges: [{ id: 'e1', source: 's1', target: 's2' }],
  };
}

async function startPoison(
  definition: WorkflowDefinition
): Promise<{ executionId: string; itemId: string }> {
  const { executionId } = await orchestrator.startWorkflow(definition, {}, undefined, {
    poisonPillNodeId: 's1',
    failNodeId: 's2',
  });

  await waitFor(async () => {
    const execution = await workflowRepository.getExecution(executionId);
    return execution?.status === 'POISON_PILL_BLOCKED';
  }, 10000);

  const item = (await workflowRepository.listPoisonPillItems()).find(
    (candidate) =>
      candidate.workflowExecutionId === executionId &&
      candidate.nodeId === 's1' &&
      candidate.status === 'PENDING'
  );
  if (!item) throw new Error('Expected a pending poison pill item');
  return { executionId, itemId: item.id };
}

describe('Poison-pill resolution resumes compensation', () => {
  beforeEach(() => {
    ramCache.clear();
    orchestrator.resetForTests();
  });

  it('RESOLVED retries the failed compensation and finalizes the rollback', async () => {
    let calls = 0;
    const compensationType = `rb_resolve_${Date.now()}`;
    sagaCompensator.registerHandler(compensationType, async () => {
      calls++;
    });

    const definition = poisonDefinition(`pill_resolve_${Date.now()}`, compensationType);
    const { executionId, itemId } = await startPoison(definition);

    const result = await orchestrator.resolvePoisonPill(itemId, 'RESOLVED');
    expect(result.status).toBe('FAILED');
    expect(calls).toBe(1);

    const events = await workflowRepository.getEventLog(executionId);
    expect(events.filter((event) => event.eventType === 'PoisonPillResolved')).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === 'CompensationCompleted' && event.nodeId === 's1')
    ).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'WorkflowFailed')).toHaveLength(1);

    const item = await workflowRepository.getPoisonPill(itemId);
    expect(item?.status).toBe('RESOLVED');

    const failedEvent = events.find((event) => event.eventType === 'WorkflowFailed');
    expect(failedEvent?.payload.allCompensationsSucceeded).toBe(true);
  });

  it('SKIPPED records the skip and continues without calling the handler', async () => {
    let calls = 0;
    const compensationType = `rb_skip_${Date.now()}`;
    sagaCompensator.registerHandler(compensationType, async () => {
      calls++;
    });

    const definition = poisonDefinition(`pill_skip_${Date.now()}`, compensationType);
    const { executionId, itemId } = await startPoison(definition);

    const result = await orchestrator.resolvePoisonPill(itemId, 'SKIPPED');
    expect(result.status).toBe('FAILED');
    expect(calls).toBe(0);

    const events = await workflowRepository.getEventLog(executionId);
    expect(events.filter((event) => event.eventType === 'PoisonPillSkipped')).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === 'CompensationSkipped' && event.nodeId === 's1')
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === 'CompensationCompleted' && event.nodeId === 's1')
    ).toHaveLength(0);

    const failedEvent = events.find((event) => event.eventType === 'WorkflowFailed');
    expect(failedEvent?.payload.allCompensationsSucceeded).toBe(false);
    expect(failedEvent?.payload.skippedCompensations).toEqual(['s1']);

    const item = await workflowRepository.getPoisonPill(itemId);
    expect(item?.status).toBe('SKIPPED');
  });

  it('re-quarantines with a new pending item if the retry fails again', async () => {
    const compensationType = `rb_repoison_${Date.now()}`;
    sagaCompensator.registerHandler(compensationType, async () => {
      throw new Error('Downstream service still unavailable');
    });

    const definition = poisonDefinition(`pill_repoison_${Date.now()}`, compensationType);
    const { executionId, itemId } = await startPoison(definition);

    const result = await orchestrator.resolvePoisonPill(itemId, 'RESOLVED');
    expect(result.status).toBe('POISON_PILL_BLOCKED');

    const items = await workflowRepository.listPoisonPillItems();
    const original = items.find((candidate) => candidate.id === itemId);
    expect(original?.status).toBe('RESOLVED');

    const pending = items.filter(
      (candidate) =>
        candidate.workflowExecutionId === executionId &&
        candidate.nodeId === 's1' &&
        candidate.status === 'PENDING'
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(itemId);
  });

  it('rejects resolving an item that is no longer pending', async () => {
    let calls = 0;
    const compensationType = `rb_twice_${Date.now()}`;
    sagaCompensator.registerHandler(compensationType, async () => {
      calls++;
    });

    const definition = poisonDefinition(`pill_twice_${Date.now()}`, compensationType);
    const { itemId } = await startPoison(definition);

    await orchestrator.resolvePoisonPill(itemId, 'RESOLVED');
    await expect(orchestrator.resolvePoisonPill(itemId, 'SKIPPED')).rejects.toMatchObject({
      name: 'PoisonPillResolutionError',
      code: 'not_pending',
    });
    expect(calls).toBe(1);
  });
});
