import { describe, expect, it } from 'bun:test';
import { app } from '../src/index';

describe('Sequent Elysia API Server (E2E)', () => {
  it('should return health status', async () => {
    const res = await app.handle(new Request('http://localhost:3003/api/health'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('sequent');
    expect(body.port).toBe(3003);
  });

  it('should list pre-seeded workflow definitions', async () => {
    const res = await app.handle(new Request('http://localhost:3003/api/workflows'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(3);
    expect(body.some((w: any) => w.id === 'ecommerce_order_saga')).toBe(true);
  });

  it('should trigger workflow execution and append events', async () => {
    const triggerRes = await app.handle(
      new Request('http://localhost:3003/api/workflows/fencing_zombie_demo/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { test: true } }),
      })
    );
    expect(triggerRes.status).toBe(200);
    const triggerBody = await triggerRes.json();
    expect(triggerBody.success).toBe(true);
    expect(triggerBody.executionId).toBeDefined();

    // Wait a brief moment for initial events to log
    await new Promise((r) => setTimeout(r, 300));

    const eventsRes = await app.handle(
      new Request(`http://localhost:3003/api/executions/${triggerBody.executionId}/events`)
    );
    expect(eventsRes.status).toBe(200);
    const events = await eventsRes.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].eventType).toBe('WorkflowExecutionStarted');

    // Test Time-Travel Endpoint
    const ttRes = await app.handle(
      new Request(
        `http://localhost:3003/api/executions/${triggerBody.executionId}/time-travel?sequenceId=1`
      )
    );
    expect(ttRes.status).toBe(200);
    const ttData = await ttRes.json();
    expect(ttData.sequenceId).toBe(1);
    expect(ttData.executionId).toBe(triggerBody.executionId);
  });

  it('should list historical executions with filtering and chaosConfig persistence', async () => {
    // 1. Trigger with chaosConfig
    const chaosConfig = {
      enableZombieWorker: true,
      zombieNodeId: 'inventory_reserve',
      stepDelayMs: 400,
    };

    const triggerRes = await app.handle(
      new Request('http://localhost:3003/api/workflows/fencing_zombie_demo/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { chaosTest: true },
          chaosConfig,
        }),
      })
    );
    expect(triggerRes.status).toBe(200);
    const triggerData = await triggerRes.json();
    const execId = triggerData.executionId;

    // 2. Fetch specific execution
    const getRes = await app.handle(new Request(`http://localhost:3003/api/executions/${execId}`));
    expect(getRes.status).toBe(200);
    const execRecord = await getRes.json();
    expect(execRecord.id).toBe(execId);
    expect(execRecord.chaosConfig).toBeDefined();
    expect(execRecord.chaosConfig.enableZombieWorker).toBe(true);

    // 3. List historical executions with filter
    const listRes = await app.handle(
      new Request('http://localhost:3003/api/executions?workflowDefinitionId=fencing_zombie_demo')
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((e: any) => e.id === execId)).toBe(true);
  });
});
