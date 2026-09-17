export class CancellationHub {
  private abortControllers = new Map<string, Map<string, AbortController>>(); // executionId -> (nodeId -> AbortController)
  private runningPromises = new Map<string, Map<string, Promise<any>>>(); // executionId -> (nodeId -> Promise)

  registerRunningTask(executionId: string, nodeId: string, taskPromise: Promise<any>): AbortSignal {
    let execControllers = this.abortControllers.get(executionId);
    if (!execControllers) {
      execControllers = new Map();
      this.abortControllers.set(executionId, execControllers);
    }

    const controller = new AbortController();
    execControllers.set(nodeId, controller);

    let execPromises = this.runningPromises.get(executionId);
    if (!execPromises) {
      execPromises = new Map();
      this.runningPromises.set(executionId, execPromises);
    }
    execPromises.set(nodeId, taskPromise);

    // Clean up when done
    taskPromise.finally(() => {
      execControllers?.delete(nodeId);
      execPromises?.delete(nodeId);
    });

    return controller.signal;
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
          controller.abort(
            new Error(`Sibling task ${failedNodeId} failed; cancelling task ${nodeId}`)
          );
          cancelledNodes.push(nodeId);

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

  isCancelled(executionId: string, nodeId: string): boolean {
    return this.abortControllers.get(executionId)?.get(nodeId)?.signal.aborted || false;
  }

  cleanup(executionId: string): void {
    this.abortControllers.delete(executionId);
    this.runningPromises.delete(executionId);
  }
}

export const cancellationHub = new CancellationHub();
