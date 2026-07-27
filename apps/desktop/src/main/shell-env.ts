import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

import { log } from './log';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

type Env = Record<string, string | undefined>;

// `KIMI_*` configures the CLI (API key, debug flags); the desktop app has its
// own auth and settings and must not inherit them silently. The rest is
// terminal-session noise interactive shells export.
const DENY_EXACT = new Set([
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'TERMINFO',
  'COLORTERM',
  'ZSH',
  'OH_MY_ZSH',
  'HISTFILE',
  'HISTSIZE',
  'SAVEHIST',
]);
const DENY_PREFIX = [/^KIMI_/, /^ZSH_/, /^ITERM_/, /^BASH_FUNC_/, /^__CF/];

function isDenied(key: string): boolean {
  return DENY_EXACT.has(key) || DENY_PREFIX.some((re) => re.test(key));
}

/**
 * Extract the env the probe printed as a JSON object between two marks
 * (profile noise lands outside them). JSON keeps multi-line values and
 * `KEY=`-lookalikes unambiguous. Returns {} when the marks or valid JSON are
 * missing.
 */
export function parseShellEnvDump(stdout: string, mark: string): Record<string, string> {
  // dotAll: JSON.stringify emits U+2028/U+2029 raw, and `.` must span them.
  const match = new RegExp(`${mark}(\\{.*\\})${mark}`, 's').exec(stdout);
  if (match === null || match[1] === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Fill variables launchd never set, and append the absolute PATH entries the
 * current PATH lacks. Returns the names of what changed, for logging.
 */
export function mergeShellEnv(target: Env, shellEnv: Record<string, string>): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === 'PATH') {
      if (mergePathEntries(target, value)) applied.push('PATH');
      continue;
    }
    if (isDenied(key) || target[key] !== undefined) continue;
    target[key] = value;
    applied.push(key);
  }
  return applied;
}

function mergePathEntries(target: Env, shellPath: string): boolean {
  const current = target['PATH'] ?? '';
  const seen = new Set(current.split(':').filter((entry) => entry.length > 0));
  const additions: string[] = [];
  for (const entry of shellPath.split(':')) {
    if (!entry.startsWith('/') || seen.has(entry)) continue;
    seen.add(entry);
    additions.push(entry);
  }
  if (additions.length === 0) return false;
  target['PATH'] = current.length === 0 ? additions.join(':') : `${current}:${additions.join(':')}`;
  return true;
}

function userShell(): string | undefined {
  const fromEnv = process.env['SHELL']?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    const shell = userInfo().shell;
    return shell === null || shell.length === 0 ? undefined : shell;
  } catch {
    return undefined;
  }
}

function execShellEnvDump(shell: string, mark: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    // ELECTRON_RUN_AS_NODE turns the app binary into a Node runtime, so the
    // dump needs no node install on the user's PATH; the binary path goes
    // through the env (filtered from the import by the KIMI_* denylist)
    // instead of the command string, sidestepping shell quoting. detached
    // makes the child a process-group leader: a stuck probe (interactive
    // bash ignores SIGTERM, hence SIGKILL) takes the whole group down — a
    // profile's background grandchildren can hold the pipes and outlive the
    // shell. stdin is /dev/null so a profile `read` hits EOF; stderr is
    // ignored so a noisy profile cannot fill the pipe and block the child.
    const child = spawn(
      shell,
      [
        '-l',
        '-i',
        '-c',
        `"$KIMI_PROBE_BIN" -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`,
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1',
          KIMI_PROBE_BIN: process.execPath,
        },
      },
    );
    let out = '';
    let settled = false;
    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Group already gone.
      }
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeKill = undefined;
      fn();
    };
    const timer = setTimeout(() => {
      killGroup();
      settle(() => reject(new Error(`shell env dump exceeded ${PROBE_TIMEOUT_MS}ms`)));
    }, PROBE_TIMEOUT_MS);
    activeKill = killGroup;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > MAX_OUTPUT_BYTES) {
        killGroup();
        settle(() => reject(new Error('shell env dump exceeded max output')));
      }
    });
    child.on('error', (error) => settle(() => reject(error)));
    child.on('close', () => {
      // A profile that exits non-zero can still have printed a usable dump.
      const env = parseShellEnvDump(out, mark);
      if (Object.keys(env).length > 0) {
        settle(() => resolve(env));
      } else {
        settle(() => reject(new Error('env mark missing from shell output')));
      }
    });
  });
}

let activeKill: (() => void) | undefined;

/** SIGKILL the probe's process group if it is still running (app quitting). */
export function stopShellEnvProbe(): void {
  activeKill?.();
}

async function resolveShellEnv(): Promise<void> {
  try {
    if (process.platform === 'win32') return;
    const disabled = process.env['KIMI_DESKTOP_NO_SHELL_ENV'];
    if (disabled !== undefined && disabled !== '' && disabled !== '0') {
      log.info('shell env probe disabled via KIMI_DESKTOP_NO_SHELL_ENV');
      return;
    }
    const shell = userShell();
    if (shell === undefined) {
      log.warn('shell env probe skipped: no resolvable user shell');
      return;
    }
    const mark = randomUUID().replaceAll('-', '').slice(0, 12);
    const shellEnv = await execShellEnvDump(shell, mark);
    // Injected for the dump; must not leak into the merge below.
    delete shellEnv['ELECTRON_RUN_AS_NODE'];
    delete shellEnv['ELECTRON_NO_ATTACH_CONSOLE'];
    const applied = mergeShellEnv(process.env, shellEnv);
    log.info(`shell env probe (${shell}) imported ${applied.length}: ${applied.join(', ')}`);
  } catch (error) {
    log.warn(`shell env probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let probePromise: Promise<void> | undefined;

/**
 * Kick off the shell env probe (GUI launches inherit launchd's minimal env).
 * Memoized and never rejects — callers may fire-and-forget at startup and
 * await later where a complete process.env is required.
 */
export function startShellEnvProbe(): Promise<void> {
  probePromise ??= resolveShellEnv();
  return probePromise;
}
