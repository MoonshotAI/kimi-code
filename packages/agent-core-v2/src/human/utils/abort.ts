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
