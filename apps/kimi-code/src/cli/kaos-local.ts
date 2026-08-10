/**
 * Local kaos subset — the filesystem + environment surface the CLI host
 * consumes from `@moonshot-ai/kaos` (G-3 consumption cutover: the kaos
 * package is retired, the host still needs the cwd-scoped fs helpers and the
 * OS/shell probe for the coder system prompt).
 *
 * Only the methods `rust-engine.ts` / `system-prompt-local.ts` actually use
 * are ported: `create` / `withCwd` / `normpath` / `gethome` / `getcwd` /
 * `stat` / `iterdir` / `readText` plus the `osEnv` probe. The shell probe is
 * best-effort — a missing Git Bash degrades to `sh` instead of throwing
 * (kaos threw `KaosShellNotFoundError`; the host only renders the shell name
 * into the system prompt).
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readdir, readFile, stat } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { isAbsolute, join, normalize } from 'pathe';

/** Minimal kaos Environment shape the coder renderer reads. */
export interface LocalOsEnv {
  readonly osKind: string;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: 'bash' | 'sh';
  readonly shellPath: string;
}

/** POSIX stat shape (kaos `StatResult` parity). */
export interface LocalStatResult {
  readonly stMode: number;
  readonly stIno: number;
  readonly stDev: number;
  readonly stNlink: number;
  readonly stUid: number;
  readonly stGid: number;
  readonly stSize: number;
  readonly stAtime: number;
  readonly stMtime: number;
  readonly stCtime: number;
}

const isWindows = process.platform === 'win32';

function resolveOsKind(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate a bash for the shell probe: `KIMI_SHELL_PATH`, Git for Windows
 *  standard installs, then the POSIX candidates. Best-effort — `sh` fallback. */
async function locateBash(): Promise<{ shellName: 'bash' | 'sh'; shellPath: string }> {
  if (isWindows) {
    const override = process.env['KIMI_SHELL_PATH']?.trim();
    if (override !== undefined && override.length > 0 && (await isFile(override))) {
      return { shellName: 'bash', shellPath: override };
    }
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    ];
    const localAppData = process.env['LOCALAPPDATA']?.trim();
    if (localAppData !== undefined && localAppData.length > 0) {
      candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
      candidates.push(`${localAppData}\\Programs\\Git\\usr\\bin\\bash.exe`);
    }
    for (const candidate of candidates) {
      if (await isFile(candidate)) {
        return { shellName: 'bash', shellPath: candidate };
      }
    }
    return { shellName: 'sh', shellPath: 'sh' };
  }
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    if (await isFile(candidate)) {
      return { shellName: 'bash', shellPath: candidate };
    }
  }
  return { shellName: 'sh', shellPath: '/bin/sh' };
}

/** Probe the OS / shell once and memoise (kaos `detectEnvironmentFromNode`
 *  parity — the environment is immutable for the process lifetime). */
let detectedEnv: Promise<LocalOsEnv> | undefined;

export function detectLocalEnvironment(): Promise<LocalOsEnv> {
  if (detectedEnv !== undefined) return detectedEnv;
  detectedEnv = (async () => {
    const shell = await locateBash();
    return {
      osKind: resolveOsKind(process.platform),
      osArch: process.arch,
      osVersion: release(),
      shellName: shell.shellName,
      shellPath: shell.shellPath,
    };
  })();
  return detectedEnv;
}

/**
 * A cwd-scoped local filesystem handle — the kaos `LocalKaos` subset the host
 * consumes. Each instance carries its own working directory; `withCwd` returns
 * a new instance without touching `process.cwd()`.
 */
export class LocalKaos {
  readonly name = 'local';
  readonly osEnv: LocalOsEnv;
  private readonly _cwd: string;

  private constructor(osEnv: LocalOsEnv, cwd: string) {
    this.osEnv = osEnv;
    this._cwd = normalize(cwd);
  }

  static async create(): Promise<LocalKaos> {
    return new LocalKaos(await detectLocalEnvironment(), process.cwd());
  }

  withCwd(cwd: string): LocalKaos {
    return new LocalKaos(this.osEnv, cwd);
  }

  pathClass(): 'posix' | 'win32' {
    return isWindows ? 'win32' : 'posix';
  }

  normpath(path: string): string {
    return normalize(path);
  }

  gethome(): string {
    return normalize(homedir());
  }

  getcwd(): string {
    return this._cwd;
  }

  private _resolvePath(path: string): string {
    if (isAbsolute(path)) return normalize(path);
    return join(this._cwd, path);
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<LocalStatResult> {
    const resolved = this._resolvePath(path);
    const followSymlinks = options?.followSymlinks ?? true;
    const s = followSymlinks ? await stat(resolved) : await lstat(resolved);
    return {
      stMode: s.mode,
      stIno: s.ino,
      stDev: s.dev,
      stNlink: s.nlink,
      stUid: s.uid,
      stGid: s.gid,
      stSize: s.size,
      stAtime: s.atimeMs / 1000,
      stMtime: s.mtimeMs / 1000,
      stCtime: isWindows ? s.birthtimeMs / 1000 : s.ctimeMs / 1000,
    };
  }

  async *iterdir(path: string): AsyncGenerator<string> {
    const resolved = this._resolvePath(path);
    const entries = await readdir(resolved);
    for (const entry of entries) {
      yield join(resolved, entry);
    }
  }

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' },
  ): Promise<string> {
    const resolved = this._resolvePath(path);
    const encoding = options?.encoding ?? 'utf-8';
    const errors = options?.errors ?? 'strict';
    const data = await readFile(resolved);
    if (errors === 'ignore') {
      return data.toString(encoding).replaceAll('\uFFFD', '');
    }
    if (errors === 'replace') {
      return data.toString(encoding);
    }
    return data.toString(encoding);
  }
}

/** `execFile` text helper for the shell probe (kaos `execFileText` parity). */
export function execFileText(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve();
          return;
        }
        resolve(stdout);
      },
    );
  });
}