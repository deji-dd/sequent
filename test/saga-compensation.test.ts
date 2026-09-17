import { describe, expect, it } from 'bun:test';
import { DAGCompiler } from '../src/core/dag-compiler';
import { sagaCompensator } from '../src/core/saga-compensator';
import type { NodeRuntimeState, WorkflowDefinition } from '../src/core/types';

describe('Fault-Tolerant Saga Compensation & Poison Pill Quarantine', () => {
  it('should traverse completed nodes in reverse topological order and dispatch compensations', async () => {
    const executedRollbacks: string[] = [];

    sagaCompensator.registerHandler('rollback_step1', async () => {
      executedRollbacks.push('rollback_step1');
    });
    sagaCompensator.registerHandler('rollback_step2', async () => {
      executedRollbacks.push('rollback_step2');
    });

    const def: WorkflowDefinition = {
      id: 'saga_test',
      name: 'Saga Test',
      version: 1,
      nodes: [
        {
          id: 'step_1',
          name: 'Step 1',
          type: 'task',
          activityType: 's1',
          compensationType: 'rollback_step1',
        },
        {
          id: 'step_2',
          name: 'Step 2',
          type: 'task',
          activityType: 's2',
          compensationType: 'rollback_step2',
        },
      ],
      edges: [{ id: 'e1', source: 'step_1', target: 'step_2' }],
    };

    const compiled = DAGCompiler.compile(def);
    const nodeStates: Record<string, NodeRuntimeState> = {
      step_1: { status: 'COMPLETED', attempts: 1 },
      step_2: { status: 'COMPLETED', attempts: 1 },
    };

    const outcome = await sagaCompensator.compensateWorkflow(
      'exec_saga_1',
      compiled,
      nodeStates,
      async () => {}
    );

    expect(outcome.success).toBe(true);
    // Reverse topological order: step_2 compensated first, then step_1!
    expect(executedRollbacks).toEqual(['rollback_step2', 'rollback_step1']);
  });

  it('should quarantine into POISON_PILL_BLOCKED when max compensation retries exhaust', async () => {
    let attemptsCount = 0;
    sagaCompensator.registerHandler('failing_compensation', async () => {
      attemptsCount++;
      throw new Error('Downstream service down');
    });

    const def: WorkflowDefinition = {
      id: 'poison_test',
      name: 'Poison Test',
      version: 1,
      nodes: [
        {
          id: 'step_bad',
          name: 'Bad Step',
          type: 'task',
          activityType: 'bad',
          compensationType: 'failing_compensation',
          retryPolicy: { maxRetries: 2, initialBackoffMs: 10, backoffMultiplier: 1.5 },
        },
      ],
      edges: [],
    };

    const compiled = DAGCompiler.compile(def);
    const nodeStates: Record<string, NodeRuntimeState> = {
      step_bad: { status: 'COMPLETED', attempts: 1 },
    };

    const outcome = await sagaCompensator.compensateWorkflow(
      'exec_poison_1',
      compiled,
      nodeStates,
      async () => {}
    );

    expect(outcome.success).toBe(false);
    expect(outcome.poisonPillBlocked).toBe(true);
    expect(nodeStates.step_bad.status).toBe('POISON_PILL_BLOCKED');
    expect(attemptsCount).toBe(3); // 1 initial + 2 retries
  });
});
