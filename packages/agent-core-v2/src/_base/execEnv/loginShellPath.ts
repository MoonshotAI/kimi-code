/**
 * `_base/execEnv` (L0) — login-shell PATH probe.
 *
 * Enriches `process.env.PATH` with entries from the user's login shell. When
 * kimi-code is launched from a context that skipped the user's shell profile
 * (GUI launchers, non-login parent shells), `process.env.PATH` misses entries
 * like `/opt/homebrew/bin`, so commands spawned by the Bash tool can't find
 * tools the user has in their interactive shell (e.g. `gh`). We run the user's
 * login shell once (`$SHELL -l -c /usr/bin/env`), extract its PATH, and append
 * the entries the current PATH lacks. Existing entries keep their order and
 * priority; failures (no resolvable shell, hung or broken profile) silently
 * leave PATH untouched.
 *
 * launchd/daemon launches can leave `$SHELL` unset or blank, so the probe falls
 * back to the OS account's login shell from the user database before giving up.
 *
 * Like `probeHostEnvironment`, the probe is a pure function of injected deps so
 * the suite runs identically on any host. Windows is skipped: the problem is
 * specific to POSIX login-shell profiles.
 *
 * Vendored from `@moonshot-ai/kaos` `login-shell-path.ts` — kept as a pure
 * helper with no DI dependencies.
 */

import { userInfo } from 'node:os';

import { execFileText } from './environmentProbe';

export interface LoginShellPathDeps {
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  readonly userShell: () => string | undefined;
  readonly execFileText: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string | undefined>;
}

const LOGIN_SHELL_ENV_TIMEOUT_MS = 5_000;

export async function probeLoginShellPath(deps: LoginShellPathDeps): Promise<string | undefined> {
  if (deps.platform === 'win32') return undefined;
  const envShell = deps.env['SHELL']?.trim();
  const shell = envShell === undefined || envShell.length === 0 ? deps.userShell() : envShell;
  if (shell === undefined || shell.length === 0) return undefined;

  const stdout = await deps.execFileText(shell, ['-l', '-c', '/usr/bin/env'], LOGIN_SHELL_ENV_TIMEOUT_MS);
  if (stdout === undefined) return undefined;

  let path: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('PATH=')) {
      path = line.slice('PATH='.length).trim();
    }
  }
  if (path === undefined || path.length === 0) return undefined;
  return path;
}

export function mergeLoginShellPath(currentPath: string | undefined, loginShellPath: string): string {
  const current = currentPath ?? '';
  const seen = new Set(current.split(':').filter((entry) => entry.length > 0));
  const additions: string[] = [];
  for (const entry of loginShellPath.split(':')) {
    if (!entry.startsWith('/') || seen.has(entry)) continue;
    seen.add(entry);
    additions.push(entry);
  }
  if (additions.length === 0) return current;
  if (currentPath === undefined) return additions.join(':');
  return `${current}:${additions.join(':')}`;
}

export async function applyLoginShellPath(deps: LoginShellPathDeps): Promise<void> {
  const loginShellPath = await probeLoginShellPath(deps);
  if (loginShellPath === undefined) return;
  const currentPath = deps.env['PATH'];
  const merged = mergeLoginShellPath(currentPath, loginShellPath);
  if (merged === (currentPath ?? '')) return;
  deps.env['PATH'] = merged;
}

function userShellFromNode(): string | undefined {
  try {
    const shell = userInfo().shell;
    return shell === null || shell.length === 0 ? undefined : shell;
  } catch {
    return undefined;
  }
}

let appliedLoginShellPath: Promise<void> | undefined;

export function applyLoginShellPathFromNode(): Promise<void> {
  if (appliedLoginShellPath !== undefined) return appliedLoginShellPath;
  appliedLoginShellPath = applyLoginShellPath({
    platform: process.platform,
    env: process.env as Record<string, string | undefined>,
    userShell: userShellFromNode,
    execFileText,
  });
  return appliedLoginShellPath;
}
