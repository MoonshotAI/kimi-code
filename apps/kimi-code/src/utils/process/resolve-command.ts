import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

// cmd.exe / CreateProcess search the current directory before PATH, so on
// Windows a bare command name can execute a binary planted in the workspace
// the user just opened (binary planting). Resolving through PATH ourselves —
// and refusing any hit inside the cwd — keeps that from happening before the
// workspace trust gate has run.

const DEFAULT_WIN32_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

function pathExtensions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): readonly string[] {
  if (platform !== 'win32') return [''];
  const raw = env['PATHEXT'];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_WIN32_PATHEXT;
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
}

function candidateNames(command: string, extensions: readonly string[]): readonly string[] {
  if (extensions.length === 1 && extensions[0] === '') return [command];
  const lower = command.toLowerCase();
  // An explicitly suffixed name (npm.cmd) is tried as-is first, like cmd.exe.
  if (extensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return [command, ...extensions.map((ext) => command + ext)];
  }
  return extensions.map((ext) => command + ext);
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    // Windows has no executable bit; file existence is enough there.
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isInsideCwd(candidate: string, cwd: string, platform: NodeJS.Platform): boolean {
  let resolvedCandidate = resolve(candidate);
  let resolvedCwd = resolve(cwd);
  if (platform === 'win32') {
    resolvedCandidate = resolvedCandidate.toLowerCase();
    resolvedCwd = resolvedCwd.toLowerCase();
  }
  const rel = relative(resolvedCwd, resolvedCandidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve a bare command name to an absolute executable path by searching
 * PATH (PATHEXT-aware on Windows). Returns undefined when the command is not
 * found — or when the only hit lives inside `cwd`, since executing that would
 * run whatever a malicious workspace planted there.
 */
export function resolveCommandPath(command: string, cwd: string = process.cwd()): string | undefined {
  const platform = process.platform;
  const env = process.env;
  const extensions = pathExtensions(platform, env);
  const names = candidateNames(command, extensions);
  const pathValue = env['PATH'] ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(separator)) {
    // An empty PATH entry means the current directory on POSIX — anything it
    // could produce would be rejected by the cwd check anyway, so skip it.
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isExecutableFile(candidate, platform)) continue;
      if (isInsideCwd(candidate, cwd, platform)) return undefined;
      return resolve(candidate);
    }
  }
  return undefined;
}
