import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { ChaosConfig, EventType, NodeRuntimeState, WorkflowStatus } from '../core/types';

// Workflow Definitions Table
export const workflowDefinitionsTable = pgTable('workflow_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  version: integer('version').default(1).notNull(),
  definition: jsonb('definition').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Workflow Executions Table
export const workflowExecutionsTable = pgTable('workflow_executions', {
  id: text('id').primaryKey(),
  workflowDefinitionId: text('workflow_definition_id').notNull(),
  status: text('status').$type<WorkflowStatus>().notNull(),
  currentSequenceId: integer('current_sequence_id').default(0).notNull(),
  activeFencingToken: integer('active_fencing_token').default(0).notNull(),
  inputPayload: jsonb('input_payload').notNull(),
  outputPayload: jsonb('output_payload'),
  contextState: jsonb('context_state').default({}).notNull(),
  nodeStates: jsonb('node_states').$type<Record<string, NodeRuntimeState>>().default({}).notNull(),
  chaosConfig: jsonb('chaos_config').$type<ChaosConfig>(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Append-only Event Log Table
export const eventLogTable = pgTable('event_log', {
  id: text('id').primaryKey(),
  workflowExecutionId: text('workflow_execution_id').notNull(),
  sequenceId: integer('sequence_id').notNull(),
  nodeId: text('node_id'),
  eventType: text('event_type').$type<EventType>().notNull(),
  payload: jsonb('payload').notNull(),
  metadata: jsonb('metadata').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Worker Leases & Fencing Tokens Table
export const workerLeasesTable = pgTable('worker_leases', {
  id: text('id').primaryKey(), // `${executionId}:${nodeId}`
  workflowExecutionId: text('workflow_execution_id').notNull(),
  nodeId: text('node_id').notNull(),
  workerId: text('worker_id').notNull(),
  fencingToken: integer('fencing_token').notNull(),
  ttlMs: integer('ttl_ms').notNull(),
  status: text('status').default('active').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Poison Pill Quarantine Queue Table
export const poisonPillQueueTable = pgTable('poison_pill_queue', {
  id: text('id').primaryKey(),
  workflowExecutionId: text('workflow_execution_id').notNull(),
  nodeId: text('node_id').notNull(),
  activityType: text('activity_type').notNull(),
  compensationType: text('compensation_type').notNull(),
  attempts: integer('attempts').notNull(),
  lastError: text('last_error').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').default('PENDING').notNull(), // PENDING | RESOLVED | SKIPPED
  blockedAt: timestamp('blocked_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

export type WorkflowDefinitionRecord = typeof workflowDefinitionsTable.$inferSelect;
export type WorkflowExecutionRecord = typeof workflowExecutionsTable.$inferSelect;
export type EventLogRecord = typeof eventLogTable.$inferSelect;
export type WorkerLeaseRecord = typeof workerLeasesTable.$inferSelect;
export type PoisonPillRecord = typeof poisonPillQueueTable.$inferSelect;
