/**
 * APIKeyPool — round-robin allocator for multiple API keys.
 *
 * Designed for parallel subagent execution so that concurrent agents
 * do not hammer a single key's rate-limit quota.
 *
 * Keys are read from environment variables:
 *   KIMI_API_KEY, KIMI_API_KEY_1, KIMI_API_KEY_2, … up to KIMI_API_KEY_99
 *
 * A pool is only created when ≥2 keys are found; otherwise `fromEnv`
 * returns `null` and callers fall back to the root provider's key.
 */

interface KeyState {
  consecutiveFailures: number;
  cooldownUntil: number | null;
}

const COOLDOWN_MS = [30_000, 300_000, 1_800_000] as const;

function cooldownForFailures(failures: number): number {
  if (failures <= 0) return 0;
  if (failures <= COOLDOWN_MS.length) return COOLDOWN_MS.at(failures - 1)!;
  return COOLDOWN_MS.at(-1)!;
}

export class ApiKeyPool {
  private readonly keys: readonly string[];
  private _index = 0;
  private readonly states: Map<string, KeyState>;

  /**
   * Build a pool from environment variables.
   *
   * Collects `PREFIX`, `PREFIX_1`, `PREFIX_2`, … up to `PREFIX_99`.
   * Returns `null` when fewer than 2 keys are found.
   */
  static fromEnv(prefix = 'KIMI_API_KEY'): ApiKeyPool | null {
    const keys: string[] = [];
    const primary = process.env[prefix];
    if (primary !== undefined && primary.trim().length > 0) {
      keys.push(primary.trim());
    }
    for (let i = 1; i < 100; i++) {
      const val = process.env[`${prefix}_${i}`];
      if (val !== undefined && val.trim().length > 0) {
        keys.push(val.trim());
      }
    }
    if (keys.length < 2) {
      return null;
    }
    return new ApiKeyPool(keys);
  }

  constructor(keys: readonly string[]) {
    if (keys.length === 0) {
      throw new Error('Key pool cannot be empty');
    }
    this.keys = keys.slice();
    this.states = new Map<string, KeyState>();
    for (const key of this.keys) {
      this.states.set(key, { consecutiveFailures: 0, cooldownUntil: null });
    }
  }

  /** Number of keys in the pool. */
  get keyCount(): number {
    return this.keys.length;
  }

  /**
   * Acquire the next key in rotation.
   *
   * Skips keys that are in cooldown. If every key is cooling down,
   * falls back to round-robin across the entire pool.
   */
  acquire(): string {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[this._index]!;
      this._index = (this._index + 1) % this.keys.length;
      const state = this.states.get(key);
      if (state === undefined) {
        continue;
      }
      if (state.cooldownUntil !== null) {
        if (now < state.cooldownUntil) {
          continue;
        }
        // Cooldown expired — reset the key to healthy.
        this.states.set(key, { consecutiveFailures: 0, cooldownUntil: null });
      }
      return key;
    }
    // All keys in cooldown — fall back to round-robin.
    const key = this.keys[this._index]!;
    this._index = (this._index + 1) % this.keys.length;
    return key;
  }

  /**
   * Record a failure for the given key.
   *
   * Applies exponential cooldown:
   *   1st failure → 30s
   *   2nd failure → 5min
   *   3rd+ failure → 30min
   */
  recordFailure(key: string): void {
    const state = this.states.get(key);
    if (state === undefined) {
      return;
    }
    const failures = state.consecutiveFailures + 1;
    this.states.set(key, {
      consecutiveFailures: failures,
      cooldownUntil: Date.now() + cooldownForFailures(failures),
    });
  }

  /** Clear the failure state for a key (e.g. after a successful call). */
  resetKey(key: string): void {
    this.states.set(key, { consecutiveFailures: 0, cooldownUntil: null });
  }
}
