/**
 * Postgres-only regression test. Opt in with:
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/db bun test test/postgres-sequencing.test.ts
 *
 * The default suite stays in-memory so it runs without a database.
 */
import { describe, expect, it } from 'bun:test';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const maybeDescribe = testDatabaseUrl ? describe : describe.skip;

maybeDescribe('Postgres event sequencing and fencing', () => {
  it('allocates unique/contiguous sequence ids under concurrent appends and validates fences', async () => {
    process.env.DATABASE_URL = testDatabaseUrl;

    const { initDb, isDbConnected, closeDb } = await import('../src/db/index');
    const { workflowRepository } = await import('../src/db/repository');
    const { leaseManager } = await import('../src/core/lease-manager');

    await initDb();
    if (!isDbConnected()) {
      throw new Error('TEST_DATABASE_URL was set but the database connection failed');
    }

    const definitionId = `pgtest_def_${Date.now()}`;
    const executionId = `pgtest_exec_${Date.now()}`;

    await workflowRepository.saveDefinition({
      id: definitionId,
      name: 'Postgres sequencing',
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

    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          workflowRepository.appendEvent({
            workflowExecutionId: executionId,
            eventType: 'ActivityFailed',
            payload: { index },
            metadata: { timestamp: Date.now() },
          })
        )
      );

      const events = await workflowRepository.getEventLog(executionId);
      const sequences = events.map((event) => event.sequenceId);
      expect(events).toHaveLength(20);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences).toEqual(sequences.map((_, index) => index + 1));

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
      ).rejects.toThrow();

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
      expect(accepted.sequenceId).toBe(21);
    } finally {
      await closeDb();
      const postgres = (await import('postgres')).default;
      const sql = postgres(testDatabaseUrl!, { connect_timeout: 3 });
      await sql`DELETE FROM event_log WHERE workflow_execution_id = ${executionId}`;
      await sql`DELETE FROM worker_leases WHERE workflow_execution_id = ${executionId}`;
      await sql`DELETE FROM workflow_executions WHERE id = ${executionId}`;
      await sql`DELETE FROM workflow_definitions WHERE id = ${definitionId}`;
      await sql.end();
    }
  }, 30000);
});
