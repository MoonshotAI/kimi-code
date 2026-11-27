export interface AbortScope {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

export function createAbortScope(): AbortScope {
  const controller = new AbortController();
  return { signal: controller.signal, abort: (reason) => controller.abort(reason) };
}

export function withAbort(parent: AbortSignal): AbortScope {
  const scope = createAbortScope();
  return {
    signal: AbortSignal.any([parent, scope.signal]),
    abort: (reason) => scope.abort(reason),
  };
}

export function isUserCancellation(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'userCancelled' in value && value.userCancelled === true;
}

export function abortedToolOutput(toolName: string, reason: unknown): string {
  if (isUserCancellation(reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}
