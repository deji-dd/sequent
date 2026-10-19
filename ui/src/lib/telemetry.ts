/**
 * Pure telemetry relevance check, shared by the hook and unit tests.
 *
 * A frame/event is only applied when it belongs to the execution the user is
 * currently inspecting. With no active execution (idle screen) all live traffic
 * is ignored rather than letting another client's run hijack the view.
 */
export function isMessageForActiveExecution(
  messageExecutionId: string | undefined,
  activeExecutionId: string | null
): boolean {
  if (!activeExecutionId) return false;
  return messageExecutionId === activeExecutionId;
}
