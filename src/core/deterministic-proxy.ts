import type { EventRecord } from './types';

export interface DeterministicContext {
  executionId: string;
  nodeId: string;
  isReplaying: boolean;
  step<T>(stepName: string, fn: () => Promise<T>): Promise<T>;
  now(): number;
  random(): number;
  sleep(ms: number): Promise<void>;
}

export class DeterministicProxy {
  private completedEventsMap: Map<string, EventRecord>;
  private stepCounters: Map<string, number> = new Map();

  constructor(historicalEvents: EventRecord[]) {
    this.completedEventsMap = new Map();
    for (const evt of historicalEvents) {
      if (
        (evt.eventType === 'ActivityCompleted' || evt.eventType === 'CompensationCompleted') &&
        evt.nodeId
      ) {
        const rawStepKey = evt.metadata?.stepKey || 'main';
        // Normalize: if rawStepKey already starts with `${evt.nodeId}:`, extract the inner part
        const cleanStepKey = rawStepKey.startsWith(`${evt.nodeId}:`)
          ? rawStepKey.slice(evt.nodeId.length + 1)
          : rawStepKey;

        this.completedEventsMap.set(`${evt.nodeId}:${cleanStepKey}`, evt);
        this.completedEventsMap.set(`${evt.nodeId}:${rawStepKey}`, evt);
        this.completedEventsMap.set(`${evt.nodeId}:main`, evt);
      }
    }
  }

  createContext(
    executionId: string,
    nodeId: string,
    recordCompletedEventCallback: (stepKey: string, result: any) => Promise<EventRecord>
  ): DeterministicContext {
    const self = this;

    return {
      executionId,
      nodeId,
      get isReplaying() {
        return self.completedEventsMap.size > 0;
      },

      async step<T>(stepName: string, fn: () => Promise<T>): Promise<T> {
        const stepCounter = (self.stepCounters.get(`${nodeId}:${stepName}`) || 0) + 1;
        self.stepCounters.set(`${nodeId}:${stepName}`, stepCounter);
        const uniqueKey = `${nodeId}:${stepName}_${stepCounter}`;

        // 1. Check if cached in replay event log
        const cached = self.completedEventsMap.get(uniqueKey);
        if (cached) {
          // Zero network calls, zero external effects! Return deterministic cached result
          return cached.payload?.result as T;
        }

        // Also check if non-counter key was stored
        const simpleCached = self.completedEventsMap.get(`${nodeId}:${stepName}`);
        if (simpleCached) {
          return simpleCached.payload?.result as T;
        }

        // 2. Not cached: execute real side-effect
        const result = await fn();

        // 3. Record event to log
        await recordCompletedEventCallback(uniqueKey, result);

        return result;
      },

      now(): number {
        // If replaying, use timestamp from historical event if available
        const main = self.completedEventsMap.get(`${nodeId}:main`);
        if (main?.metadata?.timestamp) {
          return main.metadata.timestamp;
        }
        return Date.now();
      },

      random(): number {
        // Deterministic pseudo-random seed from executionId + nodeId + stepCounter
        const counter = self.stepCounters.get(nodeId) || 0;
        self.stepCounters.set(nodeId, counter + 1);
        let hash = 0;
        const seedStr = `${executionId}-${nodeId}-${counter}`;
        for (let i = 0; i < seedStr.length; i++) {
          hash = (hash << 5) - hash + seedStr.charCodeAt(i);
          hash |= 0;
        }
        return Math.abs(hash % 100000) / 100000;
      },

      async sleep(ms: number): Promise<void> {
        const cached = self.completedEventsMap.get(`${nodeId}:sleep`);
        if (cached) {
          // In replay mode, do not sleep! Fast forward instantaneously
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    };
  }
}
