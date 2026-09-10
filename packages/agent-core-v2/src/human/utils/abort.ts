export interface AbortScope {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

export class UserCancellationError extends Error {
  readonly userCancelled = true;

  constructor() {
    super('Aborted by the user');
    this.name = 'AbortError';
  }
}

export function userCancellationReason(): UserCancellationError {
  return new UserCancellationError();
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
