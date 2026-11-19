import { readTerminalProcesses, terminalActivityOf, type ProcessEntry } from './processes';
import {
  normalizeTerminalSshTarget,
  type NativeTerminalCreateOptions,
  type NativeTerminalSshTarget,
  type TerminalActivity,
} from '../../shared/terminal-activity';

import { randomUUID } from 'node:crypto';
import { join as joinWin32 } from 'node:path/win32';

export type { NativeTerminalCreateOptions, NativeTerminalSshTarget };

export interface PtyProcess {
  readonly pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: {
    name: string;
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
  },
) => PtyProcess;

export interface NativeTerminalInfo {
  id: string;
  shell: string;
  cwd: string;
}

export interface TerminalManagerDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  locale?: string | (() => string);
  spawnPty?: SpawnPty;
  readProcesses?: () => Promise<ProcessEntry[]>;
  pathExists?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
  pushOutput?: (id: string, data: string) => void;
  pushExit?: (id: string, exitCode: number | null) => void;
}

export function resolveDefaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean,
): string {
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
    const pwsh = joinWin32(programFiles, 'PowerShell', '7', 'pwsh.exe');
    if (pathExists(pwsh)) return pwsh;
    const pathValue = env['PATH'] ?? env['Path'] ?? '';
    for (const dir of pathValue.split(';')) {
      if (dir === '') continue;
      const candidate = joinWin32(dir, 'pwsh.exe');
      if (pathExists(candidate)) return candidate;
    }
    const systemRoot = env['SystemRoot'] ?? 'C:\\Windows';
    const powershell = joinWin32(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (pathExists(powershell)) return powershell;
    return env['COMSPEC'] ?? 'cmd.exe';
  }
  if (typeof env['SHELL'] === 'string' && env['SHELL'] !== '') return env['SHELL'];
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

export function defaultShellEnv(
  platform: NodeJS.Platform,
  locale: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'KIMI_CODE_REGION_MARKER') continue;
    if (typeof value === 'string') clean[key] = value;
  }
  if (platform !== 'win32' && clean['LANG'] === undefined && clean['LC_ALL'] === undefined) {
    clean['LANG'] = locale.toLowerCase().startsWith('zh') ? 'zh_CN.UTF-8' : 'en_US.UTF-8';
  }
  return clean;
}

const MAX_DIMENSION = 500;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_INPUT_CHARS = 1_000_000;

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(1, Math.round(value)));
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildSshTerminalArgs(ssh: NativeTerminalSshTarget, cwd: string | undefined): string[] {
  const args = [
    '-t',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
  ];
  if (ssh.identityFile !== undefined && ssh.identityFile !== '') {
    args.push('-i', ssh.identityFile, '-o', 'IdentitiesOnly=yes');
  }
  args.push('--', ssh.host);
  if (cwd !== undefined && cwd !== '') {
    args.push(`cd ${shQuote(cwd)}; exec "\${SHELL:-/bin/sh}" -l`);
  }
  return args;
}

let currentGeneration = 0;

export interface TerminalManager {
  inspect(ids: string[]): Promise<TerminalActivity[]>;
  create(options?: NativeTerminalCreateOptions): Promise<NativeTerminalInfo>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  killAll(): void;
  killStale(): void;
  waitForExits(timeoutMs: number): Promise<boolean> | null;
  generation(): number;
  size(): number;
}

export function createTerminalManager(deps: TerminalManagerDeps = {}): TerminalManager {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? env['HOME'] ?? env['USERPROFILE'] ?? '/';
  const locale = deps.locale ?? 'en';
  const readLocale = (): string => (typeof locale === 'function' ? locale() : locale);
  const pathExists = deps.pathExists ?? (() => false);
  const isDirectory = deps.isDirectory ?? (() => false);
  const pushOutput = deps.pushOutput ?? (() => {});
  const pushExit = deps.pushExit ?? (() => {});

  const terminals = new Map<string, { pty: PtyProcess; info: NativeTerminalInfo; gen: number }>();
  const livePtys = new Set<PtyProcess>();
  const exitWaiters = new Set<() => void>();
  let spawnPty: SpawnPty | null = deps.spawnPty ?? null;

  function markExited(pty: PtyProcess): void {
    livePtys.delete(pty);
    if (livePtys.size > 0) return;
    for (const notify of exitWaiters) notify();
  }

  async function loadSpawn(): Promise<SpawnPty> {
    if (spawnPty !== null) return spawnPty;
    const mod = (await import('node-pty')) as typeof import('node-pty');
    spawnPty = (file, args, options) => mod.spawn(file, args, options);
    return spawnPty;
  }

  function resolveCwd(cwd: string | undefined): string {
    if (typeof cwd === 'string' && cwd !== '' && isDirectory(cwd)) return cwd;
    return homeDir;
  }

  function shellLabel(shellPath: string): string {
    const normalized = shellPath.replace(/\\/g, '/');
    const base = normalized.slice(normalized.lastIndexOf('/') + 1);
    return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
  }

  return {
    async inspect(ids) {
      const requested = ids.map(id => ({ id, entry: terminals.get(id) }));
      let processes: ProcessEntry[] | null = null;
      if (requested.some(item => item.entry !== undefined)) {
        try { processes = await (deps.readProcesses ?? (() => readTerminalProcesses(platform)))(); }
        catch { processes = null; }
      }
      return requested.map(({ id, entry }) => {
        if (!entry || terminals.get(id) !== entry) return { id, state: 'exited', binary: '', cwd: '', processes: [] };
        return terminalActivityOf({ ...entry.info, pid: entry.pty.pid }, processes);
      });
    },

    async create(options = {}) {
      const gen = currentGeneration;
      const spawn = await loadSpawn();
      const ssh = normalizeTerminalSshTarget(options.ssh);
      const file = ssh !== undefined ? 'ssh' : resolveDefaultShell(platform, env, pathExists);
      const args = ssh !== undefined ? buildSshTerminalArgs(ssh, options.cwd) : [];
      const spawnCwd = ssh !== undefined ? homeDir : resolveCwd(options.cwd);
      const reportedCwd = ssh !== undefined ? (options.cwd && options.cwd !== '' ? options.cwd : '~') : spawnCwd;
      const cols = clampDimension(options.cols, DEFAULT_COLS);
      const rows = clampDimension(options.rows, DEFAULT_ROWS);
      const pty = spawn(file, args, {
        name: 'xterm-256color',
        cwd: spawnCwd,
        env: defaultShellEnv(platform, readLocale(), env),
        cols,
        rows,
      });
      livePtys.add(pty);
      if (gen !== currentGeneration) {
        pty.onExit(() => markExited(pty));
        try {
          pty.kill();
        } catch {}
        throw new Error('terminal-create superseded by a renderer navigation');
      }
      const info: NativeTerminalInfo = {
        id: randomUUID(),
        shell: shellLabel(file),
        cwd: reportedCwd,
      };
      terminals.set(info.id, { pty, info, gen });
      pty.onData((data) => {
        if (terminals.has(info.id)) {
          pushOutput(info.id, data);
        }
      });
      pty.onExit(({ exitCode }) => {
        markExited(pty);
        if (terminals.delete(info.id)) {
          pushExit(info.id, exitCode);
        }
      });
      return info;
    },

    write(id, data) {
      const entry = terminals.get(id);
      if (entry === undefined || typeof data !== 'string' || data === '') return;
      try {
        entry.pty.write(data.length > MAX_INPUT_CHARS ? data.slice(0, MAX_INPUT_CHARS) : data);
      } catch {}
    },

    resize(id, cols, rows) {
      const entry = terminals.get(id);
      if (entry === undefined) return;
      try {
        entry.pty.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS));
      } catch {}
    },

    close(id) {
      const entry = terminals.get(id);
      if (entry === undefined) return;
      terminals.delete(id);
      try {
        entry.pty.kill();
      } catch {}
    },

    killAll() {
      for (const id of terminals.keys()) {
        const entry = terminals.get(id);
        terminals.delete(id);
        try {
          entry?.pty.kill();
        } catch {}
      }
    },

    killStale() {
      for (const [id, entry] of terminals) {
        if (entry.gen >= currentGeneration) continue;
        terminals.delete(id);
        try {
          entry.pty.kill();
        } catch {}
      }
    },

    waitForExits(timeoutMs) {
      if (livePtys.size === 0) return null;
      return new Promise((resolve) => {
        const notify = (): void => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        function finish(drained: boolean): void {
          clearTimeout(timer);
          exitWaiters.delete(notify);
          resolve(drained);
        }
        exitWaiters.add(notify);
      });
    },

    generation() {
      return currentGeneration;
    },

    size() {
      return terminals.size;
    },
  };
}

let manager: TerminalManager | null = null;

export function initTerminalManager(deps: TerminalManagerDeps): void {
  manager = createTerminalManager(deps);
}

export function getTerminalManager(): TerminalManager {
  if (manager === null) {
    manager = createTerminalManager();
  }
  return manager;
}

export function killAllTerminals(): void {
  manager?.killAll();
}

export function waitForTerminalExits(timeoutMs: number): Promise<boolean> | null {
  return manager?.waitForExits(timeoutMs) ?? null;
}

export function bumpTerminalGeneration(): void {
  currentGeneration += 1;
}

export function killStaleTerminals(): void {
  manager?.killStale();
}
