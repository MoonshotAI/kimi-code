/**
 * User-cancellation detection and the tool output text shown to the model when a tool call is aborted.
 */

export function isUserCancellation(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'userCancelled' in value && value.userCancelled === true;
}

export function abortedToolOutput(toolName: string, reason: unknown): string {
  if (isUserCancellation(reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}
