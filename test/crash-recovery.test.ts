import { describe, expect, it } from 'bun:test';
import { orchestrator } from '../src/core/orchestrator';
import type { WorkflowDefinition } from '../src/core/types';
import { workflowRepository } from '../src/db/repository';

describe('Zero-Loss Crash Recovery via Event Replay', () => {
  it('should recover mid-execution state and resume without losing completed nodes', async () => {
    const def: WorkflowDefinition = {
      id: 'crash_test_def',
      name: 'Crash Recovery Test',
      version: 1,
      nodes: [
        {
          id: 'step_1',
          name: 'Step 1',
          type: 'task',
          activityType: 's1',
          metadata: { simulatedLatencyMs: 50 },
        },
        {
          id: 'step_2',
          name: 'Step 2',
          type: 'task',
          activityType: 's2',
          metadata: { simulatedLatencyMs: 50 },
        },
      ],
      edges: [{ id: 'e1', source: 'step_1', target: 'step_2' }],
    };

    const execId = `exec_crash_${Date.now()}`;
    await workflowRepository.saveDefinition(def);
    await workflowRepository.createExecution({
      id: execId,
      workflowDefinitionId: def.id,
      status: 'RUNNING',
      inputPayload: { orderId: 999 },
    });

    // Commit Step 1 completion event simulating that Step 1 completed before crash occurred
    await workflowRepository.appendEvent({
      workflowExecutionId: execId,
      sequenceId: 1,
      eventType: 'WorkflowExecutionStarted',
      payload: { inputPayload: { orderId: 999 } },
      metadata: { timestamp: Date.now() },
    });

    await workflowRepository.appendEvent({
      workflowExecutionId: execId,
      sequenceId: 2,
      nodeId: 'step_1',
      eventType: 'ActivityCompleted',
      payload: { result: { processed: true, value: 'historical_result_42' } },
      metadata: { timestamp: Date.now(), stepKey: 'step_1:main_1' },
    });

    // Simulate crash recovery invocation
    const recovered = await orchestrator.recoverWorkflow(execId);
    expect(recovered).toBe(true);

    const active = orchestrator.getActiveExecution(execId);
    expect(active).not.toBeNull();
    // Step 1 state should be restored as COMPLETED with the historical output
    expect(active?.nodeStates.step_1.status).toBe('COMPLETED');
    expect(active?.nodeStates.step_1.output).toEqual({
      processed: true,
      value: 'historical_result_42',
    });

    // Wait for resumed Step 2 to finish live
    await new Promise((res) => setTimeout(res, 400));
    const updated = await workflowRepository.getExecution(execId);
    expect(updated?.status).toBe('COMPLETED');
  });
});
