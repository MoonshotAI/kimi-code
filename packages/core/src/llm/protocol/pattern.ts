export interface Rewrite<T> {
  readonly consumed: number;
  readonly replacement: readonly T[];
}

export interface Pattern<T> {
  readonly name: string;
  rewrite(items: readonly T[], index: number): Rewrite<T> | null;
}

export function applyPatterns<T>(items: readonly T[], patterns: readonly Pattern<T>[]): T[] {
  let current = [...items];
  for (const pattern of patterns) {
    const next: T[] = [];
    let i = 0;
    while (i < current.length) {
      const rewrite = pattern.rewrite(current, i);
      if (rewrite === null) {
        next.push(current[i] as T);
        i += 1;
      } else {
        next.push(...rewrite.replacement);
        i += rewrite.consumed;
      }
    }
    current = next;
  }
  return current;
}
