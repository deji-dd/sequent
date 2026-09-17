import { workflowRepository } from '../db/repository';
import type { CompiledDAG } from './dag-compiler';
import type { NodeRuntimeState, WorkflowNode } from './types';

export type CompensationHandler = (
  node: WorkflowNode,
  input: any,
  output: any,
  attempt: number
) => Promise<any>;

export class SagaCompensator {
  private handlers = new Map<string, CompensationHandler>();

  registerHandler(compensationType: string, handler: CompensationHandler) {
    this.handlers.set(compensationType, handler);
  }

  getHandler(compensationType: string): CompensationHandler | undefined {
    return this.handlers.get(compensationType);
  }

  /**
   * Executes reverse topological saga compensation for all completed nodes.
   */
  async compensateWorkflow(
    executionId: string,
    compiledDag: CompiledDAG,
    nodeStates: Record<string, NodeRuntimeState>,
    onCompensationEvent: (
      eventType:
        | 'CompensationScheduled'
        | 'CompensationStarted'
        | 'CompensationCompleted'
        | 'CompensationFailed'
        | 'WorkflowPoisonPillBlocked',
      nodeId: string,
      payload: any,
      metadata?: any
    ) => Promise<void>,
    forcePoisonPillNodeId?: string
  ): Promise<{
    success: boolean;
    poisonPillBlocked: boolean;
    failedNodeId?: string;
    error?: string;
  }> {
    // Reverse topological order: LIFO causal rollback
    const reverseOrder = compiledDag.reverseTopologicalOrder;

    for (const nodeId of reverseOrder) {
      const node = compiledDag.nodeMap.get(nodeId);
      const state = nodeStates[nodeId];

      // Only compensate nodes that successfully completed and have a defined compensation handler
      if (!node || !state || state.status !== 'COMPLETED' || !node.compensationType) {
        continue;
      }

      await onCompensationEvent('CompensationScheduled', nodeId, {
        compensationType: node.compensationType,
        originalOutput: state.output,
      });

      const handler = this.handlers.get(node.compensationType);
      const retryPolicy = node.retryPolicy || {
        maxRetries: 3,
        initialBackoffMs: 200,
        backoffMultiplier: 2,
      };

      let attempt = 0;
      let compensated = false;
      let lastError = 'Unknown error';

      while (attempt <= retryPolicy.maxRetries) {
        attempt++;
        await onCompensationEvent('CompensationStarted', nodeId, {
          attempt,
          compensationType: node.compensationType,
        });

        try {
          if (forcePoisonPillNodeId && forcePoisonPillNodeId === nodeId) {
            throw new Error(
              `External Gateway 502 Bad Gateway (Attempt ${attempt}): Permanent failure on downstream compensation '${node.compensationType}'`
            );
          }

          if (handler) {
            await handler(node, state.input, state.output, attempt);
          } else {
            // Default simulated compensation
            if (
              node.metadata?.compensationFailureProbability &&
              Math.random() < node.metadata.compensationFailureProbability
            ) {
              throw new Error(
                `Downstream compensation error during ${node.compensationType} on node ${nodeId}`
              );
            }
          }

          state.isCompensated = true;
          state.status = 'COMPENSATED';
          compensated = true;

          await onCompensationEvent('CompensationCompleted', nodeId, {
            attempt,
            compensationType: node.compensationType,
            status: 'COMPENSATED',
          });

          break;
        } catch (err: any) {
          lastError = err?.message || String(err);
          await onCompensationEvent(
            'CompensationFailed',
            nodeId,
            { attempt, error: lastError },
            { error: lastError, attempt }
          );

          if (attempt <= retryPolicy.maxRetries) {
            // Exponential backoff with jitter
            const backoff =
              retryPolicy.initialBackoffMs *
              retryPolicy.backoffMultiplier ** (attempt - 1) *
              (0.8 + Math.random() * 0.4);
            await new Promise((res) => setTimeout(res, backoff));
          }
        }
      }

      // If max retries exhausted: Enter POISON_PILL_BLOCKED
      if (!compensated) {
        state.status = 'POISON_PILL_BLOCKED';

        await workflowRepository.addPoisonPill({
          workflowExecutionId: executionId,
          nodeId,
          activityType: node.activityType,
          compensationType: node.compensationType,
          attempts: attempt,
          lastError,
          payload: {
            input: state.input,
            output: state.output,
          },
          status: 'PENDING',
        });

        await onCompensationEvent('WorkflowPoisonPillBlocked', nodeId, {
          nodeId,
          compensationType: node.compensationType,
          attempts: attempt,
          error: lastError,
        });

        return {
          success: false,
          poisonPillBlocked: true,
          failedNodeId: nodeId,
          error: `Poison pill quarantine: max retries (${retryPolicy.maxRetries}) exhausted compensating '${node.name}' (${node.compensationType}): ${lastError}`,
        };
      }
    }

    return {
      success: true,
      poisonPillBlocked: false,
    };
  }
}

export const sagaCompensator = new SagaCompensator();
