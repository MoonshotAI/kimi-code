/**
 * Environment — cross-platform probe of OS / shell.
 *
 * Detection is a pure function of injected probes (`platform` / `arch` /
 * `release` / `env` / `isFile` / `execFileText`) so the same suite runs
 * identically on any host OS. `detectEnvironmentFromNode()` bundles the Node
 * defaults for production callers.
 *
 * On Windows the probe expects Git Bash (the canonical POSIX shell that
 * ships with Git for Windows). If it cannot be located the function
 * throws `KimiError` with code `shell.git_bash_not_found`; the SDK layer
 * can wrap that into a user-facing install hint. Set `KIMI_SHELL_PATH`
 * to override.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { ErrorCodes, KimiError } from '#/errors';

// `OsKind` carries 'macOS' / 'Linux' / 'Windows' for known platforms and
// falls back to the raw `process.platform` string for unknown ones (e.g.
// 'freebsd'). Typed as `string` so the union isn't inhabited-by-string.
export type OsKind = string;
export type ShellName = 'bash' | 'sh';

export interface Environment {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
}

export interface EnvironmentDeps {
  // Accepts the full Node `Platform` enum plus arbitrary strings for
  // forward-compatible OS kinds.
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly env: Record<string, string | undefined>;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly execFileText: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string | undefined>;
}

const GIT_EXEC_PATH_TIMEOUT_MS = 5_000;

function resolveOsKind(platform: string): OsKind {
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

export async function detectEnvironment(deps: EnvironmentDeps): Promise<Environment> {
  const osKind = resolveOsKind(deps.platform);
  const osArch = deps.arch;
  const osVersion = deps.release;

  if (deps.platform === 'win32') {
    const shellPath = await locateWindowsGitBash(deps);
    return { osKind, osArch, osVersion, shellName: 'bash', shellPath };
  }

  const candidates: readonly string[] = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
  let found: string | undefined;
  for (const p of candidates) {
    if (await deps.isFile(p)) {
      found = p;
      break;
    }
  }
  if (found !== undefined) {
    return { osKind, osArch, osVersion, shellName: 'bash', shellPath: found };
  }
  return { osKind, osArch, osVersion, shellName: 'sh', shellPath: '/bin/sh' };
}

async function locateWindowsGitBash(deps: EnvironmentDeps): Promise<string> {
  const checked: string[] = [];

  const override = deps.env['KIMI_SHELL_PATH']?.trim();
  if (override !== undefined && override.length > 0) {
    checked.push(override);
    if (await deps.isFile(override)) {
      return override;
    }
  }

  const gitExecutables = await findExecutablesOnPath(
    'git.exe',
    deps.env['PATH'],
    deps.platform,
    deps.isFile,
  );

  for (const gitExe of gitExecutables) {
    const inferred = gitBashCandidateFromGitExe(gitExe);
    if (inferred !== undefined) {
      checked.push(inferred);
      if (await deps.isFile(inferred)) {
        return inferred;
      }
    }
  }

  const candidates: string[] = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  const localAppData = deps.env['LOCALAPPDATA']?.trim();
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  }
  for (const candidate of candidates) {
    checked.push(candidate);
    if (await deps.isFile(candidate)) {
      return candidate;
    }
  }

  for (const gitExe of gitExecutables) {
    const gitExecPath = await readGitExecPath(deps, gitExe);
    if (gitExecPath === undefined) {
      continue;
    }
    for (const candidate of gitBashCandidatesFromGitExecPath(gitExecPath)) {
      checked.push(candidate);
      if (await deps.isFile(candidate)) {
        return candidate;
      }
    }
  }

  throw new KimiError(
    ErrorCodes.SHELL_GIT_BASH_NOT_FOUND,
    `Git Bash was not found on this Windows host. Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe. Checked: ${checked.join(', ')}.`,
  );
}

async function readGitExecPath(
  deps: EnvironmentDeps,
  gitExe: string,
): Promise<string | undefined> {
  const stdout = await deps.execFileText(gitExe, ['--exec-path'], GIT_EXEC_PATH_TIMEOUT_MS);
  if (stdout === undefined) return undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const execPath = line.trim();
    if (execPath.length > 0) {
      return execPath;
    }
  }
  return undefined;
}

// Most Git for Windows installs put `git.exe` in `<root>\cmd\git.exe`,
// with bash at `<root>\bin\bash.exe`. Portable installs sometimes put
// both in `<root>\bin\`. Only infer from those anchored layouts; package
// manager shims live elsewhere and must resolve through `git --exec-path`.
function gitBashCandidateFromGitExe(gitExe: string): string | undefined {
  const normalizedGitExe = nodePath.win32.normalize(normalizeWindowsPath(gitExe));
  const gitDir = nodePath.win32.dirname(normalizedGitExe);
  const gitDirName = nodePath.win32.basename(gitDir).toLowerCase();
  if (gitDirName !== 'cmd' && gitDirName !== 'bin') {
    return undefined;
  }
  return nodePath.win32.normalize(
    nodePath.win32.join(nodePath.win32.dirname(gitDir), 'bin', 'bash.exe'),
  );
}

function gitBashCandidatesFromGitExecPath(execPath: string): readonly string[] {
  const normalized = nodePath.win32.normalize(normalizeWindowsPath(execPath));
  const parts = normalized.split('\\');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i]?.toLowerCase();
    if (segment === 'mingw32' || segment === 'mingw64') {
      const root = parts.slice(0, i).join('\\');
      if (root.length > 0) {
        return [nodePath.win32.join(root, 'bin', 'bash.exe')];
      }
    }
  }

  return [nodePath.win32.normalize(nodePath.win32.join(normalized, '..', '..', 'bin', 'bash.exe'))];
}

function normalizeWindowsPath(path: string): string {
  return path.replaceAll('/', '\\');
}

function dedupeWindowsPaths(paths: readonly string[]): readonly string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const key = normalizeWindowsPath(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(path);
  }
  return deduped;
}

/**
 * Production convenience — derive the deps bag from Node's ambient surface.
 */
export async function detectEnvironmentFromNode(): Promise<Environment> {
  const platform = process.platform;
  const env = process.env as Record<string, string | undefined>;
  const isFile = async (path: string): Promise<boolean> => {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  return detectEnvironment({
    platform,
    arch: process.arch,
    release: nodeOs.release(),
    env,
    isFile,
    execFileText,
  });
}

async function findExecutablesOnPath(
  name: string,
  pathEnv: string | undefined,
  platform: string,
  isFile: (p: string) => Promise<boolean>,
): Promise<readonly string[]> {
  if (pathEnv === undefined || pathEnv.length === 0) return [];
  const listSep = platform === 'win32' ? ';' : ':';
  const dirSep = platform === 'win32' ? '\\' : '/';
  const paths: string[] = [];
  for (const rawDir of pathEnv.split(listSep)) {
    const dir = rawDir.trim();
    if (dir.length === 0) continue;
    const candidate = dir.endsWith(dirSep) ? `${dir}${name}` : `${dir}${dirSep}${name}`;
    if (await isFile(candidate)) {
      paths.push(candidate);
    }
  }
  return platform === 'win32' ? dedupeWindowsPaths(paths) : paths;
}

async function execFileText(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    nodeExecFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
