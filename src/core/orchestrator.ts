import { workflowRepository } from '../db/repository';
import { cancellationHub } from './cancellation-hub';
import { type CompiledDAG, DAGCompiler } from './dag-compiler';
import { DeterministicProxy, isAbortError } from './deterministic-proxy';
import { PoisonPillResolutionError } from './errors';
import { FencingTokenMismatchError, leaseManager, LeaseUnavailableError } from './lease-manager';
import { projectEvents } from './replay';
import { sagaCompensator } from './saga-compensator';
import { telemetryBroadcaster } from './telemetry';
import type {
  ChaosConfig,
  EventAppendInput,
  EventRecord,
  NodeRuntimeState,
  PoisonPillItem,
  TelemetryFrame,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowStatus,
} from './types';

const TERMINAL_STATUSES = new Set<WorkflowStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'POISON_PILL_BLOCKED',
]);

const EXECUTION_RETENTION_MS = Number(process.env.EXECUTION_RETENTION_MS || 60_000);
const MAX_TRACKED_EXECUTIONS = Number(process.env.MAX_TRACKED_EXECUTIONS || 200);

function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

interface ActiveExecution {
  definition: WorkflowDefinition;
  compiledDag: CompiledDAG;
  nodeStates: Record<string, NodeRuntimeState>;
  contextState: Record<string, any>;
  status: WorkflowStatus;
  activeFencingToken: number;
  lastSequenceId: number;
  deterministicProxy: DeterministicProxy;
  zombieSimulations: Set<string>; // nodes marked to simulate zombie pause
  isKilled: boolean; // simulated crash flag
  finalized: boolean;
  finishedAt?: number;
  error?: string;
  skippedCompensations?: string[];
  chaosConfig?: ChaosConfig;
}

type NodeOutcome = 'completed' | 'failed' | 'cancelled' | 'stale';

export class WorkflowExecutionEngine {
  private activeExecutions = new Map<string, ActiveExecution>();
  private telemetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    this.pruneExecutions();

    const executionId =
      customExecutionId ||
      `exec_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
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

    const executionData: ActiveExecution = {
      definition,
      compiledDag,
      nodeStates: initialNodeStates,
      contextState: { ...inputPayload },
      status: 'RUNNING',
      activeFencingToken: 0,
      lastSequenceId: 0,
      deterministicProxy,
      zombieSimulations: new Set<string>(),
      isKilled: false,
      finalized: false,
      chaosConfig,
    };

    if (chaosConfig?.zombieNodeId) {
      executionData.zombieSimulations.add(chaosConfig.zombieNodeId);
    }

    this.activeExecutions.set(executionId, executionData);

    // Step 1: Commit initial WorkflowExecutionStarted record to event_log
    const startEvent = await workflowRepository.appendEvent({
      workflowExecutionId: executionId,
      eventType: 'WorkflowExecutionStarted',
      payload: { inputPayload, nodeCount: definition.nodes.length },
      metadata: {
        timestamp: Date.now(),
        workflowName: definition.name,
      },
    });
    executionData.lastSequenceId = startEvent.sequenceId;

    telemetryBroadcaster.broadcastEvent(startEvent);
    this.broadcastTelemetry(executionId);

    // Kick off asynchronous graph execution loop
    this.runExecutionLoop(executionId).catch((err) => {
      console.error(`[Orchestrator] Error running execution ${executionId}:`, err);
    });

    return { executionId, status: 'RUNNING' };
  }

  private isCurrent(executionId: string, exec: ActiveExecution): boolean {
    return !exec.isKilled && !exec.finalized && this.activeExecutions.get(executionId) === exec;
  }

  /**
   * Core orchestrator execution loop: evaluates ready nodes, dispatches to workers with fencing leases,
   * handles parallel joins, and coordinates transitions.
   */
  private async runExecutionLoop(executionId: string): Promise<void> {
    const exec = this.activeExecutions.get(executionId);
    if (!exec || !this.isCurrent(executionId, exec) || exec.status !== 'RUNNING') return;

    const completedNodes = new Set<string>();
    for (const [nodeId, state] of Object.entries(exec.nodeStates)) {
      if (state.status === 'COMPLETED') {
        completedNodes.add(nodeId);
      }
    }

    // Check terminal condition: all nodes completed?
    if (completedNodes.size === exec.definition.nodes.length) {
      await this.finalizeCompleted(executionId, exec);
      return;
    }

    // Find all nodes that are IDLE and whose parent dependencies are all COMPLETED
    const readyNodes: WorkflowNode[] = [];
    for (const node of exec.definition.nodes) {
      const state = exec.nodeStates[node.id];
      if (state?.status === 'IDLE') {
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

  private async finalizeCompleted(executionId: string, exec: ActiveExecution): Promise<void> {
    if (exec.status !== 'RUNNING' || exec.finalized || exec.isKilled) return;

    // Flip the status synchronously so a second caller cannot finalize twice.
    exec.status = 'COMPLETED';
    exec.finalized = true;
    exec.finishedAt = Date.now();

    await workflowRepository.updateExecution(executionId, {
      status: 'COMPLETED',
      contextState: exec.contextState,
      nodeStates: exec.nodeStates,
      completedAt: new Date(),
    });

    const compEvt = await this.safeAppend({
      workflowExecutionId: executionId,
      eventType: 'WorkflowCompleted',
      payload: { contextState: exec.contextState },
      metadata: { timestamp: Date.now() },
    });
    if (compEvt) exec.lastSequenceId = compEvt.sequenceId;

    this.broadcastTelemetry(executionId);
    cancellationHub.cleanup(executionId);
    this.clearTelemetryTimer(executionId);
  }

  /**
   * Step 2 & 3: Distributed Task Dispatch, Worker Fencing Lease, Deterministic Execution & Split-Brain Rejection
   */
  private async dispatchNode(executionId: string, node: WorkflowNode): Promise<void> {
    const exec = this.activeExecutions.get(executionId);
    if (!exec || !this.isCurrent(executionId, exec) || exec.status !== 'RUNNING') return;

    const state = exec.nodeStates[node.id];
    if (state?.status !== 'IDLE') return;

    const workerId = `worker_${Math.random().toString(36).slice(2, 6)}`;
    state.status = 'SCHEDULED';
    state.workerId = workerId;
    state.attempts++;
    // Snapshot the inputs available at dispatch time for compensation/poison-pill payloads.
    state.input = { ...exec.contextState };

    const controller = cancellationHub.registerController(executionId, node.id);
    const signal = controller.signal;

    const leaseTtl = node.timeoutMs || 4000;

    try {
      // Step 2: Acquire distributed lease with strictly monotonic fencing token
      const lease = await leaseManager.acquireLease(executionId, node.id, workerId, leaseTtl);
      if (!this.isCurrent(executionId, exec) || signal.aborted) {
        await leaseManager.releaseLease(executionId, node.id, workerId, lease.fencingToken);
        return;
      }

      exec.activeFencingToken = Math.max(exec.activeFencingToken, lease.fencingToken);
      state.fencingToken = lease.fencingToken;

      const leaseEvt = await workflowRepository.appendEvent({
        workflowExecutionId: executionId,
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
      exec.lastSequenceId = leaseEvt.sequenceId;
      telemetryBroadcaster.broadcastEvent(leaseEvt);

      state.status = 'RUNNING';
      state.startedAt = Date.now();
      this.scheduleTelemetry(executionId);

      // Check if user pre-programmed a simulated coordinator crash on this node
      if (exec.chaosConfig?.crashNodeId === node.id) {
        exec.chaosConfig.crashNodeId = undefined; // Avoid crash loop on recovery replay!
        console.warn(
          `[Orchestrator] Chaos injection: Auto-simulating coordinator crash on node '${node.name}' (${node.id})...`
        );
        this.simulateCrash(executionId);
        setTimeout(async () => {
          console.log(`[Sequent Simulation] Initiating zero-loss recovery for ${executionId}...`);
          await this.recoverWorkflow(executionId);
        }, 700);
        return;
      }

      const task = this.executeActivity(
        executionId,
        exec,
        node,
        state,
        lease,
        workerId,
        controller
      );
      cancellationHub.trackRunningTask(executionId, node.id, task);
      const outcome = await task;

      if (
        outcome === 'completed' &&
        this.isCurrent(executionId, exec) &&
        exec.status === 'RUNNING'
      ) {
        await this.runExecutionLoop(executionId);
      }
    } catch (err: any) {
      if (!this.isCurrent(executionId, exec)) return;

      // Setup failures (lease acquisition, lease event, etc.) must not leave a node
      // stuck in SCHEDULED forever.
      const message =
        err instanceof LeaseUnavailableError
          ? err.message
          : err?.message || 'Failed to dispatch node';

      state.status = 'FAILED';
      state.error = message;
      this.metrics.failedNodes++;

      await this.safeAppend({
        workflowExecutionId: executionId,
        nodeId: node.id,
        eventType: 'ActivityFailed',
        payload: { error: message },
        metadata: { timestamp: Date.now(), error: message, workerId },
      });
      this.scheduleTelemetry(executionId);
      await this.handleWorkflowFailure(executionId, node.id, message);
    }
  }

  /**
   * Executes one activity inside the deterministic sandbox, maintaining the lease
   * heartbeat and enforcing the fence before every durable checkpoint.
   */
  private async executeActivity(
    executionId: string,
    exec: ActiveExecution,
    node: WorkflowNode,
    state: NodeRuntimeState,
    lease: { fencingToken: number; ttlMs: number },
    workerId: string,
    controller: AbortController
  ): Promise<NodeOutcome> {
    const signal = controller.signal;
    const leaseTtl = lease.ttlMs;
    const fencingToken = lease.fencingToken;

    let heartbeatActive = true;
    let heartbeatInFlight = false;
    const heartbeatInterval = setInterval(
      async () => {
        if (!heartbeatActive || !this.isCurrent(executionId, exec)) {
          clearInterval(heartbeatInterval);
          return;
        }
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        try {
          const ok = await leaseManager.heartbeat(
            executionId,
            node.id,
            workerId,
            fencingToken,
            leaseTtl
          );
          if (!ok && heartbeatActive) {
            // The lease was stolen or expired: abort the activity immediately instead
            // of letting a zombie keep running until its final fence check.
            heartbeatActive = false;
            clearInterval(heartbeatInterval);
            await leaseManager.expireLease(executionId, node.id);
            await this.safeAppend({
              workflowExecutionId: executionId,
              nodeId: node.id,
              eventType: 'WorkerLeaseExpired',
              payload: {
                expiredWorkerId: workerId,
                staleToken: fencingToken,
                reason: 'Heartbeat rejected: lease expired or was superseded',
              },
              metadata: { timestamp: Date.now(), fencingToken, workerId },
            });
            this.scheduleTelemetry(executionId);
            controller.abort(new Error('Worker lease expired'));
          }
        } catch (err) {
          console.error(`[Orchestrator] Heartbeat error on ${executionId}/${node.id}:`, err);
        } finally {
          heartbeatInFlight = false;
        }
      },
      Math.max(250, Math.floor(leaseTtl / 3))
    );

    // Stops the heartbeat and waits for any in-flight heartbeat to finish. This
    // prevents a late heartbeat from re-creating a lease that was just released.
    let heartbeatStopped = false;
    const stopHeartbeat = async () => {
      if (heartbeatStopped) return;
      heartbeatStopped = true;
      heartbeatActive = false;
      clearInterval(heartbeatInterval);
      const deadline = Date.now() + 1000;
      while (heartbeatInFlight && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    try {
      // Check if user flagged a simulated zombie pause on this worker
      if (exec.zombieSimulations.has(node.id)) {
        console.warn(
          `[Orchestrator] Simulating GC pause / network partition on worker ${workerId} for node ${node.id}...`
        );
        await stopHeartbeat();

        // Force another worker to steal the lease with a strictly higher fencing token!
        const newWorkerId = `worker_failover_${Math.random().toString(36).slice(2, 6)}`;
        const supersedingLease = await leaseManager.acquireLease(
          executionId,
          node.id,
          newWorkerId,
          leaseTtl,
          { force: true }
        );
        exec.activeFencingToken = Math.max(exec.activeFencingToken, supersedingLease.fencingToken);

        const stealEvt = await workflowRepository.appendEvent({
          workflowExecutionId: executionId,
          nodeId: node.id,
          eventType: 'WorkerLeaseExpired',
          payload: {
            expiredWorkerId: workerId,
            stolenByWorkerId: newWorkerId,
            staleToken: fencingToken,
            newFencingToken: supersedingLease.fencingToken,
          },
          metadata: {
            timestamp: Date.now(),
            fencingToken: supersedingLease.fencingToken,
          },
        });
        exec.lastSequenceId = stealEvt.sequenceId;
        telemetryBroadcaster.broadcastEvent(stealEvt);
        this.scheduleTelemetry(executionId);

        // Simulate long sleep
        await new Promise((res) => setTimeout(res, 2500));
        signal.throwIfAborted();
        exec.zombieSimulations.delete(node.id);
      }

      // Step 3: Deterministic Execution Sandbox & Side-Effect Interception
      const context = exec.deterministicProxy.createContext(executionId, node.id, {
        recordStepEvent: async (stepKey, result, meta) => {
          const evt = await workflowRepository.appendEvent({
            workflowExecutionId: executionId,
            nodeId: node.id,
            eventType: 'ActivityStepCompleted',
            payload: { stepKey, result },
            metadata: {
              stepKey,
              timestamp: meta.timestamp,
              fencingToken,
              workerId,
              randomCounterEnd: meta.randomCounterEnd,
            },
            enforceFence: true,
          });
          exec.lastSequenceId = evt.sequenceId;
          telemetryBroadcaster.broadcastEvent(evt);
          return evt;
        },
        verifyFence: () =>
          leaseManager.verifyFencingToken(executionId, node.id, workerId, fencingToken),
        signal,
      });

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
        if (node.metadata?.failureProbability && Math.random() < node.metadata.failureProbability) {
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

      signal.throwIfAborted();
      if (!this.isCurrent(executionId, exec)) return 'stale';
      if (exec.status !== 'RUNNING') {
        // A sibling failure moved the workflow into FAILING/COMPENSATING while this
        // activity was finishing. Do not append a late completion.
        if (state.status === 'RUNNING' || state.status === 'SCHEDULED') {
          state.status = 'CANCELLED';
        }
        return 'cancelled';
      }

      // Final verification: also covers cached replay, where step() returns without
      // running the per-step fence hook.
      await leaseManager.verifyFencingToken(executionId, node.id, workerId, fencingToken);

      // Success! Commit ActivityCompleted (with atomic fence validation) BEFORE releasing
      // the lease so a stale worker cannot slip a write in.
      const compEvt = await workflowRepository.appendEvent({
        workflowExecutionId: executionId,
        nodeId: node.id,
        eventType: 'ActivityCompleted',
        payload: { result },
        metadata: {
          fencingToken,
          workerId,
          timestamp: Date.now(),
        },
        enforceFence: true,
      });
      exec.lastSequenceId = compEvt.sequenceId;

      // Stop heartbeats and drain any in-flight one before releasing the lease.
      await stopHeartbeat();
      await leaseManager.releaseLease(executionId, node.id, workerId, fencingToken);

      if (!this.isCurrent(executionId, exec)) {
        // The event was committed while this run was still current; recovery will replay it.
        return 'stale';
      }

      state.status = 'COMPLETED';
      state.completedAt = Date.now();
      state.output = result;
      exec.contextState[node.id] = result;
      this.metrics.completedNodes++;

      telemetryBroadcaster.broadcastEvent(compEvt);
      this.scheduleTelemetry(executionId);
      return 'completed';
    } catch (err: any) {
      if (!this.isCurrent(executionId, exec)) return 'stale';

      // Split-brain write rejection
      if (err instanceof FencingTokenMismatchError) {
        this.metrics.zombieWritesBlocked++;
        state.status = 'FAILED';
        state.error = err.message;

        const rejectEvt = await this.safeAppend({
          workflowExecutionId: executionId,
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
            workerId,
          },
        });
        if (rejectEvt) exec.lastSequenceId = rejectEvt.sequenceId;
        this.scheduleTelemetry(executionId);

        await this.handleWorkflowFailure(executionId, node.id, err.message);
        return 'failed';
      }

      // AbortSignal cancellation (sibling failure, crash, lease expiry)
      if (
        isAbortError(err) ||
        signal.aborted ||
        cancellationHub.isCancelled(executionId, node.id)
      ) {
        if (state.status !== 'CANCELLED' && state.status !== 'COMPLETED') {
          state.status = 'CANCELLED';
          const cancelEvt = await this.safeAppend({
            workflowExecutionId: executionId,
            nodeId: node.id,
            eventType: 'ActivityCancelled',
            payload: { reason: 'Sibling branch failed or worker lease expired; task cancelled.' },
            metadata: { timestamp: Date.now(), workerId },
          });
          if (cancelEvt) exec.lastSequenceId = cancelEvt.sequenceId;
          this.scheduleTelemetry(executionId);
        }
        return 'cancelled';
      }

      // A sibling failure already moved the workflow out of RUNNING. Drop this result
      // rather than starting a second failure/compensation cycle.
      if (exec.status !== 'RUNNING') {
        if (state.status === 'RUNNING' || state.status === 'SCHEDULED') {
          state.status = 'CANCELLED';
        }
        return 'cancelled';
      }

      // Standard task execution failure
      state.status = 'FAILED';
      state.error = err?.message || String(err);
      this.metrics.failedNodes++;

      const failEvt = await this.safeAppend({
        workflowExecutionId: executionId,
        nodeId: node.id,
        eventType: 'ActivityFailed',
        payload: { error: state.error },
        metadata: { timestamp: Date.now(), error: state.error, workerId },
      });
      if (failEvt) exec.lastSequenceId = failEvt.sequenceId;
      this.scheduleTelemetry(executionId);

      // Step 4 & 5: Parallel branch failure & active saga rollback!
      await this.handleWorkflowFailure(executionId, node.id, state.error || 'Unknown task failure');
      return 'failed';
    } finally {
      heartbeatActive = false;
      clearInterval(heartbeatInterval);
    }
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
    if (!exec || !this.isCurrent(executionId, exec)) return;
    if (exec.status === 'FAILING' || exec.status === 'COMPENSATING') return;
    if (isTerminal(exec.status)) return;

    // Step 4: Shift state to FAILING
    exec.status = 'FAILING';
    exec.error = errorMessage;
    await workflowRepository.updateExecution(executionId, {
      status: 'FAILING',
      error: errorMessage,
      nodeStates: exec.nodeStates,
      contextState: exec.contextState,
    });

    const failingEvt = await this.safeAppend({
      workflowExecutionId: executionId,
      eventType: 'WorkflowFailing',
      payload: { failedNodeId, error: errorMessage },
      metadata: { timestamp: Date.now() },
    });
    if (failingEvt) exec.lastSequenceId = failingEvt.sequenceId;
    this.scheduleTelemetry(executionId);

    // Active AbortSignal broadcast: cancel all running sibling tasks and wait for them
    // to actually settle (abortable sleeps reject immediately).
    const cancellationOutcome = await cancellationHub.cancelSiblingsAndWait(
      executionId,
      failedNodeId,
      4000
    );

    // Update cancelled nodes state
    for (const nodeId of cancellationOutcome.cancelledNodes) {
      const nodeState = exec.nodeStates[nodeId];
      if (nodeState?.status === 'RUNNING' || nodeState?.status === 'SCHEDULED') {
        nodeState.status = 'CANCELLED';
      }
    }

    // Step 5: Shift state to COMPENSATING and roll back
    await this.runCompensation(executionId, exec, failedNodeId, errorMessage);
  }

  /**
   * Runs (or resumes) reverse-topological saga compensation and finalizes the workflow.
   */
  private async runCompensation(
    executionId: string,
    exec: ActiveExecution,
    failedNodeId: string,
    errorMessage: string,
    options: { resume?: boolean } = {}
  ): Promise<void> {
    if (!this.isCurrent(executionId, exec) || exec.finalized) return;

    exec.status = 'COMPENSATING';
    await workflowRepository.updateExecution(executionId, {
      status: 'COMPENSATING',
      nodeStates: exec.nodeStates,
      contextState: exec.contextState,
    });

    if (!options.resume) {
      const compEvt = await this.safeAppend({
        workflowExecutionId: executionId,
        eventType: 'WorkflowCompensating',
        payload: { reason: `Triggered by failure in node ${failedNodeId}` },
        metadata: { timestamp: Date.now() },
      });
      if (compEvt) exec.lastSequenceId = compEvt.sequenceId;
    }
    this.scheduleTelemetry(executionId);

    // Execute reverse topological compensation
    let outcome: Awaited<ReturnType<typeof sagaCompensator.compensateWorkflow>>;
    try {
      outcome = await sagaCompensator.compensateWorkflow(
        executionId,
        exec.compiledDag,
        exec.nodeStates,
        async (eventType, nodeId, payload, metadata) => {
          if (!this.isCurrent(executionId, exec)) return;
          const evt = await this.safeAppend({
            workflowExecutionId: executionId,
            nodeId,
            eventType,
            payload,
            metadata: { timestamp: Date.now(), ...(metadata || {}) },
          });
          if (evt) {
            exec.lastSequenceId = evt.sequenceId;
          }
          this.scheduleTelemetry(executionId);
        },
        exec.chaosConfig?.poisonPillNodeId
      );
    } catch (err: any) {
      // An unexpected compensator/storage failure must still finalize the run.
      const message = `Compensation crashed unexpectedly: ${err?.message || String(err)}`;
      exec.status = 'FAILED';
      exec.error = message;
      exec.finalized = true;
      exec.finishedAt = Date.now();
      await workflowRepository
        .updateExecution(executionId, {
          status: 'FAILED',
          error: message,
          nodeStates: exec.nodeStates,
          contextState: exec.contextState,
          completedAt: new Date(),
        })
        .catch(() => undefined);
      const finalEvt = await this.safeAppend({
        workflowExecutionId: executionId,
        eventType: 'WorkflowFailed',
        payload: { error: message, allCompensationsSucceeded: false },
        metadata: { timestamp: Date.now() },
      });
      if (finalEvt) exec.lastSequenceId = finalEvt.sequenceId;
      telemetryBroadcaster.broadcastStatusChange(executionId, 'FAILED');
      this.broadcastTelemetry(executionId);
      this.clearTelemetryTimer(executionId);
      cancellationHub.cleanup(executionId);
      return;
    }

    if (!this.isCurrent(executionId, exec)) return;

    exec.finalized = true;
    exec.finishedAt = Date.now();

    if (outcome.poisonPillBlocked) {
      exec.status = 'POISON_PILL_BLOCKED';
      exec.error = outcome.error;
      await workflowRepository.updateExecution(executionId, {
        status: 'POISON_PILL_BLOCKED',
        error: outcome.error,
        nodeStates: exec.nodeStates,
        contextState: exec.contextState,
      });
      telemetryBroadcaster.broadcastStatusChange(executionId, 'POISON_PILL_BLOCKED');
    } else {
      exec.status = 'FAILED';
      await workflowRepository.updateExecution(executionId, {
        status: 'FAILED',
        error: errorMessage,
        nodeStates: exec.nodeStates,
        contextState: exec.contextState,
        completedAt: new Date(),
      });

      const finalEvt = await this.safeAppend({
        workflowExecutionId: executionId,
        eventType: 'WorkflowFailed',
        payload: {
          error: errorMessage,
          allCompensationsSucceeded:
            outcome.success && !(exec.skippedCompensations && exec.skippedCompensations.length > 0),
          skippedCompensations:
            exec.skippedCompensations && exec.skippedCompensations.length > 0
              ? exec.skippedCompensations
              : undefined,
        },
        metadata: { timestamp: Date.now() },
      });
      if (finalEvt) exec.lastSequenceId = finalEvt.sequenceId;
      telemetryBroadcaster.broadcastStatusChange(executionId, 'FAILED');
    }

    this.broadcastTelemetry(executionId);
    this.clearTelemetryTimer(executionId);
    cancellationHub.cleanup(executionId);
  }

  /**
   * Step 6: Zero-Loss Crash Recovery via Event Replay
   */
  async recoverWorkflow(executionId: string): Promise<boolean> {
    const exRecord = await workflowRepository.getExecution(executionId);
    if (!exRecord) return false;
    if (isTerminal(exRecord.status as WorkflowStatus)) return false;

    const def = await workflowRepository.getDefinition(exRecord.workflowDefinitionId);
    if (!def) return false;

    const compiledDag = DAGCompiler.compile(def);
    const historicalEvents = await workflowRepository.getEventLog(executionId);

    // Instantiate deterministic proxy populated with historical step events
    const deterministicProxy = new DeterministicProxy(historicalEvents);

    // Reconstruct node states and context state via the shared projector
    const projection = projectEvents(
      historicalEvents,
      def,
      exRecord.inputPayload || {},
      'recovery'
    );

    // Expire any leases left behind by the previous process so they cannot block
    // re-dispatch now that acquireLease refuses live leases.
    const leasedNodeIds = new Set(
      historicalEvents
        .filter((evt) => evt.eventType === 'WorkerLeaseAcquired' && evt.nodeId)
        .map((evt) => evt.nodeId as string)
    );
    for (const nodeId of leasedNodeIds) {
      await leaseManager.expireLease(executionId, nodeId);
    }

    const isRollback = exRecord.status === 'FAILING' || exRecord.status === 'COMPENSATING';
    // A crash can land between an ActivityFailed append and the FAILING status write.
    // Treat any projected failure as a rollback so we never resume forward dispatch.
    const shouldRollback = isRollback || Boolean(projection.failedNodeId);

    if (!shouldRollback) {
      // A cancelled sibling from an interrupted forward run must be re-dispatched.
      for (const state of Object.values(projection.nodeStates)) {
        if (state.status === 'CANCELLED') {
          state.status = 'IDLE';
        }
      }
    }

    // Restore pacing, but never re-inject one-shot chaos faults on replay.
    const recoveredChaos: ChaosConfig | undefined = exRecord.chaosConfig
      ? { stepDelayMs: exRecord.chaosConfig.stepDelayMs }
      : undefined;

    const recoveredExec: ActiveExecution = {
      definition: def,
      compiledDag,
      nodeStates: projection.nodeStates,
      contextState: projection.contextState,
      status: shouldRollback ? 'COMPENSATING' : 'RUNNING',
      activeFencingToken: exRecord.activeFencingToken || 0,
      lastSequenceId: historicalEvents.length
        ? historicalEvents[historicalEvents.length - 1].sequenceId
        : 0,
      deterministicProxy,
      zombieSimulations: new Set<string>(),
      isKilled: false,
      finalized: false,
      error: projection.error,
      chaosConfig: recoveredChaos,
    };

    this.metrics.crashesRecovered++;
    this.activeExecutions.set(executionId, recoveredExec);

    // Commit WorkflowRecoveredFromCrash
    const recoveryEvt = await this.safeAppend({
      workflowExecutionId: executionId,
      eventType: 'WorkflowRecoveredFromCrash',
      payload: {
        replayedEventsCount: historicalEvents.length,
        resumedAtNodeCount: Object.values(projection.nodeStates).filter(
          (state) => state.status === 'COMPLETED'
        ).length,
        resumeMode: shouldRollback ? 'compensation' : 'forward',
      },
      metadata: { timestamp: Date.now() },
    });
    if (recoveryEvt) {
      recoveredExec.lastSequenceId = recoveryEvt.sequenceId;
    }

    await workflowRepository.updateExecution(executionId, {
      status: recoveredExec.status,
      nodeStates: recoveredExec.nodeStates,
      contextState: recoveredExec.contextState,
    });

    this.broadcastTelemetry(executionId);

    if (shouldRollback) {
      const failedNodeId = projection.failedNodeId || 'unknown';
      const alreadyCompensating = historicalEvents.some(
        (evt) => evt.eventType === 'WorkflowCompensating'
      );
      await this.runCompensation(
        executionId,
        recoveredExec,
        failedNodeId,
        projection.error || 'Recovered from crash during rollback',
        { resume: alreadyCompensating }
      );
      return true;
    }

    // Resume execution loop at the exact uncommitted node!
    this.runExecutionLoop(executionId).catch((err) => {
      console.error(`[Orchestrator] Error resuming recovered execution ${executionId}:`, err);
    });

    return true;
  }

  /**
   * Resolves a quarantined compensation:
   * - RESOLVED: retry the poisoned compensation, then continue the remaining rollback.
   * - SKIPPED: record the operator skip, then continue compensating the remaining nodes.
   *
   * Both actions resume from the durable event log, so they work even after a restart.
   */
  async resolvePoisonPill(
    itemId: string,
    action: 'RESOLVED' | 'SKIPPED'
  ): Promise<{ executionId: string; status: WorkflowStatus; item: PoisonPillItem }> {
    const item = await workflowRepository.getPoisonPill(itemId);
    if (!item) {
      throw new PoisonPillResolutionError(
        'not_found',
        `Poison pill item '${itemId}' was not found.`
      );
    }
    if (item.status !== 'PENDING') {
      throw new PoisonPillResolutionError(
        'not_pending',
        `Poison pill item '${itemId}' is already ${item.status}.`
      );
    }

    const exRecord = await workflowRepository.getExecution(item.workflowExecutionId);
    if (!exRecord) {
      throw new PoisonPillResolutionError(
        'execution_not_found',
        `Execution '${item.workflowExecutionId}' was not found.`
      );
    }
    if (exRecord.status !== 'POISON_PILL_BLOCKED') {
      throw new PoisonPillResolutionError(
        'execution_not_blocked',
        `Execution '${item.workflowExecutionId}' is ${exRecord.status}, not POISON_PILL_BLOCKED.`
      );
    }

    const definition = await workflowRepository.getDefinition(exRecord.workflowDefinitionId);
    if (!definition) {
      throw new PoisonPillResolutionError(
        'definition_not_found',
        `Workflow definition '${exRecord.workflowDefinitionId}' was not found.`
      );
    }

    const compiledDag = DAGCompiler.compile(definition);
    const events = await workflowRepository.getEventLog(item.workflowExecutionId);
    const projection = projectEvents(events, definition, exRecord.inputPayload || {}, 'recovery');

    // Merge the persisted input snapshots so compensation handlers receive the
    // same inputs they would have had before the restart.
    const persistedStates = (exRecord.nodeStates || {}) as Record<string, NodeRuntimeState>;
    for (const [nodeId, state] of Object.entries(projection.nodeStates)) {
      const persisted = persistedStates[nodeId];
      if (persisted?.input !== undefined) state.input = persisted.input;
      if (persisted?.attempts !== undefined) state.attempts = persisted.attempts;
    }

    const alreadyCompensated = projection.compensatedNodes.includes(item.nodeId);
    const poisonedNode = projection.nodeStates[item.nodeId];
    if (poisonedNode) {
      if (alreadyCompensated) {
        poisonedNode.status = 'COMPENSATED';
        poisonedNode.isCompensated = true;
      } else if (action === 'RESOLVED') {
        // Make the node eligible for one more compensation attempt.
        poisonedNode.status = 'COMPLETED';
        poisonedNode.error = undefined;
      } else {
        // Skipping means we knowingly leave this side effect in place.
        poisonedNode.status = 'COMPENSATED';
        poisonedNode.isCompensated = false;
        poisonedNode.error = 'Compensation skipped by operator';
      }
    }

    const resumed: ActiveExecution = {
      definition,
      compiledDag,
      nodeStates: projection.nodeStates,
      contextState: projection.contextState,
      status: 'COMPENSATING',
      activeFencingToken: exRecord.activeFencingToken || 0,
      lastSequenceId: events.length > 0 ? events[events.length - 1].sequenceId : 0,
      deterministicProxy: new DeterministicProxy(events),
      zombieSimulations: new Set<string>(),
      isKilled: false,
      finalized: false,
      chaosConfig: exRecord.chaosConfig
        ? { stepDelayMs: exRecord.chaosConfig.stepDelayMs }
        : undefined,
      skippedCompensations: action === 'SKIPPED' && !alreadyCompensated ? [item.nodeId] : undefined,
    };

    // Atomically claim the pending item before touching workflow state. If another
    // request already resolved it, this returns null and we abort with a 409.
    const resolvedItem = await workflowRepository.resolvePoisonPill(itemId, action);
    if (!resolvedItem) {
      throw new PoisonPillResolutionError(
        'not_pending',
        `Poison pill item '${itemId}' is no longer pending.`
      );
    }

    this.activeExecutions.set(item.workflowExecutionId, resumed);
    cancellationHub.cleanup(item.workflowExecutionId);

    // Flip the persisted status to COMPENSATING before the audit/compensation work.
    // If the process dies during resolution, boot recovery will resume the rollback
    // instead of leaving a blocked workflow with no pending item.
    await workflowRepository.updateExecution(item.workflowExecutionId, {
      status: 'COMPENSATING',
      nodeStates: resumed.nodeStates,
      contextState: resumed.contextState,
    });

    await this.safeAppend({
      workflowExecutionId: item.workflowExecutionId,
      nodeId: item.nodeId,
      eventType: action === 'RESOLVED' ? 'PoisonPillResolved' : 'PoisonPillSkipped',
      payload: {
        itemId,
        nodeId: item.nodeId,
        compensationType: item.compensationType,
        action,
        previousAttempts: item.attempts,
      },
      metadata: { timestamp: Date.now() },
    });

    if (action === 'SKIPPED') {
      await this.safeAppend({
        workflowExecutionId: item.workflowExecutionId,
        nodeId: item.nodeId,
        eventType: 'CompensationSkipped',
        payload: {
          itemId,
          compensationType: item.compensationType,
          reason: 'Compensation skipped by operator',
        },
        metadata: { timestamp: Date.now() },
      });
    }

    this.broadcastTelemetry(item.workflowExecutionId);

    const failureError = projection.error || exRecord.error || item.lastError;
    await this.runCompensation(item.workflowExecutionId, resumed, item.nodeId, failureError, {
      resume: true,
    });

    return {
      executionId: item.workflowExecutionId,
      status: resumed.status,
      item: resolvedItem,
    };
  }

  /**
   * Simulates an abrupt orchestrator crash
   */
  simulateCrash(executionId: string): boolean {
    const exec = this.activeExecutions.get(executionId);
    if (!exec) return false;
    exec.isKilled = true;
    // Abort in-flight work so old tasks cannot commit after recovery starts.
    cancellationHub.abortExecution(executionId, 'Simulated coordinator crash');
    this.activeExecutions.delete(executionId);
    this.clearTelemetryTimer(executionId);
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
      sequenceId: exec.lastSequenceId,
      activeFencingToken: exec.activeFencingToken,
      nodeStates: exec.nodeStates,
      contextState: exec.contextState,
      activeLeases: leaseManager.getActiveLeases(),
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

  /**
   * Coalesces high-frequency telemetry updates into one frame per short window.
   */
  private scheduleTelemetry(executionId: string): void {
    if (this.telemetryTimers.has(executionId)) return;
    const timer = setTimeout(() => {
      this.telemetryTimers.delete(executionId);
      this.broadcastTelemetry(executionId);
    }, 50);
    (timer as any).unref?.();
    this.telemetryTimers.set(executionId, timer);
  }

  private clearTelemetryTimer(executionId: string): void {
    const timer = this.telemetryTimers.get(executionId);
    if (timer) {
      clearTimeout(timer);
      this.telemetryTimers.delete(executionId);
    }
  }

  /**
   * Best-effort append used for terminal/control events: a storage failure must
   * not crash the execution loop. Successful records are broadcast to the live UI.
   */
  private async safeAppend(event: EventAppendInput): Promise<EventRecord | null> {
    try {
      const record = await workflowRepository.appendEvent(event);
      telemetryBroadcaster.broadcastEvent(record);
      return record;
    } catch (err) {
      console.error(
        `[Orchestrator] Failed to append ${event.eventType} for ${event.workflowExecutionId}:`,
        err
      );
      return null;
    }
  }

  /**
   * Retires terminal executions after a retention window and caps the tracked map.
   */
  private pruneExecutions(): void {
    const now = Date.now();
    for (const [id, exec] of this.activeExecutions.entries()) {
      if (exec.finishedAt && now - exec.finishedAt > EXECUTION_RETENTION_MS) {
        this.activeExecutions.delete(id);
        this.clearTelemetryTimer(id);
      }
    }

    if (this.activeExecutions.size <= MAX_TRACKED_EXECUTIONS) return;

    const finished = [...this.activeExecutions.entries()]
      .filter(([, exec]) => exec.finishedAt)
      .sort((a, b) => (a[1].finishedAt || 0) - (b[1].finishedAt || 0));

    while (this.activeExecutions.size > MAX_TRACKED_EXECUTIONS && finished.length > 0) {
      const [id] = finished.shift()!;
      this.activeExecutions.delete(id);
      this.clearTelemetryTimer(id);
    }
  }

  getActiveExecution(executionId: string) {
    this.pruneExecutions();
    return this.activeExecutions.get(executionId) || null;
  }

  getMetrics() {
    return this.metrics;
  }

  /**
   * Graceful shutdown: abort in-flight work and clear timers. Executions are
   * recovered from the event log on the next boot.
   */
  shutdown(): void {
    for (const [executionId, exec] of this.activeExecutions.entries()) {
      exec.isKilled = true;
      cancellationHub.abortExecution(executionId, 'Server shutting down');
      this.clearTelemetryTimer(executionId);
    }
    this.activeExecutions.clear();
  }

  /** @internal Test helper: clears in-memory state without touching the repository. */
  resetForTests(): void {
    for (const executionId of this.activeExecutions.keys()) {
      this.clearTelemetryTimer(executionId);
    }
    this.activeExecutions.clear();
    this.metrics = {
      totalNodes: 0,
      completedNodes: 0,
      failedNodes: 0,
      compensatedNodes: 0,
      zombieWritesBlocked: 0,
      crashesRecovered: 0,
    };
  }
}

export const orchestrator = new WorkflowExecutionEngine();
