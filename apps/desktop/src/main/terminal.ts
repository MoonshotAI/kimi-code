// Native embedded terminal (desktop-only): PTYs hosted by the Electron main
// process via node-pty (design: docs/plans/2026-07-27-desktop-native-terminal.md).

import { randomUUID } from 'node:crypto';
import { join as joinWin32 } from 'node:path/win32';

/** Minimal structural slice of node-pty's IPty the manager needs. */
export interface PtyProcess {
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
  /** Executable basename of the spawned shell (display label, e.g. "zsh"). */
  shell: string;
  cwd: string;
}

export interface TerminalManagerDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** OS locale for the macOS LANG fallback below. A function is read lazily
   *  at each create — app.getLocale() is only valid after app-ready, which is
   *  later than handler registration. */
  locale?: string | (() => string);
  spawnPty?: SpawnPty;
  pathExists?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
  pushOutput?: (id: string, data: string) => void;
  pushExit?: (id: string, exitCode: number | null) => void;
}

// --- default shell resolution --------------------------------------------------

/** Default shell per platform. macOS/Linux: the user's login shell ($SHELL,
 *  already resolved by the shell-env probe) with /bin/zsh as fallback.
 *  Windows: pwsh (PowerShell 7) → Windows PowerShell → cmd. COMSPEC is never
 *  the FIRST choice — it is cmd.exe on practically every machine. */
export function resolveDefaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean,
): string {
  if (platform === 'win32') {
    // Windows path math stays win32 even on a POSIX host (path.join/delimiter
    // would produce mixed separators the pathExists probe can't match).
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
    const pwsh = joinWin32(programFiles, 'PowerShell', '7', 'pwsh.exe');
    if (pathExists(pwsh)) return pwsh;
    // pwsh installed via other channels (MSIX/winget/shim) lands on PATH.
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

/** GUI launches (Finder/launchd) carry no LANG/LC_* — terminals then render
 *  UTF-8 (Chinese text, TUI tools) as garbage. When nothing is set, pin LANG
 *  from the OS locale (VS Code does the same). */
export function defaultShellEnv(
  platform: NodeJS.Platform,
  locale: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // server.ts pins KIMI_CODE_REGION_MARKER=off on the Electron process so
    // the embedded kap-server ignores a CLI install-channel marker — but the
    // server re-reads it on every call, so it must stay on our process; here
    // we only keep it from leaking into every interactive shell (a user-run
    // CLI inside the terminal must do its own region resolution).
    if (key === 'KIMI_CODE_REGION_MARKER') continue;
    if (typeof value === 'string') clean[key] = value;
  }
  if (platform !== 'win32' && clean['LANG'] === undefined && clean['LC_ALL'] === undefined) {
    clean['LANG'] = locale.toLowerCase().startsWith('zh') ? 'zh_CN.UTF-8' : 'en_US.UTF-8';
  }
  return clean;
}

// --- manager -------------------------------------------------------------------

const MAX_DIMENSION = 500;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Upper bound on one input payload; anything bigger is a bug or abuse. */
const MAX_INPUT_CHARS = 1_000_000;

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DIMENSION, Math.max(1, Math.round(value)));
}

// Renderer generations: navigation bumps this; the did-finish-load sweep
// kills only PTYs from BEFORE it (sparing the fresh page's own spawns).
let currentGeneration = 0;

export interface TerminalManager {
  create(options?: { cwd?: string; cols?: number; rows?: number }): Promise<NativeTerminalInfo>;
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  close(id: string): void;
  killAll(): void;
  /** Kill only PTYs created before the current generation (renderer reload). */
  killStale(): void;
  /** Current renderer generation — compare across an await to spot a reload. */
  generation(): number;
  /** Live terminal count (tests + diagnostics). */
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
  let spawnPty: SpawnPty | null = deps.spawnPty ?? null;

  async function loadSpawn(): Promise<SpawnPty> {
    if (spawnPty !== null) return spawnPty;
    // Lazy-load node-pty: a broken native addon must fail one terminal, not main.
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
    async create(options = {}) {
      // Capture the generation NOW — a navigation mid-spawn makes this PTY stale.
      const gen = currentGeneration;
      const spawn = await loadSpawn();
      const shellPath = resolveDefaultShell(platform, env, pathExists);
      const cwd = resolveCwd(options.cwd);
      const cols = clampDimension(options.cols, DEFAULT_COLS);
      const rows = clampDimension(options.rows, DEFAULT_ROWS);
      const pty = spawn(shellPath, [], {
        name: 'xterm-256color',
        cwd,
        env: defaultShellEnv(platform, readLocale(), env),
        cols,
        rows,
      });
      if (gen !== currentGeneration) {
        // The sweep already ran, so this orphan has no owner — kill it.
        try {
          pty.kill();
        } catch {
          // Best effort.
        }
        throw new Error('terminal-create superseded by a renderer navigation');
      }
      const info: NativeTerminalInfo = {
        id: randomUUID(),
        shell: shellLabel(shellPath),
        cwd,
      };
      terminals.set(info.id, { pty, info, gen });
      // After close()/killAll(), a dying PTY's late data/exit must not be pushed.
      pty.onData((data) => {
        if (terminals.has(info.id)) {
          pushOutput(info.id, data);
        }
      });
      pty.onExit(({ exitCode }) => {
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
      } catch {
        // The child died in the meantime (exit not yet delivered) — drop.
      }
    },

    resize(id, cols, rows) {
      const entry = terminals.get(id);
      if (entry === undefined) return;
      try {
        entry.pty.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS));
      } catch {
        // Same dead-child race as write — conpty's resize can throw here.
      }
    },

    close(id) {
      const entry = terminals.get(id);
      if (entry === undefined) return;
      terminals.delete(id);
      try {
        entry.pty.kill();
      } catch {
        // Already dead — close stays idempotent.
      }
    },

    killAll() {
      // Deleting during Map iteration is well-defined.
      for (const id of terminals.keys()) {
        const entry = terminals.get(id);
        terminals.delete(id);
        try {
          entry?.pty.kill();
        } catch {
          // Best-effort sweep on shutdown / renderer replacement.
        }
      }
    },

    killStale() {
      for (const [id, entry] of terminals) {
        if (entry.gen >= currentGeneration) continue;
        terminals.delete(id);
        try {
          entry.pty.kill();
        } catch {
          // Best-effort sweep.
        }
      }
    },

    generation() {
      return currentGeneration;
    },

    size() {
      return terminals.size;
    },
  };
}

// --- singleton + lifecycle -------------------------------------------------------

let manager: TerminalManager | null = null;

/** Install the shared manager (ipc.ts, at startup). Deps are fixed for the
 *  app's lifetime; tests use createTerminalManager directly. */
export function initTerminalManager(deps: TerminalManagerDeps): void {
  manager = createTerminalManager(deps);
}

export function getTerminalManager(): TerminalManager {
  if (manager === null) {
    manager = createTerminalManager();
  }
  return manager;
}

/** Kill every PTY (app quit, renderer crash — terminal state does not
 *  survive a renderer replacement, so nothing is left orphaned). */
export function killAllTerminals(): void {
  manager?.killAll();
}

/** Mark a fresh renderer generation (cross-document navigation start). */
export function bumpTerminalGeneration(): void {
  currentGeneration += 1;
}

/** Sweep only the previous generation's PTYs (did-finish-load): terminals
 *  the NEW page already spawned survive. */
export function killStaleTerminals(): void {
  manager?.killStale();
}
