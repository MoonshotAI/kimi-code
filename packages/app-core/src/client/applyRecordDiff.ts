// packages/app-core/src/client/applyRecordDiff.ts
// Apply `next` onto the reactive `target` record KEY BY KEY instead of
// replacing the whole object. Wholesale replacement (`rawState.xBySession =
// next`) dirties every computed that merely READ the record — including other
// sessions' consumers (the turns projector of the foreground session re-ran on
// every background session's streaming delta). Per-key writes trigger only the
// deps of the keys actually written.
//
// Pure logic (no Vue) so it can be unit-tested without a reactive runtime.

/**
 * Mutate `target` so it matches `next`: assign entries whose reference (or
 * primitive value) changed, delete keys absent from `next`. `target` keeps its
 * own identity throughout — no parent-object replacement, so Vue effects
 * tracking sibling keys or the parent property are not triggered.
 */
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
