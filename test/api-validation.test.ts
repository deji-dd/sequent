import { beforeAll, describe, expect, it } from 'bun:test';

import { workflowRepository } from '../src/db/repository';
import { app, ready } from '../src/index';

async function request(pathname: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost:3003${pathname}`, init));
}

describe('API validation and status codes', () => {
  beforeAll(async () => {
    await ready;
  });

  it('reports readiness and database state', async () => {
    const res = await request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.ready).toBe(true);
    expect(typeof body.dbConnected).toBe('boolean');
  });

  it('rejects cyclic workflow definitions before saving them', async () => {
    const cyclic = {
      id: `api_cycle_${Date.now()}`,
      name: 'Cyclic',
      version: 1,
      nodes: [
        { id: 'a', name: 'A', type: 'task', activityType: 'a' },
        { id: 'b', name: 'B', type: 'task', activityType: 'b' },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'a' },
      ],
    };

    const res = await request('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cyclic),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('cyclic');
  });

  it('returns 404 for unknown executions and definitions', async () => {
    const missingExecution = await request('/api/executions/does-not-exist');
    expect(missingExecution.status).toBe(404);
    const missingEvents = await request('/api/executions/does-not-exist/events');
    expect(missingEvents.status).toBe(404);
    const missingTrigger = await request('/api/workflows/does-not-exist/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missingTrigger.status).toBe(404);
  });

  it('validates chaos node references and time-travel sequence ids', async () => {
    const invalidChaos = await request('/api/workflows/fencing_zombie_demo/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chaosConfig: { zombieNodeId: 'missing_node' } }),
    });
    expect(invalidChaos.status).toBe(400);
    const chaosBody = await invalidChaos.json();
    expect(chaosBody.error).toContain('zombieNodeId');

    const invalidSeq = await request(
      '/api/executions/does-not-exist/time-travel?sequenceId=not-a-number'
    );
    expect(invalidSeq.status).toBe(400);
  });

  it('validates poison-pill actions and returns 404 for unknown items', async () => {
    const invalidAction = await request('/api/poison-pill/missing/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'BOGUS' }),
    });
    expect(invalidAction.status).toBe(400);

    const missingItem = await request('/api/poison-pill/missing/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'RESOLVED' }),
    });
    expect(missingItem.status).toBe(404);
  });

  it('returns 409 when a poison-pill item is no longer pending', async () => {
    const pill = await workflowRepository.addPoisonPill({
      workflowExecutionId: `api_poison_exec_${Date.now()}`,
      nodeId: 'n1',
      activityType: 'n',
      compensationType: 'rb',
      attempts: 1,
      lastError: 'boom',
      payload: {},
      status: 'PENDING',
    });
    await workflowRepository.resolvePoisonPill(pill.id, 'RESOLVED');

    const res = await request(`/api/poison-pill/${pill.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'SKIPPED' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('not_pending');
  });
});
