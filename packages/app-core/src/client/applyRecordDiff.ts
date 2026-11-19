
export function applyRecordDiff<T>(target: Record<string, T>, next: Record<string, T>): void {
  for (const key of Object.keys(next)) {
    if (!Object.is(target[key], next[key])) {
      target[key] = next[key]!;
    }
  }
  for (const key of Object.keys(target)) {
    if (!(key in next)) {
      delete target[key];
    }
  }
}
