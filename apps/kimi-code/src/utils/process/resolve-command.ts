import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

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
  if (extensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return [command, ...extensions.map((ext) => command + ext)];
  }
  return extensions.map((ext) => command + ext);
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInsideCwd(candidate: string, cwd: string, platform: NodeJS.Platform): boolean {
  let resolvedCandidate = join(physicalPath(dirname(resolve(candidate))), basename(candidate));
  let resolvedCwd = physicalPath(cwd);
  if (resolvedCwd === parse(resolvedCwd).root) return false;
  if (platform === 'win32') {
    resolvedCandidate = resolvedCandidate.toLowerCase();
    resolvedCwd = resolvedCwd.toLowerCase();
  }
  const rel = relative(resolvedCwd, resolvedCandidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function resolveTrustedExecutable(
  candidate: string,
  cwd: string = process.cwd(),
): string | undefined {
  const platform = process.platform;
  if (!isExecutableFile(candidate, platform)) return undefined;
  if (isInsideCwd(candidate, cwd, platform)) return undefined;
  return resolve(candidate);
}

export function resolveCommandPath(command: string, cwd: string = process.cwd()): string | undefined {
  const platform = process.platform;
  const env = process.env;
  const extensions = pathExtensions(platform, env);
  const names = candidateNames(command, extensions);
  const pathValue = env['PATH'] ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(separator)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isExecutableFile(candidate, platform)) continue;
      if (isInsideCwd(candidate, cwd, platform)) continue;
      return resolve(candidate);
    }
  }
  return undefined;
}
