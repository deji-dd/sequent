import { workflowRepository } from '../db/repository';
import { cancellationHub } from './cancellation-hub';
import { type CompiledDAG, DAGCompiler } from './dag-compiler';
import { DeterministicProxy } from './deterministic-proxy';
import { FencingTokenMismatchError, leaseManager } from './lease-manager';
import { sagaCompensator } from './saga-compensator';
import { telemetryBroadcaster } from './telemetry';
import type {
  ChaosConfig,
  NodeRuntimeState,
  TelemetryFrame,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowStatus,
} from './types';

export class WorkflowExecutionEngine {
  private activeExecutions = new Map<
    string,
    {
      definition: WorkflowDefinition;
      compiledDag: CompiledDAG;
      nodeStates: Record<string, NodeRuntimeState>;
      contextState: Record<string, any>;
      status: WorkflowStatus;
      activeFencingToken: number;
      deterministicProxy: DeterministicProxy;
      zombieSimulations: Set<string>; // nodes marked to simulate zombie pause
      isKilled: boolean; // simulated crash flag
      chaosConfig?: ChaosConfig;
    }
  >();

  private metrics = {
    totalNodes: 0,
    completedNodes: 0,
    failedNodes: 0,
    compensatedNodes: 0,
    zombieWritesBlocked: 0,
    crashesRecovered: 0,
  };

  /**
   * Initializes and begins executing a workflow DAG.
   */
  async startWorkflow(
    definition: WorkflowDefinition,
    inputPayload: Record<string, any> = {},
    customExecutionId?: string,
    chaosConfig?: ChaosConfig
  ): Promise<{ executionId: string; status: WorkflowStatus }> {
    const executionId =
      customExecutionId || `exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const compiledDag = DAGCompiler.compile(definition);

    // Persist definition and initial execution record
    await workflowRepository.saveDefinition(definition);
    await workflowRepository.createExecution({
      id: executionId,
      workflowDefinitionId: definition.id,
      status: 'RUNNING',
      inputPayload,
      chaosConfig,
    });

    const initialNodeStates: Record<string, NodeRuntimeState> = {};
    for (const node of definition.nodes) {
      initialNodeStates[node.id] = {
        status: 'IDLE',
        attempts: 0,
      };
    }

    const deterministicProxy = new DeterministicProxy([]);

    const executionData = {
      definition,
      compiledDag,
      nodeStates: initialNodeStates,
      contextState: { ...inputPayload },
      status: 'RUNNING' as WorkflowStatus,
      activeFencingToken: 0,
      deterministicProxy,
      zombieSimulations: new Set<string>(),
      isKilled: false,
      chaosConfig,
    };

    if (chaosConfig?.zombieNodeId) {
      executionData.zombieSimulations.add(chaosConfig.zombieNodeId);
    }

    this.activeExecutions.set(executionId, executionData);

    // Step 1: Commit initial WorkflowExecutionStarted record to event_log
    const startEvent = await workflowRepository.appendEvent({
      workflowExecutionId: executionId,
      sequenceId: 1,
      eventType: 'WorkflowExecutionStarted',
      payload: { inputPayload, nodeCount: definition.nodes.length },
      metadata: {
        timestamp: Date.now(),
        workflowName: definition.name,
      },
    });

    telemetryBroadcaster.broadcastEvent(startEvent);
    this.broadcastTelemetry(executionId);

    // Kick off asynchronous graph execution loop
    this.runExecutionLoop(executionId).catch((err) => {
      console.error(`[Orchestrator] Error running execution ${executionId}:`, err);
    });

    return { executionId, status: 'RUNNING' };
  }

  /**
   * Core orchestrator execution loop: evaluates ready nodes, dispatches to workers with fencing leases,
   * handles parallel joins, and coordinates transitions.
   */
  private async runExecutionLoop(executionId: string): Promise<void> {
    const exec = this.activeExecutions.get(executionId);
    if (!exec || exec.isKilled) return;

    const completedNodes = new Set<string>();
    for (const [nodeId, state] of Object.entries(exec.nodeStates)) {
      if (state.status === 'COMPLETED') {
        completedNodes.add(nodeId);
      }
    }

    // Check terminal condition: all nodes completed?
    if (completedNodes.size === exec.definition.nodes.length) {
      exec.status = 'COMPLETED';
      await workflowRepository.updateExecution(executionId, {
        status: 'COMPLETED',
        contextState: exec.contextState,
        nodeStates: exec.nodeStates,
        completedAt: new Date(),
      });

      const compEvt = await workflowRepository.appendEvent({
        workflowExecutionId: executionId,
        sequenceId: 0,
        eventType: 'WorkflowCompleted',
        payload: { contextState: exec.contextState },
        metadata: { timestamp: Date.now() },
      });

      telemetryBroadcaster.broadcastEvent(compEvt);
      this.broadcastTelemetry(executionId);
      cancellationHub.cleanup(executionId);
      return;
    }

    // Find all nodes that are IDLE and whose parent dependencies are all COMPLETED
    const readyNodes: WorkflowNode[] = [];
    for (const node of exec.definition.nodes) {
      const state = exec.nodeStates[node.id];
      if (state.status === 'IDLE') {
        const isReady = DAGCompiler.isNodeReady(
          node.id,
          exec.compiledDag.dependencies,
          completedNodes
        );
        if (isReady) {
          readyNodes.push(node);
        }
      }
    }

    if (readyNodes.length === 0) {
      // Nothing ready right now (either parallel tasks are running or blocked)
      return;
    }

    // Dispatch all ready nodes in parallel
    const dispatchPromises = readyNodes.map((node) => this.dispatchNode(executionId, node));
    await Promise.allSettled(dispatchPromises);
  }

  /**
   * Step 2 & 3: Distributed Task Dispatch, Worker Fencing Lease, Deterministic Execution & Split-Brain Rejection
   */
  private async dispatchNode(executionId: string, node: WorkflowNode): Promise<void> {
    const exec = this.activeExecutions.get(executionId);
    if (!exec || exec.isKilled || exec.status !== 'RUNNING') return;

    const workerId = `worker_${Math.random().toString(36).slice(2, 6)}`;
    const state = exec.nodeStates[node.id];
    state.status = 'SCHEDULED';
    state.workerId = workerId;
    state.attempts++;

    // Step 2: Acquire distributed lease with strictly monotonic fencing token
    const leaseTtl = node.timeoutMs || 4000;
    const lease = await leaseManager.acquireLease(executionId, node.id, workerId, leaseTtl);
    exec.activeFencingToken = lease.fencingToken;
    state.fencingToken = lease.fencingToken;

    const leaseEvt = await workflowRepository.appendEvent({
      workflowExecutionId: executionId,
      sequenceId: 0,
      nodeId: node.id,
      eventType: 'WorkerLeaseAcquired',
      payload: {
        workerId,
        fencingToken: lease.fencingToken,
        ttlMs: leaseTtl,
      },
      metadata: {
        timestamp: Date.now(),
        fencingToken: lease.fencingToken,
        workerId,
      },
    });
    telemetryBroadcaster.broadcastEvent(leaseEvt);

    state.status = 'RUNNING';
    state.startedAt = Date.now();
    this.broadcastTelemetry(executionId);

    // Heartbeat ticker
    let heartbeatActive = true;
    const heartbeatInterval = setInterval(
      async () => {
        if (!heartbeatActive || exec.isKilled) {
          clearInterval(heartbeatInterval);
          return;
        }
        const ok = await leaseManager.heartbeat(
          executionId,
          node.id,
          workerId,
          lease.fencingToken,
          leaseTtl
        );
        if (!ok) {
          heartbeatActive = false;
          clearInterval(heartbeatInterval);
        }
      },
      Math.max(500, Math.floor(leaseTtl / 3))
    );

    // Check if user pre-programmed a simulated coordinator crash on this node
    if (exec.chaosConfig?.crashNodeId === node.id) {
      exec.chaosConfig.crashNodeId = undefined; // Avoid crash loop on recovery replay!
      console.warn(
        `[Orchestrator] Chaos injection: Auto-simulating coordinator crash on node '${node.name}' (${node.id})...`
      );
      heartbeatActive = false;
      clearInterval(heartbeatInterval);
      this.simulateCrash(executionId);
      setTimeout(async () => {
        console.log(`[Sequent Simulation] Initiating zero-loss recovery for ${executionId}...`);
        await this.recoverWorkflow(executionId);
      }, 700);
      return;
    }

    // Prepare task execution wrapped in CancellationHub
    const taskExecutionPromise = (async () => {
      try {
        // Step 3: Deterministic Execution Sandbox & Side-Effect Interception
        const context = exec.deterministicProxy.createContext(
          executionId,
          node.id,
          async (stepKey, result) => {
            return workflowRepository.appendEvent({
              workflowExecutionId: executionId,
              sequenceId: 0,
              nodeId: node.id,
              eventType: 'ActivityCompleted',
              payload: { stepKey, result },
              metadata: {
                stepKey,
                fencingToken: lease.fencingToken,
                workerId,
                timestamp: Date.now(),
              },
            });
          }
        );

        // Check if user flagged a simulated zombie pause on this worker
        if (exec.zombieSimulations.has(node.id)) {
          console.warn(
            `[Orchestrator] Simulating GC pause / network partition on worker ${workerId} for node ${node.id}...`
          );
          // Stop heartbeating and wait for lease to expire completely
          heartbeatActive = false;
          clearInterval(heartbeatInterval);

          // Force another worker to steal the lease with a strictly higher fencing token!
          const newWorkerId = `worker_failover_${Math.random().toString(36).slice(2, 6)}`;
          const supersedingLease = await leaseManager.acquireLease(
            executionId,
            node.id,
            newWorkerId,
            leaseTtl
          );
          exec.activeFencingToken = supersedingLease.fencingToken;

          const stealEvt = await workflowRepository.appendEvent({
            workflowExecutionId: executionId,
            sequenceId: 0,
            nodeId: node.id,
            eventType: 'WorkerLeaseExpired',
            payload: {
              expiredWorkerId: workerId,
              stolenByWorkerId: newWorkerId,
              staleToken: lease.fencingToken,
              newFencingToken: supersedingLease.fencingToken,
            },
            metadata: {
              timestamp: Date.now(),
              fencingToken: supersedingLease.fencingToken,
            },
          });
          telemetryBroadcaster.broadcastEvent(stealEvt);

          // Simulate long sleep
          await new Promise((res) => setTimeout(res, 2500));
          exec.zombieSimulations.delete(node.id);
        }

        // Execute task inside deterministic sandbox step
        const result = await context.step('main', async () => {
          // Check for simulated latency or user-configured pacing
          const baseLatency = node.metadata?.simulatedLatencyMs ?? 400;
          const configuredDelay = exec.chaosConfig?.stepDelayMs;
          const latency = configuredDelay ? Math.max(baseLatency, configuredDelay) : baseLatency;
          if (latency > 0) {
            await context.sleep(latency);
          }

          // Check for pre-programmed chaos fault injection: forced failure
          if (exec.chaosConfig?.failNodeId === node.id) {
            throw new Error(
              `Fault Injection: Forced task failure on node '${node.name}' (${node.id})`
            );
          }

          // Check for simulated failure
          if (
            node.metadata?.failureProbability &&
            Math.random() < node.metadata.failureProbability
          ) {
            throw new Error(`Simulated task failure on node '${node.name}' (${node.id})`);
          }

          return {
            processedAt: context.now(),
            nodeId: node.id,
            activityType: node.activityType,
            status: 'SUCCESS',
            randomSeed: context.random(),
          };
        });

        // Step 2 verification: Verify that worker's fencing token is STILL valid
        await leaseManager.verifyFencingToken(executionId, node.id, workerId, lease.fencingToken);

        // Success! Release lease and commit ActivityCompleted
        heartbeatActive = false;
        clearInterval(heartbeatInterval);
        await leaseManager.releaseLease(executionId, node.id, workerId, lease.fencingToken);

        state.status = 'COMPLETED';
        state.completedAt = Date.now();
        state.output = result;
        this.metrics.completedNodes++;

        exec.contextState[node.id] = result;

        const compEvt = await workflowRepository.appendEvent({
          workflowExecutionId: executionId,
          sequenceId: 0,
          nodeId: node.id,
          eventType: 'ActivityCompleted',
          payload: { result },
          metadata: {
            fencingToken: lease.fencingToken,
            workerId,
            timestamp: Date.now(),
          },
        });
        telemetryBroadcaster.broadcastEvent(compEvt);
        this.broadcastTelemetry(executionId);

        // Continue workflow execution loop to process subsequent ready nodes
        await this.runExecutionLoop(executionId);
      } catch (err: any) {
        heartbeatActive = false;
        clearInterval(heartbeatInterval);

        // Check if error was a FencingTokenMismatch (split-brain write rejection!)
        if (err instanceof FencingTokenMismatchError) {
          this.metrics.zombieWritesBlocked++;
          state.status = 'FAILED';
          state.error = err.message;

          const rejectEvt = await workflowRepository.appendEvent({
            workflowExecutionId: executionId,
            sequenceId: 0,
            nodeId: node.id,
            eventType: 'WorkerFencingRejected',
            payload: {
              workerId,
              claimedToken: err.actualToken,
              activeHighestToken: err.expectedToken,
              reason: 'Split-brain write prevented: worker token lower than active lease token.',
            },
            metadata: {
              timestamp: Date.now(),
              fencingToken: err.actualToken,
              error: err.message,
            },
          });
          telemetryBroadcaster.broadcastEvent(rejectEvt);
          this.broadcastTelemetry(executionId);

          // Handle failure transition
          await this.handleWorkflowFailure(executionId, node.id, err.message);
          return;
        }

        // Check if aborted via AbortSignal (sibling task cancellation)
        if (cancellationHub.isCancelled(executionId, node.id)) {
          state.status = 'CANCELLED';
          const cancelEvt = await workflowRepository.appendEvent({
            workflowExecutionId: executionId,
            sequenceId: 0,
            nodeId: node.id,
            eventType: 'ActivityCancelled',
            payload: { reason: 'Sibling branch failed; active task cancelled.' },
            metadata: { timestamp: Date.now(), workerId },
          });
          telemetryBroadcaster.broadcastEvent(cancelEvt);
          this.broadcastTelemetry(executionId);
          return;
        }

        // Standard task execution failure
        state.status = 'FAILED';
        state.error = err?.message || String(err);
        this.metrics.failedNodes++;

        const failEvt = await workflowRepository.appendEvent({
          workflowExecutionId: executionId,
          sequenceId: 0,
          nodeId: node.id,
          eventType: 'ActivityFailed',
          payload: { error: state.error },
          metadata: { timestamp: Date.now(), error: state.error, workerId },
        });
        telemetryBroadcaster.broadcastEvent(failEvt);
        this.broadcastTelemetry(executionId);

        // Step 4 & 5: Parallel branch failure & active saga rollback!
        await this.handleWorkflowFailure(
          executionId,
          node.id,
          state.error || 'Unknown task failure'
        );
      }
    })();

    cancellationHub.registerRunningTask(executionId, node.id, taskExecutionPromise);
  }

  /**
   * Step 4 & Step 5: Parallel Branch Failure, Active Sibling Cancellation & Fault-Tolerant Saga Compensation
   */
  private async handleWorkflowFailure(
    executionId: string,
    failedNodeId: string,
    errorMessage: string
  ): Promise<void> {
    const exec = this.activeExecutions.get(executionId);
    if (!exec || exec.status === 'FAILING' || exec.status === 'COMPENSATING') return;

    // Step 4: Shift state to FAILING
    exec.status = 'FAILING';
    await workflowRepository.updateExecution(executionId, {
      status: 'FAILING',
      error: errorMessage,
    });

    const failingEvt = await workflowRepository.appendEvent({
      workflowExecutionId: executionId,
      sequenceId: 0,
      eventType: 'WorkflowFailing',
      payload: { failedNodeId, error: errorMessage },
      metadata: { timestamp: Date.now() },
    });
    telemetryBroadcaster.broadcastEvent(failingEvt);
    this.broadcastTelemetry(executionId);

    // Active AbortSignal broadcast: cancel all running sibling tasks and wait for them to pause/settle
    const cancellationOutcome = await cancellationHub.cancelSiblingsAndWait(
      executionId,
      failedNodeId,
      4000
    );

    // Update cancelled nodes state
    for (const nodeId of cancellationOutcome.cancelledNodes) {
      if (exec.nodeStates[nodeId]?.status === 'RUNNING') {
        exec.nodeStates[nodeId].status = 'CANCELLED';
      }
    }

    // Step 5: Shift state to COMPENSATING
    exec.status = 'COMPENSATING';
    await workflowRepository.updateExecution(executionId, {
      status: 'COMPENSATING',
    });

    const compEvt = await workflowRepository.appendEvent({
      workflowExecutionId: executionId,
      sequenceId: 0,
      eventType: 'WorkflowCompensating',
      payload: { reason: `Triggered by failure in node ${failedNodeId}` },
      metadata: { timestamp: Date.now() },
    });
    telemetryBroadcaster.broadcastEvent(compEvt);
    this.broadcastTelemetry(executionId);

    // Execute reverse topological compensation
    const outcome = await sagaCompensator.compensateWorkflow(
      executionId,
      exec.compiledDag,
      exec.nodeStates,
      async (eventType, nodeId, payload, metadata) => {
        const evt = await workflowRepository.appendEvent({
          workflowExecutionId: executionId,
          sequenceId: 0,
          nodeId,
          eventType,
          payload,
          metadata: { timestamp: Date.now(), ...(metadata || {}) },
        });
        telemetryBroadcaster.broadcastEvent(evt);
        this.broadcastTelemetry(executionId);
      },
      exec.chaosConfig?.poisonPillNodeId
    );

    if (outcome.poisonPillBlocked) {
      exec.status = 'POISON_PILL_BLOCKED';
      await workflowRepository.updateExecution(executionId, {
        status: 'POISON_PILL_BLOCKED',
        error: outcome.error,
      });
      telemetryBroadcaster.broadcastStatusChange(executionId, 'POISON_PILL_BLOCKED');
    } else {
      exec.status = 'FAILED';
      await workflowRepository.updateExecution(executionId, {
        status: 'FAILED',
        error: errorMessage,
        completedAt: new Date(),
      });

      const finalEvt = await workflowRepository.appendEvent({
        workflowExecutionId: executionId,
        sequenceId: 0,
        eventType: 'WorkflowFailed',
        payload: { error: errorMessage, allCompensationsSucceeded: outcome.success },
        metadata: { timestamp: Date.now() },
      });
      telemetryBroadcaster.broadcastEvent(finalEvt);
      telemetryBroadcaster.broadcastStatusChange(executionId, 'FAILED');
    }

    this.broadcastTelemetry(executionId);
    cancellationHub.cleanup(executionId);
  }

  /**
   * Step 6: Zero-Loss Crash Recovery via Event Replay
   */
  async recoverWorkflow(executionId: string): Promise<boolean> {
    const exRecord = await workflowRepository.getExecution(executionId);
    if (!exRecord) return false;

    const def = await workflowRepository.getDefinition(exRecord.workflowDefinitionId);
    if (!def) return false;

    const compiledDag = DAGCompiler.compile(def);
    const historicalEvents = await workflowRepository.getEventLog(executionId);

    // Instantiate deterministic proxy populated with historical event log
    const deterministicProxy = new DeterministicProxy(historicalEvents);

    // Reconstruct node states and context state by replaying events
    const nodeStates: Record<string, NodeRuntimeState> = {};
    for (const node of def.nodes) {
      nodeStates[node.id] = { status: 'IDLE', attempts: 0 };
    }

    const contextState: Record<string, any> = { ...exRecord.inputPayload };

    for (const evt of historicalEvents) {
      if (evt.nodeId && nodeStates[evt.nodeId]) {
        if (evt.eventType === 'ActivityCompleted') {
          nodeStates[evt.nodeId].status = 'COMPLETED';
          nodeStates[evt.nodeId].output = evt.payload?.result;
          contextState[evt.nodeId] = evt.payload?.result;
        } else if (evt.eventType === 'ActivityFailed') {
          nodeStates[evt.nodeId].status = 'FAILED';
          nodeStates[evt.nodeId].error = evt.payload?.error;
        } else if (evt.eventType === 'ActivityCancelled') {
          nodeStates[evt.nodeId].status = 'CANCELLED';
        } else if (evt.eventType === 'CompensationCompleted') {
          nodeStates[evt.nodeId].status = 'COMPENSATED';
        }
      }
    }

    this.metrics.crashesRecovered++;

    const recoveredExec = {
      definition: def,
      compiledDag,
      nodeStates,
      contextState,
      status: 'RUNNING' as WorkflowStatus,
      activeFencingToken: exRecord.activeFencingToken || 0,
      deterministicProxy,
      zombieSimulations: new Set<string>(),
      isKilled: false,
    };

    this.activeExecutions.set(executionId, recoveredExec);

    // Commit WorkflowRecoveredFromCrash
    const recoveryEvt = await workflowRepository.appendEvent({
      workflowExecutionId: executionId,
      sequenceId: 0,
      eventType: 'WorkflowRecoveredFromCrash',
      payload: {
        replayedEventsCount: historicalEvents.length,
        resumedAtNodeCount: Object.values(nodeStates).filter((s) => s.status === 'COMPLETED')
          .length,
      },
      metadata: { timestamp: Date.now() },
    });
    telemetryBroadcaster.broadcastEvent(recoveryEvt);

    await workflowRepository.updateExecution(executionId, {
      status: 'RUNNING',
    });

    this.broadcastTelemetry(executionId);

    // Resume execution loop at the exact uncommitted node!
    this.runExecutionLoop(executionId).catch((err) => {
      console.error(`[Orchestrator] Error resuming recovered execution ${executionId}:`, err);
    });

    return true;
  }

  /**
   * Simulates an abrupt orchestrator crash
   */
  simulateCrash(executionId: string): boolean {
    const exec = this.activeExecutions.get(executionId);
    if (!exec) return false;
    exec.isKilled = true;
    this.activeExecutions.delete(executionId);
    return true;
  }

  /**
   * Triggers a zombie worker GC pause simulation on a specific node
   */
  triggerZombieDelay(executionId: string, nodeId: string): boolean {
    const exec = this.activeExecutions.get(executionId);
    if (!exec) return false;
    exec.zombieSimulations.add(nodeId);
    return true;
  }

  /**
   * Broadcasts a complete TelemetryFrame for the current execution
   */
  broadcastTelemetry(executionId: string): void {
    const exec = this.activeExecutions.get(executionId);
    if (!exec) return;

    const frame: TelemetryFrame = {
      workflowExecutionId: executionId,
      workflowDefinitionId: exec.definition.id,
      status: exec.status,
      sequenceId: 0,
      activeFencingToken: exec.activeFencingToken,
      nodeStates: exec.nodeStates,
      contextState: exec.contextState,
      activeLeases: leaseManager.getActiveLeases(),
      activeTokens: [],
      recentEvents: [],
      metrics: {
        totalNodes: exec.definition.nodes.length,
        completedNodes: Object.values(exec.nodeStates).filter((n) => n.status === 'COMPLETED')
          .length,
        failedNodes: Object.values(exec.nodeStates).filter((n) => n.status === 'FAILED').length,
        compensatedNodes: Object.values(exec.nodeStates).filter((n) => n.status === 'COMPENSATED')
          .length,
        zombieWritesBlocked: this.metrics.zombieWritesBlocked,
        crashesRecovered: this.metrics.crashesRecovered,
      },
      timestamp: Date.now(),
    };

    telemetryBroadcaster.broadcast(frame);
  }

  getActiveExecution(executionId: string) {
    return this.activeExecutions.get(executionId) || null;
  }

  getMetrics() {
    return this.metrics;
  }
}

export const orchestrator = new WorkflowExecutionEngine();
