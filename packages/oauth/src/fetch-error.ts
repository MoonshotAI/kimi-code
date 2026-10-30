export function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages = new Set<string>();
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (current.message.length > 0) messages.add(current.message);
    if (current instanceof AggregateError) pending.push(...current.errors);
    pending.push(current.cause);
  }
  return [...messages].join(': ');
}
