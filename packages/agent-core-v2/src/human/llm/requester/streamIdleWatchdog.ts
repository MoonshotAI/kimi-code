export interface StreamIdleWatchdog {
  readonly signal: AbortSignal;
  readonly triggered: boolean;
  reset(): void;
  cancel(): void;
}

export function createStreamIdleWatchdog(options: {
  readonly idleTimeoutMs: number;
  readonly upstream: AbortSignal;
  readonly onIdle: () => void;
}): StreamIdleWatchdog {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  let disposed = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    if (fired || disposed) return;
    clear();
    timer = setTimeout(() => {
      fired = true;
      timer = undefined;
      options.onIdle();
      controller.abort();
    }, options.idleTimeoutMs);
    timer.unref?.();
  };
  const relayAbort = () => {
    controller.abort(options.upstream.reason);
  };
  if (options.upstream.aborted) {
    controller.abort(options.upstream.reason);
  } else {
    options.upstream.addEventListener('abort', relayAbort, { once: true });
  }
  arm();
  return {
    signal: controller.signal,
    get triggered() {
      return fired;
    },
    reset: arm,
    cancel: () => {
      if (disposed) return;
      disposed = true;
      clear();
      options.upstream.removeEventListener('abort', relayAbort);
    },
  };
}
