import { describe, expect, it } from 'bun:test';
import { FencingTokenMismatchError, leaseManager } from '../src/core/lease-manager';

describe('Worker Fencing & Split-Brain Prevention', () => {
  it('should allocate strictly monotonic fencing tokens', async () => {
    const execId = `test_exec_${Date.now()}`;
    const nodeId = 'task_charge';

    const lease1 = await leaseManager.acquireLease(execId, nodeId, 'worker_A', 3000);
    const lease2 = await leaseManager.acquireLease(execId, nodeId, 'worker_B', 3000);

    expect(lease2.fencingToken).toBeGreaterThan(lease1.fencingToken);
  });

  it('should reject delayed zombie worker writes when lease has been superseded', async () => {
    const execId = `test_exec_zombie_${Date.now()}`;
    const nodeId = 'task_payment';

    // Worker 1 acquires initial lease with fencing token T1
    const worker1Lease = await leaseManager.acquireLease(execId, nodeId, 'worker_1', 1000);
    const t1 = worker1Lease.fencingToken;

    // Worker 1 experiences a simulated long GC pause.
    // Meanwhile, the orchestrator detects timeout and re-assigns the lease to Worker 2 with higher token T2
    const worker2Lease = await leaseManager.acquireLease(execId, nodeId, 'worker_2', 3000);
    const t2 = worker2Lease.fencingToken;
    expect(t2).toBeGreaterThan(t1);

    // Worker 2 verifies its token successfully
    const worker2Valid = await leaseManager.verifyFencingToken(execId, nodeId, 'worker_2', t2);
    expect(worker2Valid).toBe(true);

    // Now delayed zombie Worker 1 wakes up and tries to verify its stale token t1
    // It MUST throw FencingTokenMismatchError!
    expect(leaseManager.verifyFencingToken(execId, nodeId, 'worker_1', t1)).rejects.toThrow(
      FencingTokenMismatchError
    );
  });

  it('should fall back to database when RAM cache is cleared', async () => {
    const { ramCache } = await import('../src/cache');
    const { workflowRepository } = await import('../src/db/repository');

    const execId = `test_exec_fallback_${Date.now()}`;
    const nodeId = 'task_db_fallback';

    // 1. Acquire lease
    const lease = await leaseManager.acquireLease(execId, nodeId, 'worker_db_1', 5000);
    expect(lease.status).toBe('active');

    // Verify it was persisted to DB repository
    const dbLeaseBefore = await workflowRepository.getLease(execId, nodeId);
    expect(dbLeaseBefore).not.toBeNull();
    expect(dbLeaseBefore?.workerId).toBe('worker_db_1');
    expect(dbLeaseBefore?.fencingToken).toBe(lease.fencingToken);

    // 2. Clear RAM cache to simulate memory eviction or process restart
    ramCache.clear();

    // 3. Verify fencing token should succeed via DB fallback
    const verified = await leaseManager.verifyFencingToken(
      execId,
      nodeId,
      'worker_db_1',
      lease.fencingToken
    );
    expect(verified).toBe(true);

    // 4. Heartbeat should also succeed via DB fallback and re-populate RAM
    const extended = await leaseManager.heartbeat(
      execId,
      nodeId,
      'worker_db_1',
      lease.fencingToken,
      6000
    );
    expect(extended).toBe(true);

    // 5. Clean release updates DB and cache
    await leaseManager.releaseLease(execId, nodeId, 'worker_db_1', lease.fencingToken);
    const dbLeaseAfter = await workflowRepository.getLease(execId, nodeId);
    expect(dbLeaseAfter?.status).toBe('released');
  });
});
