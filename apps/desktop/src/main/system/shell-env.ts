import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

import { defaultMainLogPath, initMainLogging, log } from '../diagnostics/log';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

type Env = Record<string, string | undefined>;

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
const DENY_PREFIX = [/^ZSH_/, /^ITERM_/, /^BASH_FUNC_/, /^__CF/, /^DYLD_/, /^LD_/];

const DENY_KIMI_EXACT = new Set([
  'KIMI_CODE_PASSWORD',
  'KIMI_CODE_CUSTOM_HEADERS',
  'KIMI_BASE_URL',
  'KIMI_WEB_SEARCH_BASE_URL',
  'KIMI_WEB_FETCH_BASE_URL',
  'KIMI_CODE_CORS_ORIGINS',
  'KIMI_CODE_ALLOWED_HOSTS',
  'KIMI_CODE_DISABLE_HOST_CHECK',
  'KIMI_DISABLE_OAUTH_LOCK',
  'KIMI_SERVER_URL',
  'KIMI_RENDERER_DEV_URL',
  'KIMI_DESKTOP_NO_SHELL_ENV',
  'KIMI_PLUGIN_ROOT',
  'KIMI_WSL_CLIPBOARD_IMAGE_PATH',
]);
const DENY_KIMI_PATTERN = [/^KIMI_MODEL_/, /_API_KEY$/];

function isDenied(key: string): boolean {
  if (DENY_EXACT.has(key) || DENY_PREFIX.some((re) => re.test(key))) return true;
  if (key.startsWith('KIMI_')) {
    return DENY_KIMI_EXACT.has(key) || DENY_KIMI_PATTERN.some((re) => re.test(key));
  }
  return false;
}

export function parseShellEnvDump(stdout: string, mark: string): Record<string, string> {
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
      } catch {}
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

export function stopShellEnvProbe(): void {
  activeKill?.();
}

async function resolveShellEnv(): Promise<void> {
  const startedAt = Date.now();
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
    delete shellEnv['ELECTRON_RUN_AS_NODE'];
    delete shellEnv['ELECTRON_NO_ATTACH_CONSOLE'];
    delete shellEnv['KIMI_PROBE_BIN'];
    const applied = mergeShellEnv(process.env, shellEnv);
    if (applied.includes('KIMI_CODE_HOME')) {
      initMainLogging();
      log.info(`main log re-targeted to ${defaultMainLogPath()}`);
    }
    log.info(`shell env probe (${shell}) took=${Date.now() - startedAt}ms imported ${applied.length}: ${applied.join(', ')}`);
  } catch (error) {
    log.warn(`shell env probe failed after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let probePromise: Promise<void> | undefined;

export function startShellEnvProbe(): Promise<void> {
  probePromise ??= resolveShellEnv();
  return probePromise;
}
