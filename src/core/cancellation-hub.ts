export class CancellationHub {
  private abortControllers = new Map<string, Map<string, AbortController>>(); // executionId -> (nodeId -> AbortController)
  private runningPromises = new Map<string, Map<string, Promise<any>>>(); // executionId -> (nodeId -> Promise)

  /**
   * Creates the AbortController for a task. The caller must pass its signal into the
   * activity execution and then call trackRunningTask() once the promise exists.
   */
  registerController(executionId: string, nodeId: string): AbortController {
    let execControllers = this.abortControllers.get(executionId);
    if (!execControllers) {
      execControllers = new Map();
      this.abortControllers.set(executionId, execControllers);
    }

    const controller = new AbortController();
    execControllers.set(nodeId, controller);
    return controller;
  }

  trackRunningTask(executionId: string, nodeId: string, taskPromise: Promise<any>): void {
    let execPromises = this.runningPromises.get(executionId);
    if (!execPromises) {
      execPromises = new Map();
      this.runningPromises.set(executionId, execPromises);
    }
    execPromises.set(nodeId, taskPromise);

    // Clean up when done
    taskPromise.finally(() => {
      this.abortControllers.get(executionId)?.delete(nodeId);
      this.runningPromises.get(executionId)?.delete(nodeId);
    });
  }

  /**
   * Backwards-compatible helper: creates a controller, tracks the promise, and returns the signal.
   * New callers should prefer registerController()/trackRunningTask() so the signal exists before
   * the task starts.
   */
  registerRunningTask(executionId: string, nodeId: string, taskPromise: Promise<any>): AbortSignal {
    const controller = this.registerController(executionId, nodeId);
    this.trackRunningTask(executionId, nodeId, taskPromise);
    return controller.signal;
  }

  /**
   * Aborts every running task for an execution (used by simulated crash and shutdown).
   */
  abortExecution(executionId: string, reason = 'Execution aborted'): string[] {
    const execControllers = this.abortControllers.get(executionId);
    if (!execControllers) return [];
    const aborted: string[] = [];
    for (const [nodeId, controller] of execControllers.entries()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`${reason} (node ${nodeId})`));
        aborted.push(nodeId);
      }
    }
    return aborted;
  }

  /**
   * Dispatches active AbortSignal to all running siblings except the failed node.
   * Pauses until all running siblings either finish safely, acknowledge abort, or timeout.
   */
  async cancelSiblingsAndWait(
    executionId: string,
    failedNodeId: string,
    timeoutMs = 5000
  ): Promise<{ cancelledNodes: string[]; completedNodes: string[] }> {
    const execControllers = this.abortControllers.get(executionId);
    const execPromises = this.runningPromises.get(executionId);

    const cancelledNodes: string[] = [];
    const waitPromises: Promise<{ nodeId: string; completedSafely: boolean }>[] = [];

    if (execControllers && execPromises) {
      for (const [nodeId, controller] of execControllers.entries()) {
        if (nodeId !== failedNodeId) {
          if (!controller.signal.aborted) {
            controller.abort(
              new Error(`Sibling task ${failedNodeId} failed; cancelling task ${nodeId}`)
            );
            cancelledNodes.push(nodeId);
          }

          const runningPromise = execPromises.get(nodeId);
          if (runningPromise) {
            const timeoutPromise = new Promise<{ nodeId: string; completedSafely: boolean }>(
              (resolve) => {
                setTimeout(() => resolve({ nodeId, completedSafely: false }), timeoutMs);
              }
            );

            const taskOutcome = runningPromise
              .then(() => ({ nodeId, completedSafely: true }))
              .catch(() => ({ nodeId, completedSafely: false }));

            waitPromises.push(Promise.race([taskOutcome, timeoutPromise]));
          }
        }
      }
    }

    const results = await Promise.all(waitPromises);
    const completedNodes = results.filter((r) => r.completedSafely).map((r) => r.nodeId);

    return {
      cancelledNodes,
      completedNodes,
    };
  }

  /**
   * Waits (bounded) for all tracked tasks of an execution to settle.
   */
  async settleExecution(executionId: string, timeoutMs = 5000): Promise<void> {
    const execPromises = this.runningPromises.get(executionId);
    const promises = execPromises ? [...execPromises.values()] : [];
    if (promises.length === 0) return;

    const settled = Promise.allSettled(promises);
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  isCancelled(executionId: string, nodeId: string): boolean {
    return this.abortControllers.get(executionId)?.get(nodeId)?.signal.aborted || false;
  }

  getRunningNodeIds(executionId: string): string[] {
    return [...(this.abortControllers.get(executionId)?.keys() ?? [])];
  }

  cleanup(executionId: string): void {
    this.abortControllers.delete(executionId);
    this.runningPromises.delete(executionId);
  }
}

export const cancellationHub = new CancellationHub();
