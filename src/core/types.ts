export type WorkflowStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'FAILING'
  | 'COMPENSATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'POISON_PILL_BLOCKED';

export type NodeStatus =
  | 'IDLE'
  | 'SCHEDULED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPENSATING'
  | 'COMPENSATED'
  | 'POISON_PILL_BLOCKED';

export type NodeType = 'task' | 'parallel_fork' | 'join' | 'conditional';

export interface RetryPolicy {
  maxRetries: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
}

export interface WorkflowNode {
  id: string;
  name: string;
  type: NodeType;
  activityType: string;
  compensationType?: string;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
  metadata?: {
    description?: string;
    icon?: string;
    simulatedLatencyMs?: number;
    failureProbability?: number;
    compensationFailureProbability?: number;
    [key: string]: any;
  };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  condition?: string; // Optional expression evaluated against source output
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface ChaosConfig {
  stepDelayMs?: number;
  zombieNodeId?: string;
  crashNodeId?: string;
  failNodeId?: string;
  poisonPillNodeId?: string;
}

export type EventType =
  | 'WorkflowExecutionStarted'
  | 'ActivityScheduled'
  | 'ActivityStarted'
  | 'ActivityCompleted'
  | 'ActivityFailed'
  | 'ActivityCancelled'
  | 'CompensationScheduled'
  | 'CompensationStarted'
  | 'CompensationCompleted'
  | 'CompensationFailed'
  | 'WorkflowFailing'
  | 'WorkflowCompensating'
  | 'WorkflowCompleted'
  | 'WorkflowFailed'
  | 'WorkflowCancelled'
  | 'WorkflowPoisonPillBlocked'
  | 'WorkerLeaseAcquired'
  | 'WorkerLeaseExpired'
  | 'WorkerFencingRejected'
  | 'WorkflowRecoveredFromCrash';

export interface EventRecord {
  id: string;
  workflowExecutionId: string;
  sequenceId: number; // Strictly monotonic 1, 2, 3...
  eventType: EventType;
  nodeId?: string;
  payload: Record<string, any>;
  metadata: {
    fencingToken?: number;
    workerId?: string;
    timestamp: number;
    attempt?: number;
    durationMs?: number;
    error?: string;
    [key: string]: any;
  };
  createdAt: Date;
}

export interface WorkerLease {
  workflowExecutionId: string;
  nodeId: string;
  workerId: string;
  fencingToken: number;
  acquiredAt: number;
  expiresAt: number;
  ttlMs: number;
  status: 'active' | 'expired' | 'released';
}

export interface NodeRuntimeState {
  status: NodeStatus;
  workerId?: string;
  fencingToken?: number;
  startedAt?: number;
  completedAt?: number;
  input?: any;
  output?: any;
  error?: string;
  attempts: number;
  compensationAttempts?: number;
  isCompensated?: boolean;
}

export interface ExecutionSnapshot {
  workflowExecutionId: string;
  workflowDefinitionId: string;
  status: WorkflowStatus;
  currentSequenceId: number;
  activeFencingToken: number;
  nodeStates: Record<string, NodeRuntimeState>;
  contextState: Record<string, any>;
  activeLeases: WorkerLease[];
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface TelemetryFrame {
  workflowExecutionId: string;
  workflowDefinitionId: string;
  status: WorkflowStatus;
  sequenceId: number;
  activeFencingToken: number;
  nodeStates: Record<string, NodeRuntimeState>;
  contextState: Record<string, any>;
  activeLeases: WorkerLease[];
  activeTokens: Array<{
    edgeId: string;
    source: string;
    target: string;
    progress: number;
  }>;
  recentEvents: EventRecord[];
  metrics: {
    totalNodes: number;
    completedNodes: number;
    failedNodes: number;
    compensatedNodes: number;
    zombieWritesBlocked: number;
    crashesRecovered: number;
  };
  timestamp: number;
}

export interface PoisonPillItem {
  id: string;
  workflowExecutionId: string;
  nodeId: string;
  activityType: string;
  compensationType: string;
  attempts: number;
  lastError: string;
  payload: Record<string, any>;
  blockedAt: number;
  status: 'PENDING' | 'RESOLVED' | 'SKIPPED';
}
