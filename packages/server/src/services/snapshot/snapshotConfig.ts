/**
 * Env-driven knobs for `ISnapshotService`. Read once at boot.
 *
 *   KIMI_SNAPSHOT_READER       'auto' (default) | 'legacy'
 *   KIMI_SNAPSHOT_TIMEOUT_MS   integer ms hard ceiling on the route (default 4000)
 *   KIMI_SNAPSHOT_CACHE_LIMIT  LRU entries (default 32)
 */

export type SnapshotReaderMode = 'auto' | 'legacy';

export interface SnapshotConfig {
  readonly mode: SnapshotReaderMode;
  readonly timeoutMs: number;
  readonly cacheLimit: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_CACHE_LIMIT = 32;

function parseInteger(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

export function loadSnapshotConfig(env: NodeJS.ProcessEnv = process.env): SnapshotConfig {
  const rawMode = env['KIMI_SNAPSHOT_READER']?.trim().toLowerCase();
  const mode: SnapshotReaderMode = rawMode === 'legacy' ? 'legacy' : 'auto';
  return {
    mode,
    timeoutMs: parseInteger(env['KIMI_SNAPSHOT_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS, 100),
    cacheLimit: parseInteger(env['KIMI_SNAPSHOT_CACHE_LIMIT'], DEFAULT_CACHE_LIMIT, 1),
  };
}
