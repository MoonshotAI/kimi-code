export function createBrowserUiCommandQueue() {
  const tails = new Map<string, Promise<void>>();
  return function enqueue<T>(key: string, command: () => Promise<T>): Promise<T> {
    const result = (tails.get(key) ?? Promise.resolve()).then(command);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}

export function createBrowserUiRequestTracker() {
  const live = new Set<number>();
  return {
    accept: (requestId: number): void => { live.add(requestId); },
    cancel: (requestId: number): void => { live.delete(requestId); },
    isLive: (requestId: number): boolean => live.has(requestId),
  };
}
