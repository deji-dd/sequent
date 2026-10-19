/**
 * Polls until the predicate is true. Prefer this over fixed sleeps so tests are
 * fast when the engine is quick and reliable under CI load.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 8000,
  intervalMs = 25
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
