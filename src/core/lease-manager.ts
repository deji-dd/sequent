import { type RamCache, ramCache } from '../cache';
import { workflowRepository } from '../db/repository';
import type { WorkerLease } from './types';

export class FencingTokenMismatchError extends Error {
  constructor(
    public readonly expectedToken: number,
    public readonly actualToken: number,
    public readonly nodeId: string,
    public readonly workerId: string
  ) {
    super(
      `Worker fencing token mismatch on node '${nodeId}': worker token ${actualToken} is stale. Active/highest lease token is ${expectedToken}. Write rejected to prevent split-brain.`
    );
    this.name = 'FencingTokenMismatchError';
  }
}

export class LeaseManager {
  private cache: RamCache;
  private activeLocalLeases = new Map<string, WorkerLease>();

  constructor(cache: RamCache = ramCache) {
    this.cache = cache;
  }

  private getLeaseKey(executionId: string, nodeId: string): string {
    return `sequent:lease:${executionId}:${nodeId}`;
  }

  private getFencingSeqKey(executionId: string, nodeId: string): string {
    return `sequent:fencing:${executionId}:${nodeId}`;
  }

  /**
   * Acquires a distributed lease with a strictly monotonic incrementing fencing token.
   * Utilizes high-speed RAM cache with durable database fallback.
   */
  async acquireLease(
    executionId: string,
    nodeId: string,
    workerId: string,
    ttlMs = 4000
  ): Promise<WorkerLease> {
    const leaseKey = this.getLeaseKey(executionId, nodeId);
    const fencingKey = this.getFencingSeqKey(executionId, nodeId);

    // If fencing counter not yet initialized in RAM, check DB fallback first
    const existingSeqInCache = await this.cache.get(fencingKey);
    if (!existingSeqInCache) {
      const dbHighestToken = await workflowRepository.getHighestFencingToken(executionId, nodeId);
      if (dbHighestToken > 0) {
        await this.cache.set(fencingKey, dbHighestToken.toString());
      }
    }

    // Strictly monotonic token allocation via atomic INCR
    const fencingToken = await this.cache.incr(fencingKey);

    const now = Date.now();
    const expiresAt = now + ttlMs;

    const leaseData: WorkerLease = {
      workflowExecutionId: executionId,
      nodeId,
      workerId,
      fencingToken,
      acquiredAt: now,
      expiresAt,
      ttlMs,
      status: 'active',
    };

    // 1. Store in RAM cache with TTL
    await this.cache.set(leaseKey, JSON.stringify(leaseData), 'PX', ttlMs);

    const mapKey = `${executionId}:${nodeId}`;
    this.activeLocalLeases.set(mapKey, leaseData);

    // 2. Persist to DB fallback asynchronously
    await workflowRepository.saveLease(leaseData);

    return leaseData;
  }

  /**
   * Heartbeat to extend lease TTL. Fails if lease was revoked or stolen by a higher token.
   */
  async heartbeat(
    executionId: string,
    nodeId: string,
    workerId: string,
    fencingToken: number,
    extensionTtlMs = 4000
  ): Promise<boolean> {
    const leaseKey = this.getLeaseKey(executionId, nodeId);
    const raw = await this.cache.get(leaseKey);

    let currentLease: WorkerLease | null = null;
    if (raw) {
      try {
        currentLease = JSON.parse(raw);
      } catch {
        currentLease = null;
      }
    }

    // Fallback to DB if absent from RAM cache
    if (!currentLease) {
      currentLease = await workflowRepository.getLease(executionId, nodeId);
    }

    if (!currentLease || currentLease.status !== 'active') {
      return false;
    }

    if (currentLease.expiresAt < Date.now()) {
      // Lease has expired
      return false;
    }

    if (currentLease.workerId !== workerId || currentLease.fencingToken !== fencingToken) {
      // Lease was superseded by a different worker or higher fencing token
      return false;
    }

    currentLease.expiresAt = Date.now() + extensionTtlMs;

    // Update RAM cache
    await this.cache.set(leaseKey, JSON.stringify(currentLease), 'PX', extensionTtlMs);

    const mapKey = `${executionId}:${nodeId}`;
    this.activeLocalLeases.set(mapKey, currentLease);

    // Update DB fallback
    await workflowRepository.updateLeaseHeartbeat(executionId, nodeId, currentLease.expiresAt);

    return true;
  }

  /**
   * Verifies that the worker's fencing token is still valid (split-brain protection).
   * Throws FencingTokenMismatchError if a newer token has been allocated.
   */
  async verifyFencingToken(
    executionId: string,
    nodeId: string,
    workerId: string,
    claimedToken: number
  ): Promise<boolean> {
    const fencingKey = this.getFencingSeqKey(executionId, nodeId);
    const leaseKey = this.getLeaseKey(executionId, nodeId);

    // 1. Check highest allocated fencing token (RAM cache with DB fallback)
    const currentFencingSeqRaw = await this.cache.get(fencingKey);
    let highestFencingToken = currentFencingSeqRaw ? parseInt(currentFencingSeqRaw, 10) : 0;

    if (!highestFencingToken) {
      highestFencingToken = await workflowRepository.getHighestFencingToken(executionId, nodeId);
    }

    if (claimedToken < highestFencingToken) {
      throw new FencingTokenMismatchError(highestFencingToken, claimedToken, nodeId, workerId);
    }

    // 2. Check active lease (RAM cache with DB fallback)
    let activeLease: WorkerLease | null = null;
    const activeLeaseRaw = await this.cache.get(leaseKey);
    if (activeLeaseRaw) {
      try {
        activeLease = JSON.parse(activeLeaseRaw);
      } catch {
        activeLease = null;
      }
    }

    if (!activeLease) {
      activeLease = await workflowRepository.getLease(executionId, nodeId);
    }

    if (!activeLease || activeLease.status !== 'active' || activeLease.expiresAt < Date.now()) {
      throw new FencingTokenMismatchError(highestFencingToken, claimedToken, nodeId, workerId);
    }

    if (activeLease.fencingToken !== claimedToken || activeLease.workerId !== workerId) {
      throw new FencingTokenMismatchError(activeLease.fencingToken, claimedToken, nodeId, workerId);
    }

    return true;
  }

  /**
   * Releases an active lease upon clean completion.
   */
  async releaseLease(
    executionId: string,
    nodeId: string,
    workerId: string,
    fencingToken: number
  ): Promise<void> {
    const leaseKey = this.getLeaseKey(executionId, nodeId);
    const raw = await this.cache.get(leaseKey);

    let shouldRelease = false;
    if (raw) {
      try {
        const lease: WorkerLease = JSON.parse(raw);
        if (lease.workerId === workerId && lease.fencingToken === fencingToken) {
          shouldRelease = true;
        }
      } catch {
        // Ignored
      }
    } else {
      const dbLease = await workflowRepository.getLease(executionId, nodeId);
      if (dbLease && dbLease.workerId === workerId && dbLease.fencingToken === fencingToken) {
        shouldRelease = true;
      }
    }

    if (shouldRelease) {
      await this.cache.del(leaseKey);
      await workflowRepository.releaseLease(executionId, nodeId);
    }

    const mapKey = `${executionId}:${nodeId}`;
    this.activeLocalLeases.delete(mapKey);
  }

  /**
   * Lists all currently tracked active leases
   */
  getActiveLeases(): WorkerLease[] {
    const now = Date.now();
    const active: WorkerLease[] = [];
    for (const [key, lease] of this.activeLocalLeases.entries()) {
      if (lease.expiresAt > now && lease.status === 'active') {
        active.push(lease);
      } else {
        this.activeLocalLeases.delete(key);
      }
    }
    return active;
  }
}

export const leaseManager = new LeaseManager();
