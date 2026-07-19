/**
 * `config` domain (L2) — cross-process lock target for the config.toml write path.
 *
 * Pure seam shared by `ConfigService.persist`: the lock file path derived from
 * the resolved config file (`<configPath>.lock` — `<homeDir>/config.toml.lock`
 * in the default layout, so a custom `--config` path is protected at its real
 * location) and the bounded-wait acquisition options for the lock-in
 * read-modify-write critical section (design: `.tmp/refactor-watch-design-v2.md`
 * §3.6). Owns no scoped state.
 */

import type {
  CrossProcessLockAcquireOptions,
  CrossProcessLockWaitOptions,
} from '#/os/interface/crossProcessLock';

export interface ConfigFileMutexTarget {
  readonly lockPath: string;
  readonly options: CrossProcessLockAcquireOptions & { wait: CrossProcessLockWaitOptions };
}

export const CONFIG_FILE_LOCK_TIMEOUT_MS = 10_000;
export const CONFIG_FILE_LOCK_RETRY_INTERVAL_MS = 50;

const DEFAULT_WAIT: CrossProcessLockWaitOptions = {
  timeoutMs: CONFIG_FILE_LOCK_TIMEOUT_MS,
  retryIntervalMs: CONFIG_FILE_LOCK_RETRY_INTERVAL_MS,
};

export function configFileMutexTarget(
  configPath: string,
  wait: CrossProcessLockWaitOptions = DEFAULT_WAIT,
): ConfigFileMutexTarget {
  return { lockPath: `${configPath}.lock`, options: { wait } };
}
