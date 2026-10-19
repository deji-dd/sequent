import { beforeEach, describe, expect, it } from 'bun:test';
import { ramCache } from '../src/cache';
import {
  FencingTokenMismatchError,
  LeaseUnavailableError,
  leaseManager,
} from '../src/core/lease-manager';
import { workflowRepository } from '../src/db/repository';

async function createExecution(prefix: string): Promise<string> {
  const definitionId = `${prefix}_def_${Date.now()}`;
  const executionId = `${prefix}_exec_${Date.now()}`;
  await workflowRepository.saveDefinition({
    id: definitionId,
    name: 'Event contract',
    version: 1,
    nodes: [{ id: 'n1', name: 'N1', type: 'task', activityType: 'n' }],
    edges: [],
  });
  await workflowRepository.createExecution({
    id: executionId,
    workflowDefinitionId: definitionId,
    status: 'RUNNING',
    inputPayload: {},
  });
  return executionId;
}

describe('Event store contract', () => {
  beforeEach(() => {
    ramCache.clear();
  });

  it('allocates sequence IDs in order and supports sequence-range reads', async () => {
    const executionId = await createExecution('evt');
    for (let i = 0; i < 5; i++) {
      await workflowRepository.appendEvent({
        workflowExecutionId: executionId,
        eventType: 'ActivityFailed',
        payload: { i },
        metadata: { timestamp: Date.now() },
      });
    }

    const all = await workflowRepository.getEventLog(executionId);
    expect(all.map((event) => event.sequenceId)).toEqual([1, 2, 3, 4, 5]);

    const upToThree = await workflowRepository.getEventsUpToSequence(executionId, 3);
    expect(upToThree.map((event) => event.sequenceId)).toEqual([1, 2, 3]);
  });

  it('rejects a stale fencing token at commit time', async () => {
    const executionId = await createExecution('fence');
    const lease = await leaseManager.acquireLease(executionId, 'n1', 'worker_a', 5000);

    await expect(
      workflowRepository.appendEvent({
        workflowExecutionId: executionId,
        nodeId: 'n1',
        eventType: 'ActivityStepCompleted',
        payload: { stepKey: 'n1:main_1', result: {} },
        metadata: {
          timestamp: Date.now(),
          fencingToken: lease.fencingToken - 1,
          workerId: 'worker_a',
        },
        enforceFence: true,
      })
    ).rejects.toThrow(FencingTokenMismatchError);

    const accepted = await workflowRepository.appendEvent({
      workflowExecutionId: executionId,
      nodeId: 'n1',
      eventType: 'ActivityStepCompleted',
      payload: { stepKey: 'n1:main_1', result: {} },
      metadata: {
        timestamp: Date.now(),
        fencingToken: lease.fencingToken,
        workerId: 'worker_a',
      },
      enforceFence: true,
    });
    expect(accepted.sequenceId).toBe(1);
  });

  it('refuses to steal a live lease unless forced, then allows it after expiry', async () => {
    const executionId = await createExecution('lease');
    const first = await leaseManager.acquireLease(executionId, 'n1', 'worker_a', 5000);

    await expect(leaseManager.acquireLease(executionId, 'n1', 'worker_b', 5000)).rejects.toThrow(
      LeaseUnavailableError
    );

    const forced = await leaseManager.acquireLease(executionId, 'n1', 'worker_b', 5000, {
      force: true,
    });
    expect(forced.fencingToken).toBeGreaterThan(first.fencingToken);

    await leaseManager.expireLease(executionId, 'n1');
    const afterExpiry = await leaseManager.acquireLease(executionId, 'n1', 'worker_c', 5000);
    expect(afterExpiry.fencingToken).toBeGreaterThan(forced.fencingToken);
  });

  it('tracks pending poison-pill items idempotently and returns resolved items', async () => {
    const executionId = await createExecution('pill');
    const pill = await workflowRepository.addPoisonPill({
      workflowExecutionId: executionId,
      nodeId: 'n1',
      activityType: 'n',
      compensationType: 'rb',
      attempts: 3,
      lastError: 'boom',
      payload: { input: {}, output: {} },
      status: 'PENDING',
    });

    expect(await workflowRepository.hasPendingPoisonPill(executionId, 'n1')).toBe(true);
    expect((await workflowRepository.getPoisonPill(pill.id))?.status).toBe('PENDING');
    const resolved = await workflowRepository.resolvePoisonPill(pill.id, 'RESOLVED');
    expect(resolved?.status).toBe('RESOLVED');
    expect(await workflowRepository.hasPendingPoisonPill(executionId, 'n1')).toBe(false);
    // A second transition is rejected; only PENDING items can be resolved.
    expect(await workflowRepository.resolvePoisonPill(pill.id, 'SKIPPED')).toBeNull();
    expect(await workflowRepository.resolvePoisonPill('missing', 'SKIPPED')).toBeNull();
  });
});
