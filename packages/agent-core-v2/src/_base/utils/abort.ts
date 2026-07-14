/**
 * Abort-signal helpers — user-cancellation errors, abortable promises, signal
 * linking, and deadline abort signals.
 */

export function abortError(message = 'Aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
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

export function isUserCancellation(value: unknown): value is UserCancellationError {
  return value instanceof UserCancellationError;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const onAbort = () => {
    target.abort(source.reason);
  };
  if (source.aborted) {
    onAbort();
    return () => {};
  }
  source.addEventListener('abort', onAbort, { once: true });
  return () => {
    source.removeEventListener('abort', onAbort);
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && !isDefaultAbortReason(signal.reason)) {
    return signal.reason;
  }
  return abortError();
}

function isDefaultAbortReason(reason: Error): boolean {
  return reason.name === 'AbortError' && reason.message === 'This operation was aborted';
}

export interface DeadlineAbortSignal {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly clear: () => void;
}

export function createDeadlineAbortSignal(
  source: AbortSignal,
  timeoutMs: number,
): DeadlineAbortSignal {
  const controller = new AbortController();
  const unlinkAbortSignal = linkAbortSignal(source, controller);
  let didTimeout = false;
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    didTimeout = true;
    controller.abort(abortError());
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    clear: () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      unlinkAbortSignal();
    },
  };
}
