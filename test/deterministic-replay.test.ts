import { describe, expect, it } from 'bun:test';
import { DeterministicProxy } from '../src/core/deterministic-proxy';
import type { EventRecord } from '../src/core/types';

describe('Deterministic Execution Sandbox & Replay Interception', () => {
  it('should intercept side-effects and return cached output during replay with zero calls', async () => {
    let networkCallCounter = 0;

    const historicalEvent: EventRecord = {
      id: 'evt_1',
      workflowExecutionId: 'exec_replay_1',
      sequenceId: 2,
      eventType: 'ActivityCompleted',
      nodeId: 'node_fetch_rates',
      payload: {
        stepKey: 'node_fetch_rates:main_1',
        result: { currency: 'EUR', rate: 1.085 },
      },
      metadata: {
        timestamp: 1700000000000,
        stepKey: 'node_fetch_rates:main_1',
      },
      createdAt: new Date(),
    };

    // Instantiate proxy with historical log
    const proxy = new DeterministicProxy([historicalEvent]);

    const context = proxy.createContext('exec_replay_1', 'node_fetch_rates', async () => {
      throw new Error('Should not commit event during replaying of completed step');
    });

    // Invoke step
    const result = await context.step('main', async () => {
      networkCallCounter++;
      return { currency: 'EUR', rate: 999.99 }; // This real network call should NEVER be executed!
    });

    // Verifications
    expect(networkCallCounter).toBe(0); // ZERO network calls executed!
    expect(result).toEqual({ currency: 'EUR', rate: 1.085 });
    expect(context.isReplaying).toBe(true);
  });
});
