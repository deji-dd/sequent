import { beforeEach, describe, expect, it } from 'bun:test';

import { ramCache } from '../src/cache';
import { orchestrator } from '../src/core/orchestrator';
import type { WorkflowDefinition } from '../src/core/types';
import { workflowRepository } from '../src/db/repository';
import { waitFor } from './support/helpers';

function parallelDefinition(id: string): WorkflowDefinition {
  return {
    id,
    name: 'Parallel regression',
    version: 1,
    nodes: [
      { id: 'a', name: 'A', type: 'task', activityType: 'a', metadata: { simulatedLatencyMs: 20 } },
      {
        id: 'b',
        name: 'B',
        type: 'task',
        activityType: 'b',
        compensationType: 'rb',
        metadata: { simulatedLatencyMs: 20 },
      },
      { id: 'c', name: 'C', type: 'task', activityType: 'c', metadata: { simulatedLatencyMs: 20 } },
      { id: 'j', name: 'J', type: 'join', activityType: 'j', metadata: { simulatedLatencyMs: 20 } },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'a', target: 'c' },
      { id: 'e3', source: 'b', target: 'j' },
      { id: 'e4', source: 'c', target: 'j' },
    ],
  };
}

async function waitForTerminal(executionId: string): Promise<string> {
  let status = '';
  await waitFor(async () => {
    const execution = await workflowRepository.getExecution(executionId);
    status = execution?.status || '';
    return ['COMPLETED', 'FAILED', 'POISON_PILL_BLOCKED', 'CANCELLED'].includes(status);
  }, 10000);
  return status;
}

describe('Execution lifecycle regressions', () => {
  beforeEach(() => {
    ramCache.clear();
    orchestrator.resetForTests();
  });

  it('emits exactly one completion per node with unique, contiguous sequences', async () => {
    const definition = parallelDefinition(`reg_parallel_${Date.now()}`);
    const { executionId } = await orchestrator.startWorkflow(definition, {});

    expect(await waitForTerminal(executionId)).toBe('COMPLETED');

    const events = await workflowRepository.getEventLog(executionId);
    const sequences = events.map((event) => event.sequenceId);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));

    const completions = events.filter((event) => event.eventType === 'ActivityCompleted');
    expect(completions).toHaveLength(definition.nodes.length);
    for (const node of definition.nodes) {
      expect(completions.filter((event) => event.nodeId === node.id)).toHaveLength(1);
    }
  });

  it('rejects a zombie worker without persisting a step or completion event', async () => {
    const definition: WorkflowDefinition = {
      id: `reg_zombie_${Date.now()}`,
      name: 'Zombie regression',
      version: 1,
      nodes: [
        {
          id: 'only',
          name: 'Only',
          type: 'task',
          activityType: 'only',
          metadata: { simulatedLatencyMs: 100 },
        },
      ],
      edges: [],
    };

    const { executionId } = await orchestrator.startWorkflow(definition, {}, undefined, {
      zombieNodeId: 'only',
    });

    expect(await waitForTerminal(executionId)).toBe('FAILED');

    const events = await workflowRepository.getEventLog(executionId);
    expect(events.some((event) => event.eventType === 'WorkerFencingRejected')).toBe(true);
    expect(events.some((event) => event.eventType === 'ActivityStepCompleted')).toBe(false);
    expect(events.some((event) => event.eventType === 'ActivityCompleted')).toBe(false);
    expect(orchestrator.getMetrics().zombieWritesBlocked).toBeGreaterThanOrEqual(1);
  });

  it('recovers a simulated crash without stale-worker commits or spurious failure', async () => {
    const definition: WorkflowDefinition = {
      id: `reg_crash_${Date.now()}`,
      name: 'Crash regression',
      version: 1,
      nodes: [
        {
          id: 'a',
          name: 'A',
          type: 'task',
          activityType: 'a',
          metadata: { simulatedLatencyMs: 400 },
        },
        {
          id: 'b',
          name: 'B',
          type: 'task',
          activityType: 'b',
          metadata: { simulatedLatencyMs: 400 },
        },
        {
          id: 'j',
          name: 'J',
          type: 'join',
          activityType: 'j',
          metadata: { simulatedLatencyMs: 20 },
        },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'j' },
        { id: 'e2', source: 'b', target: 'j' },
      ],
    };

    const { executionId } = await orchestrator.startWorkflow(definition, {}, undefined, {
      crashNodeId: 'a',
    });

    expect(await waitForTerminal(executionId)).toBe('COMPLETED');

    const events = await workflowRepository.getEventLog(executionId);
    expect(events.some((event) => event.eventType === 'WorkflowFailing')).toBe(false);
    expect(events.some((event) => event.eventType === 'WorkerFencingRejected')).toBe(false);
    expect(events.some((event) => event.eventType === 'WorkflowRecoveredFromCrash')).toBe(true);

    const completions = events.filter((event) => event.eventType === 'ActivityCompleted');
    for (const node of definition.nodes) {
      expect(completions.filter((event) => event.nodeId === node.id)).toHaveLength(1);
    }
  });

  it('runs the failure/compensation transitions exactly once and cancels siblings', async () => {
    const definition: WorkflowDefinition = {
      id: `reg_late_${Date.now()}`,
      name: 'Late failure regression',
      version: 1,
      nodes: [
        {
          id: 'a',
          name: 'A',
          type: 'task',
          activityType: 'a',
          compensationType: 'rb_a',
          metadata: { simulatedLatencyMs: 50 },
        },
        {
          id: 'b',
          name: 'B',
          type: 'task',
          activityType: 'b',
          compensationType: 'rb_b',
          metadata: { simulatedLatencyMs: 1200, failureProbability: 1 },
        },
      ],
      edges: [],
    };

    const { executionId } = await orchestrator.startWorkflow(definition, {}, undefined, {
      failNodeId: 'a',
    });

    expect(await waitForTerminal(executionId)).toBe('FAILED');

    const events = await workflowRepository.getEventLog(executionId);
    const count = (type: string) => events.filter((event) => event.eventType === type).length;
    expect(count('WorkflowFailing')).toBe(1);
    expect(count('WorkflowCompensating')).toBe(1);
    expect(count('WorkflowFailed')).toBe(1);
    expect(
      events.some((event) => event.eventType === 'ActivityCancelled' && event.nodeId === 'b')
    ).toBe(true);
  });
});
