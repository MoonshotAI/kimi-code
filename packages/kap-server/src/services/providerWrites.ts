let providerWriteChain: Promise<unknown> = Promise.resolve();

export function enqueueProviderWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = providerWriteChain.then(task, task);
  providerWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
