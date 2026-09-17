import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  ChaosConfig,
  EventRecord,
  PoisonPillItem,
  WorkerLease,
  WorkflowDefinition,
  WorkflowStatus,
} from '../core/types';
import { getDb, isDbConnected } from './index';
import * as schema from './schema';

export interface ExecutionFilterOptions {
  limit?: number;
  offset?: number;
  workflowDefinitionId?: string;
  status?: WorkflowStatus;
}

export interface IWorkflowRepository {
  saveDefinition(def: WorkflowDefinition): Promise<void>;
  getDefinition(id: string): Promise<WorkflowDefinition | null>;
  listDefinitions(): Promise<WorkflowDefinition[]>;

  createExecution(record: {
    id: string;
    workflowDefinitionId: string;
    status: WorkflowStatus;
    inputPayload: any;
    chaosConfig?: ChaosConfig;
  }): Promise<void>;

  updateExecution(
    id: string,
    updates: Partial<{
      status: WorkflowStatus;
      currentSequenceId: number;
      activeFencingToken: number;
      outputPayload: any;
      contextState: any;
      nodeStates: any;
      chaosConfig: any;
      error: string | null;
      completedAt: Date | null;
    }>
  ): Promise<void>;

  getExecution(id: string): Promise<any | null>;
  listExecutions(options?: number | ExecutionFilterOptions, offset?: number): Promise<any[]>;
  getUnfinalizedExecutions(): Promise<any[]>;

  appendEvent(event: Omit<EventRecord, 'id' | 'createdAt'>): Promise<EventRecord>;
  getEventLog(executionId: string): Promise<EventRecord[]>;
  getEventsUpToSequence(executionId: string, maxSequenceId: number): Promise<EventRecord[]>;

  addPoisonPill(item: Omit<PoisonPillItem, 'id' | 'blockedAt'>): Promise<PoisonPillItem>;
  listPoisonPillItems(): Promise<PoisonPillItem[]>;
  resolvePoisonPill(id: string, status: 'RESOLVED' | 'SKIPPED'): Promise<boolean>;

  saveLease(lease: WorkerLease): Promise<void>;
  getLease(executionId: string, nodeId: string): Promise<WorkerLease | null>;
  updateLeaseHeartbeat(executionId: string, nodeId: string, expiresAt: number): Promise<void>;
  releaseLease(executionId: string, nodeId: string): Promise<void>;
  getActiveLeases(): Promise<WorkerLease[]>;
  getHighestFencingToken(executionId: string, nodeId: string): Promise<number>;
}

class InMemoryWorkflowRepository implements IWorkflowRepository {
  private definitions = new Map<string, WorkflowDefinition>();
  private executions = new Map<string, any>();
  private eventLogs = new Map<string, EventRecord[]>();
  private sequenceCounters = new Map<string, number>();
  private poisonPillQueue = new Map<string, PoisonPillItem>();
  private leases = new Map<string, WorkerLease>();
  private fencingCounters = new Map<string, number>();

  async saveDefinition(def: WorkflowDefinition): Promise<void> {
    this.definitions.set(def.id, def);
  }

  async getDefinition(id: string): Promise<WorkflowDefinition | null> {
    return this.definitions.get(id) || null;
  }

  async listDefinitions(): Promise<WorkflowDefinition[]> {
    return Array.from(this.definitions.values());
  }

  async createExecution(record: {
    id: string;
    workflowDefinitionId: string;
    status: WorkflowStatus;
    inputPayload: any;
    chaosConfig?: ChaosConfig;
  }): Promise<void> {
    const execution = {
      ...record,
      chaosConfig: record.chaosConfig || null,
      currentSequenceId: 0,
      activeFencingToken: 0,
      outputPayload: null,
      contextState: {},
      nodeStates: {},
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.executions.set(record.id, execution);
    this.eventLogs.set(record.id, []);
    this.sequenceCounters.set(record.id, 0);
  }

  async updateExecution(id: string, updates: Partial<any>): Promise<void> {
    const ex = this.executions.get(id);
    if (!ex) return;
    Object.assign(ex, updates, { updatedAt: new Date() });
    this.executions.set(id, ex);
  }

  async getExecution(id: string): Promise<any | null> {
    return this.executions.get(id) || null;
  }

  async listExecutions(
    options?: number | ExecutionFilterOptions,
    legacyOffset = 0
  ): Promise<any[]> {
    const opts: ExecutionFilterOptions =
      typeof options === 'number' ? { limit: options, offset: legacyOffset } : options || {};
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    let list = Array.from(this.executions.values());
    if (opts.workflowDefinitionId) {
      list = list.filter((ex) => ex.workflowDefinitionId === opts.workflowDefinitionId);
    }
    if (opts.status) {
      list = list.filter((ex) => ex.status === opts.status);
    }
    list.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return list.slice(offset, offset + limit);
  }

  async getUnfinalizedExecutions(): Promise<any[]> {
    const activeStatuses = new Set<WorkflowStatus>(['RUNNING', 'FAILING', 'COMPENSATING']);
    return Array.from(this.executions.values()).filter((ex) => activeStatuses.has(ex.status));
  }

  async appendEvent(event: Omit<EventRecord, 'id' | 'createdAt'>): Promise<EventRecord> {
    let logs = this.eventLogs.get(event.workflowExecutionId);
    if (!logs) {
      logs = [];
      this.eventLogs.set(event.workflowExecutionId, logs);
    }

    const nextSeq = (this.sequenceCounters.get(event.workflowExecutionId) || 0) + 1;
    this.sequenceCounters.set(event.workflowExecutionId, nextSeq);

    const record: EventRecord = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      workflowExecutionId: event.workflowExecutionId,
      sequenceId: nextSeq,
      eventType: event.eventType,
      nodeId: event.nodeId,
      payload: event.payload,
      metadata: event.metadata,
      createdAt: new Date(),
    };

    logs.push(record);

    // Update execution's sequence_id and fencing_token if present
    const ex = this.executions.get(event.workflowExecutionId);
    if (ex) {
      ex.currentSequenceId = nextSeq;
      if (event.metadata.fencingToken) {
        ex.activeFencingToken = Math.max(ex.activeFencingToken || 0, event.metadata.fencingToken);
      }
    }

    return record;
  }

  async getEventLog(executionId: string): Promise<EventRecord[]> {
    return this.eventLogs.get(executionId) || [];
  }

  async getEventsUpToSequence(executionId: string, maxSequenceId: number): Promise<EventRecord[]> {
    const logs = this.eventLogs.get(executionId) || [];
    return logs.filter((e) => e.sequenceId <= maxSequenceId);
  }

  async addPoisonPill(item: Omit<PoisonPillItem, 'id' | 'blockedAt'>): Promise<PoisonPillItem> {
    const id = `pill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fullItem: PoisonPillItem = {
      ...item,
      id,
      blockedAt: Date.now(),
    };
    this.poisonPillQueue.set(id, fullItem);
    return fullItem;
  }

  async listPoisonPillItems(): Promise<PoisonPillItem[]> {
    return Array.from(this.poisonPillQueue.values()).sort((a, b) => b.blockedAt - a.blockedAt);
  }

  async resolvePoisonPill(id: string, status: 'RESOLVED' | 'SKIPPED'): Promise<boolean> {
    const item = this.poisonPillQueue.get(id);
    if (!item) return false;
    item.status = status;
    this.poisonPillQueue.set(id, item);
    return true;
  }

  async saveLease(lease: WorkerLease): Promise<void> {
    const key = `${lease.workflowExecutionId}:${lease.nodeId}`;
    this.leases.set(key, { ...lease });
    const prev = this.fencingCounters.get(key) || 0;
    if (lease.fencingToken > prev) {
      this.fencingCounters.set(key, lease.fencingToken);
    }
  }

  async getLease(executionId: string, nodeId: string): Promise<WorkerLease | null> {
    const key = `${executionId}:${nodeId}`;
    const lease = this.leases.get(key);
    if (!lease) return null;
    return { ...lease };
  }

  async updateLeaseHeartbeat(
    executionId: string,
    nodeId: string,
    expiresAt: number
  ): Promise<void> {
    const key = `${executionId}:${nodeId}`;
    const lease = this.leases.get(key);
    if (lease) {
      lease.expiresAt = expiresAt;
      this.leases.set(key, lease);
    }
  }

  async releaseLease(executionId: string, nodeId: string): Promise<void> {
    const key = `${executionId}:${nodeId}`;
    const lease = this.leases.get(key);
    if (lease) {
      lease.status = 'released';
    }
  }

  async getActiveLeases(): Promise<WorkerLease[]> {
    const now = Date.now();
    const active: WorkerLease[] = [];
    for (const [key, lease] of this.leases.entries()) {
      if (lease.expiresAt > now && lease.status === 'active') {
        active.push({ ...lease });
      } else {
        this.leases.delete(key);
      }
    }
    return active;
  }

  async getHighestFencingToken(executionId: string, nodeId: string): Promise<number> {
    const key = `${executionId}:${nodeId}`;
    return this.fencingCounters.get(key) || 0;
  }
}

class PostgresWorkflowRepository implements IWorkflowRepository {
  private memFallback = new InMemoryWorkflowRepository();

  async saveDefinition(def: WorkflowDefinition): Promise<void> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.saveDefinition(def);

    await db
      .insert(schema.workflowDefinitionsTable)
      .values({
        id: def.id,
        name: def.name,
        description: def.description,
        version: def.version,
        definition: def as any,
      })
      .onConflictDoUpdate({
        target: schema.workflowDefinitionsTable.id,
        set: {
          name: def.name,
          description: def.description,
          version: def.version,
          definition: def as any,
          updatedAt: new Date(),
        },
      });
  }

  async getDefinition(id: string): Promise<WorkflowDefinition | null> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.getDefinition(id);

    const rows = await db
      .select()
      .from(schema.workflowDefinitionsTable)
      .where(eq(schema.workflowDefinitionsTable.id, id));

    if (rows.length === 0) return null;
    return rows[0].definition as any;
  }

  async listDefinitions(): Promise<WorkflowDefinition[]> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.listDefinitions();

    const rows = await db
      .select()
      .from(schema.workflowDefinitionsTable)
      .orderBy(desc(schema.workflowDefinitionsTable.updatedAt));

    return rows.map((r) => r.definition as any);
  }

  async createExecution(record: {
    id: string;
    workflowDefinitionId: string;
    status: WorkflowStatus;
    inputPayload: any;
    chaosConfig?: ChaosConfig;
  }): Promise<void> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.createExecution(record);

    await db.insert(schema.workflowExecutionsTable).values({
      id: record.id,
      workflowDefinitionId: record.workflowDefinitionId,
      status: record.status,
      currentSequenceId: 0,
      activeFencingToken: 0,
      inputPayload: record.inputPayload,
      chaosConfig: record.chaosConfig || undefined,
      nodeStates: {},
      contextState: {},
      startedAt: new Date(),
    });
  }

  async updateExecution(id: string, updates: Partial<any>): Promise<void> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.updateExecution(id, updates);

    await db
      .update(schema.workflowExecutionsTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(schema.workflowExecutionsTable.id, id));
  }

  async getExecution(id: string): Promise<any | null> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.getExecution(id);

    const rows = await db
      .select()
      .from(schema.workflowExecutionsTable)
      .where(eq(schema.workflowExecutionsTable.id, id));

    return rows[0] || null;
  }

  async listExecutions(
    options?: number | ExecutionFilterOptions,
    legacyOffset = 0
  ): Promise<any[]> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.listExecutions(options, legacyOffset);

    const opts: ExecutionFilterOptions =
      typeof options === 'number' ? { limit: options, offset: legacyOffset } : options || {};
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const conditions = [];
    if (opts.workflowDefinitionId) {
      conditions.push(
        eq(schema.workflowExecutionsTable.workflowDefinitionId, opts.workflowDefinitionId)
      );
    }
    if (opts.status) {
      conditions.push(eq(schema.workflowExecutionsTable.status, opts.status));
    }

    const query = db
      .select()
      .from(schema.workflowExecutionsTable)
      .orderBy(desc(schema.workflowExecutionsTable.startedAt))
      .limit(limit)
      .offset(offset);

    if (conditions.length === 1) {
      return (query as any).where(conditions[0]);
    }
    if (conditions.length > 1) {
      return (query as any).where(and(...conditions));
    }

    return query;
  }

  async getUnfinalizedExecutions(): Promise<any[]> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.getUnfinalizedExecutions();

    return db
      .select()
      .from(schema.workflowExecutionsTable)
      .where(
        inArray(schema.workflowExecutionsTable.status, ['RUNNING', 'FAILING', 'COMPENSATING'])
      );
  }

  async appendEvent(event: Omit<EventRecord, 'id' | 'createdAt'>): Promise<EventRecord> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.appendEvent(event);

    // Get current max sequence id atomically
    const latestEvents = await db
      .select({ seq: schema.eventLogTable.sequenceId })
      .from(schema.eventLogTable)
      .where(eq(schema.eventLogTable.workflowExecutionId, event.workflowExecutionId))
      .orderBy(desc(schema.eventLogTable.sequenceId))
      .limit(1);

    const nextSeq = (latestEvents[0]?.seq || 0) + 1;
    const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const [inserted] = await db
      .insert(schema.eventLogTable)
      .values({
        id,
        workflowExecutionId: event.workflowExecutionId,
        sequenceId: nextSeq,
        nodeId: event.nodeId,
        eventType: event.eventType,
        payload: event.payload,
        metadata: event.metadata,
      })
      .returning();

    // Update execution pointer
    await db
      .update(schema.workflowExecutionsTable)
      .set({
        currentSequenceId: nextSeq,
        activeFencingToken: event.metadata.fencingToken || undefined,
        updatedAt: new Date(),
      })
      .where(eq(schema.workflowExecutionsTable.id, event.workflowExecutionId));

    return {
      id: inserted.id,
      workflowExecutionId: inserted.workflowExecutionId,
      sequenceId: inserted.sequenceId,
      eventType: inserted.eventType as any,
      nodeId: inserted.nodeId || undefined,
      payload: inserted.payload as any,
      metadata: inserted.metadata as any,
      createdAt: inserted.createdAt,
    };
  }

  async getEventLog(executionId: string): Promise<EventRecord[]> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.getEventLog(executionId);

    const rows = await db
      .select()
      .from(schema.eventLogTable)
      .where(eq(schema.eventLogTable.workflowExecutionId, executionId))
      .orderBy(asc(schema.eventLogTable.sequenceId));

    return rows.map((r) => ({
      id: r.id,
      workflowExecutionId: r.workflowExecutionId,
      sequenceId: r.sequenceId,
      eventType: r.eventType as any,
      nodeId: r.nodeId || undefined,
      payload: r.payload as any,
      metadata: r.metadata as any,
      createdAt: r.createdAt,
    }));
  }

  async getEventsUpToSequence(executionId: string, maxSequenceId: number): Promise<EventRecord[]> {
    const db = await getDb();
    if (!db || !isDbConnected())
      return this.memFallback.getEventsUpToSequence(executionId, maxSequenceId);

    const rows = await db
      .select()
      .from(schema.eventLogTable)
      .where(eq(schema.eventLogTable.workflowExecutionId, executionId))
      .orderBy(asc(schema.eventLogTable.sequenceId));

    return rows
      .filter((r) => r.sequenceId <= maxSequenceId)
      .map((r) => ({
        id: r.id,
        workflowExecutionId: r.workflowExecutionId,
        sequenceId: r.sequenceId,
        eventType: r.eventType as any,
        nodeId: r.nodeId || undefined,
        payload: r.payload as any,
        metadata: r.metadata as any,
        createdAt: r.createdAt,
      }));
  }

  async addPoisonPill(item: Omit<PoisonPillItem, 'id' | 'blockedAt'>): Promise<PoisonPillItem> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.addPoisonPill(item);

    const id = `pill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const [inserted] = await db
      .insert(schema.poisonPillQueueTable)
      .values({
        id,
        workflowExecutionId: item.workflowExecutionId,
        nodeId: item.nodeId,
        activityType: item.activityType,
        compensationType: item.compensationType,
        attempts: item.attempts,
        lastError: item.lastError,
        payload: item.payload,
        status: 'PENDING',
      })
      .returning();

    return {
      id: inserted.id,
      workflowExecutionId: inserted.workflowExecutionId,
      nodeId: inserted.nodeId,
      activityType: inserted.activityType,
      compensationType: inserted.compensationType,
      attempts: inserted.attempts,
      lastError: inserted.lastError,
      payload: inserted.payload as any,
      status: inserted.status as any,
      blockedAt: inserted.blockedAt.getTime(),
    };
  }

  async listPoisonPillItems(): Promise<PoisonPillItem[]> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.listPoisonPillItems();

    const rows = await db
      .select()
      .from(schema.poisonPillQueueTable)
      .orderBy(desc(schema.poisonPillQueueTable.blockedAt));

    return rows.map((r) => ({
      id: r.id,
      workflowExecutionId: r.workflowExecutionId,
      nodeId: r.nodeId,
      activityType: r.activityType,
      compensationType: r.compensationType,
      attempts: r.attempts,
      lastError: r.lastError,
      payload: r.payload as any,
      status: r.status as any,
      blockedAt: r.blockedAt.getTime(),
    }));
  }

  async resolvePoisonPill(id: string, status: 'RESOLVED' | 'SKIPPED'): Promise<boolean> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.resolvePoisonPill(id, status);

    await db
      .update(schema.poisonPillQueueTable)
      .set({
        status,
        resolvedAt: new Date(),
      })
      .where(eq(schema.poisonPillQueueTable.id, id));

    return true;
  }

  async saveLease(lease: WorkerLease): Promise<void> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.saveLease(lease);

    const id = `${lease.workflowExecutionId}:${lease.nodeId}`;
    await db
      .insert(schema.workerLeasesTable)
      .values({
        id,
        workflowExecutionId: lease.workflowExecutionId,
        nodeId: lease.nodeId,
        workerId: lease.workerId,
        fencingToken: lease.fencingToken,
        ttlMs: lease.ttlMs,
        status: lease.status,
        acquiredAt: new Date(lease.acquiredAt),
        expiresAt: new Date(lease.expiresAt),
      })
      .onConflictDoUpdate({
        target: schema.workerLeasesTable.id,
        set: {
          workerId: lease.workerId,
          fencingToken: lease.fencingToken,
          ttlMs: lease.ttlMs,
          status: lease.status,
          acquiredAt: new Date(lease.acquiredAt),
          expiresAt: new Date(lease.expiresAt),
          updatedAt: new Date(),
        },
      });
  }

  async getLease(executionId: string, nodeId: string): Promise<WorkerLease | null> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.getLease(executionId, nodeId);

    const id = `${executionId}:${nodeId}`;
    const rows = await db
      .select()
      .from(schema.workerLeasesTable)
      .where(eq(schema.workerLeasesTable.id, id));

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      workflowExecutionId: r.workflowExecutionId,
      nodeId: r.nodeId,
      workerId: r.workerId,
      fencingToken: r.fencingToken,
      acquiredAt: r.acquiredAt.getTime(),
      expiresAt: r.expiresAt.getTime(),
      ttlMs: r.ttlMs,
      status: r.status as any,
    };
  }

  async updateLeaseHeartbeat(
    executionId: string,
    nodeId: string,
    expiresAt: number
  ): Promise<void> {
    const db = await getDb();
    if (!db || !isDbConnected())
      return this.memFallback.updateLeaseHeartbeat(executionId, nodeId, expiresAt);

    const id = `${executionId}:${nodeId}`;
    await db
      .update(schema.workerLeasesTable)
      .set({
        expiresAt: new Date(expiresAt),
        updatedAt: new Date(),
      })
      .where(eq(schema.workerLeasesTable.id, id));
  }

  async releaseLease(executionId: string, nodeId: string): Promise<void> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.releaseLease(executionId, nodeId);

    const id = `${executionId}:${nodeId}`;
    await db
      .update(schema.workerLeasesTable)
      .set({
        status: 'released',
        updatedAt: new Date(),
      })
      .where(eq(schema.workerLeasesTable.id, id));
  }

  async getActiveLeases(): Promise<WorkerLease[]> {
    const db = await getDb();
    if (!db || !isDbConnected()) return this.memFallback.getActiveLeases();

    const now = new Date();
    const rows = await db
      .select()
      .from(schema.workerLeasesTable)
      .where(eq(schema.workerLeasesTable.status, 'active'));

    return rows
      .filter((r) => r.expiresAt.getTime() > now.getTime())
      .map((r) => ({
        workflowExecutionId: r.workflowExecutionId,
        nodeId: r.nodeId,
        workerId: r.workerId,
        fencingToken: r.fencingToken,
        acquiredAt: r.acquiredAt.getTime(),
        expiresAt: r.expiresAt.getTime(),
        ttlMs: r.ttlMs,
        status: r.status as any,
      }));
  }

  async getHighestFencingToken(executionId: string, nodeId: string): Promise<number> {
    const db = await getDb();
    if (!db || !isDbConnected())
      return this.memFallback.getHighestFencingToken(executionId, nodeId);

    const id = `${executionId}:${nodeId}`;
    const rows = await db
      .select({ fencingToken: schema.workerLeasesTable.fencingToken })
      .from(schema.workerLeasesTable)
      .where(eq(schema.workerLeasesTable.id, id));

    return rows[0]?.fencingToken || 0;
  }
}

export const workflowRepository: IWorkflowRepository = new PostgresWorkflowRepository();
