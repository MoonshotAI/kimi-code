/**
 * `_base/execEnv` (L0) — OS / shell probe.
 *
 * Detects the host operating system, architecture, kernel release, and a
 * usable POSIX shell path. The result is a pure function of injected probes
 * (`platform` / `arch` / `release` / `env` / `isFile` / `execFileText`) so the
 * same suite runs identically on any host OS. `probeHostEnvironmentFromNode()`
 * bundles the Node defaults for production callers and memoises the promise.
 *
 * On Windows the probe expects bash from Git for Windows or MSYS2. If it
 * cannot be located the function throws a plain `Error` with the checked paths
 * in the message; the App-scope host-environment service catches that at first
 * resolution. Set `KIMI_SHELL_PATH` to override.
 *
 * Vendored from `@moonshot-ai/kaos` `environment.ts` — kept as a pure helper
 * with no DI dependencies.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

export type OsKind = string;
export type ShellName = 'bash' | 'sh';
export type PathClass = 'posix' | 'win32';

export interface HostEnvironmentInfo {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
  readonly pathClass: PathClass;
  readonly homeDir: string;
}

export interface HostEnvironmentProbeDeps {
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly homeDir: string;
  readonly env: Record<string, string | undefined>;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly execFileText: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string | undefined>;
}

const GIT_EXEC_PATH_TIMEOUT_MS = 5_000;

const MINGW_PREFIX_SET: ReadonlySet<string> = new Set([
  'mingw32',
  'mingw64',
  'ucrt64',
  'clang64',
  'clangarm64',
]);

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

export async function probeHostEnvironment(
  deps: HostEnvironmentProbeDeps,
): Promise<HostEnvironmentInfo> {
  const osKind = resolveOsKind(deps.platform);
  const osArch = deps.arch;
  const osVersion = deps.release;
  const pathClass: PathClass = deps.platform === 'win32' ? 'win32' : 'posix';

  if (deps.platform === 'win32') {
    const shellPath = await locateWindowsGitBash(deps);
    return {
      osKind,
      osArch,
      osVersion,
      shellName: 'bash',
      shellPath,
      pathClass,
      homeDir: deps.homeDir,
    };
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
    return {
      osKind,
      osArch,
      osVersion,
      shellName: 'bash',
      shellPath: found,
      pathClass,
      homeDir: deps.homeDir,
    };
  }
  return {
    osKind,
    osArch,
    osVersion,
    shellName: 'sh',
    shellPath: '/bin/sh',
    pathClass,
    homeDir: deps.homeDir,
  };
}

async function locateWindowsGitBash(deps: HostEnvironmentProbeDeps): Promise<string> {
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
    const inferred = gitBashCandidatesFromGitExe(gitExe);
    if (inferred !== undefined) {
      for (const candidate of inferred) {
        checked.push(candidate);
        if (await deps.isFile(candidate)) {
          return candidate;
        }
      }
    }

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

  const candidates: string[] = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ];
  const localAppData = deps.env['LOCALAPPDATA']?.trim();
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
    candidates.push(`${localAppData}\\Programs\\Git\\usr\\bin\\bash.exe`);
  }
  for (const candidate of candidates) {
    checked.push(candidate);
    if (await deps.isFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Git Bash was not found on this Windows host. Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe. Checked: ${checked.join(', ')}.`,
  );
}

async function readGitExecPath(
  deps: HostEnvironmentProbeDeps,
  gitExe: string,
): Promise<string | undefined> {
  if (deps.platform === 'win32' && !isAbsoluteWindowsPath(gitExe)) return undefined;

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

function gitBashCandidatesFromGitExe(gitExe: string): readonly string[] | undefined {
  const normalizedGitExe = nodePath.win32.normalize(normalizeWindowsPath(gitExe));
  const gitDir = nodePath.win32.dirname(normalizedGitExe);
  const gitDirName = nodePath.win32.basename(gitDir).toLowerCase();
  if (gitDirName !== 'cmd' && gitDirName !== 'bin') {
    return undefined;
  }
  return gitBashCandidatesFromGitRoot(nodePath.win32.dirname(gitDir));
}

function gitBashCandidatesFromGitExecPath(execPath: string): readonly string[] {
  const normalized = nodePath.win32.normalize(normalizeWindowsPath(execPath));
  const parts = normalized.split('\\');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i]?.toLowerCase();
    if (segment !== undefined && MINGW_PREFIX_SET.has(segment)) {
      const root = parts.slice(0, i).join('\\');
      if (root.length > 0) {
        return gitBashCandidatesFromGitRoot(root);
      }
    }
  }

  return gitBashCandidatesFromGitRoot(nodePath.win32.join(normalized, '..', '..'));
}

function gitBashCandidatesFromGitRoot(root: string): readonly string[] {
  return [
    nodePath.win32.normalize(nodePath.win32.join(root, 'bin', 'bash.exe')),
    nodePath.win32.normalize(nodePath.win32.join(root, 'usr', 'bin', 'bash.exe')),
  ];
}

function normalizeWindowsPath(path: string): string {
  return path.replaceAll('/', '\\');
}

function isAbsoluteWindowsPath(path: string): boolean {
  return nodePath.win32.isAbsolute(normalizeWindowsPath(path));
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

let cachedProbe: Promise<HostEnvironmentInfo> | undefined;

export function probeHostEnvironmentFromNode(): Promise<HostEnvironmentInfo> {
  if (cachedProbe !== undefined) return cachedProbe;
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
  cachedProbe = probeHostEnvironment({
    platform,
    arch: process.arch,
    release: nodeOs.release(),
    homeDir: nodeOs.homedir(),
    env,
    isFile,
    execFileText,
  });
  return cachedProbe;
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
    if (platform === 'win32' && !isAbsoluteWindowsPath(dir)) continue;
    const candidate = dir.endsWith(dirSep) ? `${dir}${name}` : `${dir}${dirSep}${name}`;
    if (await isFile(candidate)) {
      paths.push(candidate);
    }
  }
  return platform === 'win32' ? dedupeWindowsPaths(paths) : paths;
}

export async function execFileText(
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
