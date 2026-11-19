export interface WaitOpts<E> {
  readonly match?: (event: E) => boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(reason === undefined ? 'aborted' : String(reason));
}

export function waitEvent<E>(listen: (handler: (event: E) => void) => () => void, opts?: WaitOpts<E>): Promise<E> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      unsubscribe?.();
      if (timer !== undefined) clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(opts?.signal));
    };
    if (opts?.signal?.aborted) {
      onAbort();
      return;
    }
    unsubscribe = listen((event) => {
      if (opts?.match !== undefined && !opts.match(event)) return;
      cleanup();
      resolve(event);
    });
    if (opts?.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`wait timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
