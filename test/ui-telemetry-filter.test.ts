import { describe, expect, it } from 'bun:test';
import { isMessageForActiveExecution } from '../ui/src/lib/telemetry';

describe('Telemetry execution scoping', () => {
  it('drops frames when no execution is selected', () => {
    expect(isMessageForActiveExecution('exec_a', null)).toBe(false);
  });

  it('accepts only frames for the active execution', () => {
    expect(isMessageForActiveExecution('exec_a', 'exec_a')).toBe(true);
    expect(isMessageForActiveExecution('exec_b', 'exec_a')).toBe(false);
  });

  it('drops frames without an execution id', () => {
    expect(isMessageForActiveExecution(undefined, 'exec_a')).toBe(false);
  });
});
