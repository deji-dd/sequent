import type { EventRecord } from './types';

export interface DeterministicContext {
  executionId: string;
  nodeId: string;
  signal?: AbortSignal;
  readonly isReplaying: boolean;
  step<T>(stepName: string, fn: () => Promise<T>): Promise<T>;
  now(): number;
  random(): number;
  sleep(ms: number): Promise<void>;
}

export interface DeterministicProxyOptions {
  /**
   * Appends a step checkpoint to the event log. Called only after `verifyFence`
   * has succeeded so a stale worker can never persist a result.
   */
  recordStepEvent: (
    stepKey: string,
    result: any,
    meta: { timestamp: number; randomCounterEnd: number }
  ) => Promise<EventRecord>;
  /**
   * Validates the worker's fencing token immediately before the checkpoint is
   * committed. Throwing here aborts the step and prevents the event append.
   */
  verifyFence?: () => Promise<boolean>;
  signal?: AbortSignal;
}

export class DeterministicProxy {
  private completedSteps = new Map<string, EventRecord>();
  private legacyMainEvents = new Map<string, EventRecord>();
  private nodesWithHistory = new Set<string>();
  private stepCounters: Map<string, number> = new Map();
  private randomCounters: Map<string, number> = new Map();

  constructor(historicalEvents: EventRecord[]) {
    for (const evt of historicalEvents) {
      if (!evt.nodeId) continue;

      const isStepEvent =
        evt.eventType === 'ActivityStepCompleted' ||
        (evt.eventType === 'ActivityCompleted' && Boolean(evt.metadata?.stepKey)) ||
        (evt.eventType === 'CompensationCompleted' && Boolean(evt.metadata?.stepKey));

      if (isStepEvent) {
        const rawStepKey = evt.metadata?.stepKey || 'main';
        // Normalize: if rawStepKey already starts with `${nodeId}:`, extract the inner part
        const cleanStepKey = rawStepKey.startsWith(`${evt.nodeId}:`)
          ? rawStepKey.slice(evt.nodeId.length + 1)
          : rawStepKey;

        this.completedSteps.set(`${evt.nodeId}:${cleanStepKey}`, evt);
        this.completedSteps.set(`${evt.nodeId}:${rawStepKey}`, evt);
        this.nodesWithHistory.add(evt.nodeId);
      } else if (
        evt.eventType === 'ActivityCompleted' ||
        evt.eventType === 'CompensationCompleted'
      ) {
        // Legacy node-level completion event: useful as a clock source only.
        this.legacyMainEvents.set(evt.nodeId, evt);
        this.nodesWithHistory.add(evt.nodeId);
      }
    }
  }

  createContext(
    executionId: string,
    nodeId: string,
    options: DeterministicProxyOptions
  ): DeterministicContext {
    const self = this;

    return {
      executionId,
      nodeId,
      signal: options.signal,
      get isReplaying() {
        return self.nodesWithHistory.has(nodeId);
      },

      async step<T>(stepName: string, fn: () => Promise<T>): Promise<T> {
        const signal = options.signal;
        signal?.throwIfAborted();

        const counterKey = `${nodeId}:${stepName}`;
        const stepCounter = (self.stepCounters.get(counterKey) || 0) + 1;
        self.stepCounters.set(counterKey, stepCounter);
        const uniqueKey = `${nodeId}:${stepName}_${stepCounter}`;

        // 1. Check if this exact step checkpoint already exists
        const cached = self.completedSteps.get(uniqueKey);
        if (cached) {
          // Restore the pseudo-random call counter so later uncached steps are stable.
          const randomCounterEnd = Number(cached.metadata?.randomCounterEnd || 0);
          if (randomCounterEnd > (self.randomCounters.get(nodeId) || 0)) {
            self.randomCounters.set(nodeId, randomCounterEnd);
          }
          return cached.payload?.result as T;
        }

        // Legacy fallback: non-counter step key (e.g. an older single-step event)
        const simpleCached = self.completedSteps.get(`${nodeId}:${stepName}`);
        if (simpleCached) {
          return simpleCached.payload?.result as T;
        }

        // 2. Not cached: execute the real side effect
        const result = await fn();
        signal?.throwIfAborted();

        // 3. Verify the fence BEFORE writing anything durable. A stale worker
        //    must be rejected without leaving a successful checkpoint behind.
        if (options.verifyFence) {
          await options.verifyFence();
        }

        // 4. Record the step checkpoint
        await options.recordStepEvent(uniqueKey, result, {
          timestamp: Date.now(),
          randomCounterEnd: self.randomCounters.get(nodeId) || 0,
        });

        return result;
      },

      now(): number {
        // If replaying, use the historical event timestamp (or the cached result's clock)
        const main =
          self.completedSteps.get(`${nodeId}:main_1`) ||
          self.completedSteps.get(`${nodeId}:main`) ||
          self.legacyMainEvents.get(nodeId);
        if (main?.metadata?.timestamp) {
          return main.metadata.timestamp;
        }
        return Date.now();
      },

      random(): number {
        // Deterministic pseudo-random seed from executionId + nodeId + call counter
        const counter = self.randomCounters.get(nodeId) || 0;
        self.randomCounters.set(nodeId, counter + 1);
        let hash = 0;
        const seedStr = `${executionId}-${nodeId}-${counter}`;
        for (let i = 0; i < seedStr.length; i++) {
          hash = (hash << 5) - hash + seedStr.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash % 100000) / 100000;
      },

      async sleep(ms: number): Promise<void> {
        // During deterministic replay of a node with history, fast-forward.
        if (self.nodesWithHistory.has(nodeId)) {
          options.signal?.throwIfAborted();
          return;
        }
        await abortableSleep(ms, options.signal);
      },
    };
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAbortError(): Error {
  const error = new Error('Task aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
