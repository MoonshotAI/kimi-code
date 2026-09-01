/**
 * System-bin PATH fallback — guarantee the OS tool dirs on platforms whose
 * inherited PATH skips them.
 *
 * On OpenHarmony the CLI is typically launched from a terminal app whose
 * PATH covers only the package-manager prefixes (`~/.harmonybrew/bin`,
 * `/usr/local/bin`, ...). The OS's own toybox applets live in `/system/bin`
 * (with a subset in `/bin`), so every command spawned by the Bash tool
 * fails to find `ls`, `date`, `grep`, etc. The login-shell probe cannot
 * rescue this either: it runs `$SHELL -l -c /usr/bin/env`, and `/usr/bin`
 * does not exist on OpenHarmony, so the probe silently fails and PATH
 * stays impoverished.
 *
 * The fallback here is deliberately deterministic: on openharmony, append
 * the well-known system bin directories that actually exist, after the
 * inherited entries (same merge semantics as the login-shell probe — no
 * reordering, no overriding). Directories are probed with stat, which the
 * SELinux policy allows even though readdir on them is denied.
 *
 * Like `login-shell-path`, everything is a pure function of injected deps
 * so the suite runs identically on any host. Non-openharmony platforms
 * bail out before any filesystem probe, leaving PATH untouched.
 */

import { stat } from 'node:fs/promises';

import { mergeLoginShellPath } from './login-shell-path';

export interface SystemBinPathDeps {
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  readonly isDir: (path: string) => Promise<boolean>;
}

/**
 * Well-known OpenHarmony tool dirs, in append order: `/system/bin` holds
 * the full toybox applet set, `/bin` the smaller subset that includes the
 * `sh` we spawn. Appended (not prepended) so a user-installed tool earlier
 * in PATH keeps winning.
 */
const OHOS_SYSTEM_BIN_DIRS: readonly string[] = ['/system/bin', '/bin'];

/**
 * Return the colon-joined system bin dirs that exist on this host, or
 * `undefined` when the probe does not apply (non-openharmony platform) or
 * none of the candidates exist.
 */
export async function probeSystemBinPath(
  deps: SystemBinPathDeps,
): Promise<string | undefined> {
  if (deps.platform !== 'openharmony') return undefined;
  const found: string[] = [];
  for (const dir of OHOS_SYSTEM_BIN_DIRS) {
    if (await deps.isDir(dir)) found.push(dir);
  }
  return found.length === 0 ? undefined : found.join(':');
}

/** Probe the system bin dirs and merge the missing ones into `deps.env['PATH']`. */
export async function applySystemBinPath(deps: SystemBinPathDeps): Promise<void> {
  const additions = await probeSystemBinPath(deps);
  if (additions === undefined) return;
  const currentPath = deps.env['PATH'];
  const merged = mergeLoginShellPath(currentPath, additions);
  // Same write-back discipline as applyLoginShellPath: an unchanged PATH
  // must not be rewritten (an unset PATH must stay unset).
  if (merged === (currentPath ?? '')) return;
  deps.env['PATH'] = merged;
}

/**
 * Production convenience — apply the fallback to `process.env` once per
 * process. Memoised like `applyLoginShellPathFromNode`: the platform and
 * the system dirs do not change for the lifetime of the process, and
 * repeated `LocalKaos.create()` calls must not re-stat them.
 */
let appliedSystemBinPath: Promise<void> | undefined;

export function applySystemBinPathFromNode(): Promise<void> {
  if (appliedSystemBinPath !== undefined) return appliedSystemBinPath;
  appliedSystemBinPath = applySystemBinPath({
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    isDir: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
  });
  return appliedSystemBinPath;
}
