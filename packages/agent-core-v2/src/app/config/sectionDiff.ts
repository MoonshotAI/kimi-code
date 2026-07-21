/**
 * `config` domain (L2) — record-level config-section diffing.
 *
 * Shared by the model/provider/platform services: `diffRecords` computes the
 * added/removed/changed keys between two snapshots of a record-shaped config
 * section, `deepEqual` is the value comparison it uses. Pure functions.
 */

export interface RecordDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export function diffRecords<T>(
  previous: Readonly<Record<string, T>> | undefined,
  current: Readonly<Record<string, T>> | undefined,
): RecordDiff {
  const prev = previous ?? {};
  const curr = current ?? {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(curr)) {
    if (!(key in prev)) {
      added.push(key);
    } else if (!deepEqual(prev[key], curr[key])) {
      changed.push(key);
    }
  }
  for (const key of Object.keys(prev)) {
    if (!(key in curr)) {
      removed.push(key);
    }
  }
  return { added, removed, changed };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
