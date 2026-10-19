/**
 * Shared lease/fencing errors. Kept in a standalone module so both the repository
 * (atomic commit validation) and the lease manager can throw the same class
 * without a circular import.
 */
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

export class LeaseUnavailableError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly workerId: string,
    public readonly heldBy: string,
    public readonly expiresAt: number
  ) {
    super(
      `Lease for node '${nodeId}' is currently held by worker '${heldBy}' until ${new Date(expiresAt).toISOString()}; worker '${workerId}' must wait for expiry or use force.`
    );
    this.name = 'LeaseUnavailableError';
  }
}

export type PoisonPillResolutionCode =
  | 'not_found'
  | 'not_pending'
  | 'execution_not_found'
  | 'execution_not_blocked'
  | 'definition_not_found';

export class PoisonPillResolutionError extends Error {
  constructor(
    public readonly code: PoisonPillResolutionCode,
    message: string
  ) {
    super(message);
    this.name = 'PoisonPillResolutionError';
  }
}
