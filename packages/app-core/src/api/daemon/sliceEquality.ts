// app-core api/daemon/sliceEquality — shallow content equality for the
// reducer's state slices.
//
// reduceAppEvent's cloneState gives every Record/array slice a fresh identity
// per event, so a plain reference check cannot tell "cloned" from "changed".
// Callers that assign the reduced state back into a reactive store (the web /
// desktop `applyEvent`) use these to skip untouched slices, so an unrelated
// event — e.g. a streaming text delta — does not dirty computeds that only
// read those slices (sidebar session lists, tasks, goal…). The reducer only
// ever replaces or deletes slice entries (never mutates them in place), which
// is what makes a shallow reference comparison sufficient.

/** Shallow key-by-key reference equality for Record slices. */
export function shallowEqualRecord<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** Element-by-element reference equality for array slices (e.g. warnings). */
export function shallowEqualArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
