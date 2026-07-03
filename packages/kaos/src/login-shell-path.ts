/**
 * Login-shell PATH probe — enrich `process.env.PATH` with entries from the
 * user's login shell.
 *
 * When kimi-code is launched from a context that skipped the user's shell
 * profile (GUI launchers, non-login parent shells), `process.env.PATH`
 * misses entries like `/opt/homebrew/bin`, so commands spawned by the Bash
 * tool can't find tools the user has in their interactive shell (e.g.
 * `gh`). We run the user's login shell once (`$SHELL -l -c /usr/bin/env`),
 * extract its PATH, and append the entries the current PATH lacks. Existing
 * entries keep their order and priority; failures (no resolvable shell,
 * hung or broken profile) silently leave PATH untouched.
 *
 * launchd/daemon launches can leave `$SHELL` unset or blank (see
 * `defaultShell()` in agent-core's terminalService for the same case), so
 * the probe falls back to the OS account's login shell from the user
 * database before giving up.
 *
 * Like `detectEnvironment`, the probe is a pure function of injected deps
 * so the suite runs identically on any host. Windows is skipped: the
 * problem is specific to POSIX login-shell profiles.
 */

import { userInfo } from 'node:os';

import { execFileText } from './environment';

export interface LoginShellPathDeps {
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  /** Login shell from the OS user database; fallback when $SHELL is unset. */
  readonly userShell: () => string | undefined;
  readonly execFileText: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string | undefined>;
}

const LOGIN_SHELL_ENV_TIMEOUT_MS = 5_000;

/**
 * Run the user's login shell and return its PATH, or `undefined` when the
 * probe does not apply (Windows, no resolvable shell) or fails (spawn
 * error, timeout, no PATH in the output).
 */
export async function probeLoginShellPath(deps: LoginShellPathDeps): Promise<string | undefined> {
  if (deps.platform === 'win32') return undefined;
  // A set-but-blank $SHELL (some daemon/launchd envs) must also fall back.
  const envShell = deps.env['SHELL']?.trim();
  const shell = envShell === undefined || envShell.length === 0 ? deps.userShell() : envShell;
  if (shell === undefined || shell.length === 0) return undefined;

  // `env` prints the resolved environment in every shell dialect, unlike
  // `echo $PATH`, which fish would join with spaces. Invoke it by absolute
  // path: a bare `env` resolves through the inherited PATH — which may
  // carry cwd-dependent components — from the workspace cwd, so a
  // repo-planted `env` binary could run at session startup and feed us an
  // arbitrary PATH. The absolute path also bypasses profile function
  // shadowing, and /usr/bin/env is guaranteed on every mainstream POSIX
  // system (it is the canonical shebang interpreter path).
  const stdout = await deps.execFileText(
    shell,
    ['-l', '-c', '/usr/bin/env'],
    LOGIN_SHELL_ENV_TIMEOUT_MS,
  );
  if (stdout === undefined) return undefined;

  // Profile output lands on stdout before `env` runs, so keep the last
  // PATH= line.
  let path: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('PATH=')) {
      path = line.slice('PATH='.length).trim();
    }
  }
  if (path === undefined || path.length === 0) return undefined;
  return path;
}

/**
 * Union of the current PATH and the login-shell PATH: the current PATH
 * string is kept verbatim — including empty components, which POSIX
 * command lookup treats as the current directory — and login-shell
 * entries the current PATH lacks are appended in their own order. When
 * nothing is missing the current string is returned unchanged. Only
 * absolute login-shell entries are imported: empty, `.`, and relative
 * components are all cwd-dependent lookup, and appending one the user
 * did not already have would widen their search path — LocalKaos runs
 * commands from arbitrary workspace directories.
 */
export function mergeLoginShellPath(
  currentPath: string | undefined,
  loginShellPath: string,
): string {
  const current = currentPath ?? '';
  const seen = new Set(current.split(':').filter((entry) => entry.length > 0));
  const additions: string[] = [];
  for (const entry of loginShellPath.split(':')) {
    // The probe only runs on POSIX (win32 bails before merging), so a
    // leading slash is a sufficient absoluteness test. Empty components
    // fail it too.
    if (!entry.startsWith('/') || seen.has(entry)) continue;
    seen.add(entry);
    additions.push(entry);
  }
  if (additions.length === 0) return current;
  // `undefined` means "no PATH at all", so the additions stand alone; ''
  // is a real (cwd-only) PATH whose empty component must survive as a
  // leading colon.
  if (currentPath === undefined) return additions.join(':');
  return `${current}:${additions.join(':')}`;
}

/** Probe the login shell and merge its PATH into `deps.env['PATH']`. */
export async function applyLoginShellPath(deps: LoginShellPathDeps): Promise<void> {
  const loginShellPath = await probeLoginShellPath(deps);
  if (loginShellPath === undefined) return;
  const currentPath = deps.env['PATH'];
  const merged = mergeLoginShellPath(currentPath, loginShellPath);
  // Only write when something was appended — an unset PATH must stay
  // unset (assigning '' would turn "implementation default search path"
  // into "cwd-only lookup"), and a set PATH must not be rewritten.
  if (merged === (currentPath ?? '')) return;
  deps.env['PATH'] = merged;
}

/**
 * Production convenience — apply the probe to `process.env` once per
 * process. Memoised like `detectEnvironmentFromNode`: the login-shell PATH
 * does not change for the lifetime of the process, and repeated
 * `LocalKaos.create()` calls must not re-spawn the shell.
 */
/**
 * Login shell from the OS user database (`/etc/passwd` via getpwuid on
 * Linux, Directory Services on macOS). `userInfo()` throws when the uid
 * has no database entry (e.g. containers running an arbitrary uid), and
 * service accounts may carry `/usr/sbin/nologin` — the latter needs no
 * special casing here because probing it simply fails and degrades
 * silently.
 */
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
