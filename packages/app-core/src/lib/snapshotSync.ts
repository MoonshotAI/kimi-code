export interface CoalescedAsyncRunner<T> {
  run(key: string): Promise<T>;
  request(key: string): void;
}

export function createCoalescedAsyncRunner<T>(
  fn: (key: string) => Promise<T>,
): CoalescedAsyncRunner<T> {
  const inFlight = new Map<string, Promise<T>>();
  const queued = new Set<string>();

  function run(key: string): Promise<T> {
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;

    const promise = (async () => fn(key))().finally(() => {
      inFlight.delete(key);
      if (queued.delete(key)) {
        void run(key);
      }
    });
    inFlight.set(key, promise);
    return promise;
  }

  function request(key: string): void {
    if (inFlight.has(key)) {
      queued.add(key);
      return;
    }
    void run(key);
  }

  return { run, request };
}
