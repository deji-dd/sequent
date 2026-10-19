import { type RamCache, ramCache } from '../cache';
import { workflowRepository } from '../db/repository';
import { FencingTokenMismatchError, LeaseUnavailableError } from './errors';
import type { WorkerLease } from './types';

export { FencingTokenMismatchError, LeaseUnavailableError };

export interface AcquireLeaseOptions {
  /** Bypass the live-lease check. Only the chaos simulation and explicit failover should use this. */
  force?: boolean;
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
   * Reads the current lease from the RAM cache with a durable database fallback.
   */
  async getCurrentLease(executionId: string, nodeId: string): Promise<WorkerLease | null> {
    const raw = await this.cache.get(this.getLeaseKey(executionId, nodeId));
    if (raw) {
      try {
        return JSON.parse(raw) as WorkerLease;
      } catch {
        // fall through to DB
      }
    }
    return workflowRepository.getLease(executionId, nodeId);
  }

  /**
   * Acquires a distributed lease with a strictly monotonic incrementing fencing token.
   * By default it refuses to steal a live lease held by another worker.
   */
  async acquireLease(
    executionId: string,
    nodeId: string,
    workerId: string,
    ttlMs = 4000,
    options: AcquireLeaseOptions = {}
  ): Promise<WorkerLease> {
    const existing = await this.getCurrentLease(executionId, nodeId);
    if (
      !options.force &&
      existing &&
      existing.status === 'active' &&
      existing.expiresAt > Date.now() &&
      existing.workerId !== workerId
    ) {
      throw new LeaseUnavailableError(nodeId, workerId, existing.workerId, existing.expiresAt);
    }

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

    // 2. Persist to DB fallback
    await workflowRepository.saveLease(leaseData);

    return leaseData;
  }

  /**
   * Heartbeat to extend lease TTL. Fails if lease was revoked, expired, or stolen by a higher token.
   */
  async heartbeat(
    executionId: string,
    nodeId: string,
    workerId: string,
    fencingToken: number,
    extensionTtlMs = 4000
  ): Promise<boolean> {
    const currentLease = await this.getCurrentLease(executionId, nodeId);

    if (currentLease?.status !== 'active') {
      return false;
    }

    if (currentLease.expiresAt < Date.now()) {
      return false;
    }

    if (currentLease.workerId !== workerId || currentLease.fencingToken !== fencingToken) {
      // Lease was superseded by a different worker or higher fencing token
      return false;
    }

    currentLease.expiresAt = Date.now() + extensionTtlMs;

    // Update RAM cache
    await this.cache.set(
      this.getLeaseKey(executionId, nodeId),
      JSON.stringify(currentLease),
      'PX',
      extensionTtlMs
    );

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
    const activeLease = await this.getCurrentLease(executionId, nodeId);

    if (
      activeLease?.status !== 'active' ||
      activeLease.expiresAt < Date.now() ||
      activeLease.fencingToken !== claimedToken ||
      activeLease.workerId !== workerId
    ) {
      throw new FencingTokenMismatchError(
        activeLease?.fencingToken ?? highestFencingToken,
        claimedToken,
        nodeId,
        workerId
      );
    }

    return true;
  }

  /**
   * Marks a lease expired (used by the heartbeat watchdog and crash recovery).
   */
  async expireLease(executionId: string, nodeId: string): Promise<void> {
    const lease = await this.getCurrentLease(executionId, nodeId);
    await this.cache.del(this.getLeaseKey(executionId, nodeId));
    this.activeLocalLeases.delete(`${executionId}:${nodeId}`);
    if (lease) {
      await workflowRepository.expireLease(executionId, nodeId);
    }
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
    const lease = await this.getCurrentLease(executionId, nodeId);

    const shouldRelease =
      lease?.workerId === workerId &&
      lease?.fencingToken === fencingToken &&
      lease?.status === 'active';

    if (shouldRelease) {
      await this.cache.del(this.getLeaseKey(executionId, nodeId));
      await workflowRepository.releaseLease(executionId, nodeId);
    }

    const mapKey = `${executionId}:${nodeId}`;
    this.activeLocalLeases.delete(mapKey);
  }

  /**
   * Lists all currently tracked active leases
   */
  getActiveLeases(): WorkerLease[] {
    this.cache.sweep();
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
