import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

export const DEFAULT_REMOTE_BIN = '~/.kimi-code/bin/kimi';
export const EXEC_SERVER_ARGV: readonly string[] = ['exec-server', '--listen', 'stdio'];

export type LauncherSpec =
  | { readonly type: 'ssh'; readonly host: string; readonly remoteBin?: string }
  | {
      readonly type: 'docker';
      readonly container: string;
      readonly context?: string;
      readonly remoteBin?: string;
    }
  | {
      readonly type: 'command';
      readonly program: string;
      readonly args?: readonly string[];
      readonly env?: Record<string, string>;
    };

export interface ResolvedLauncher {
  readonly program: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

export function resolveLauncher(spec: LauncherSpec): ResolvedLauncher {
  switch (spec.type) {
    case 'ssh':
      return {
        program: 'ssh',
        args: [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=3',
          '-o',
          'StrictHostKeyChecking=accept-new',
          spec.host,
          spec.remoteBin ?? DEFAULT_REMOTE_BIN,
          ...EXEC_SERVER_ARGV,
        ],
      };
    case 'docker':
      return {
        program: 'docker',
        args: [
          ...(spec.context === undefined ? [] : ['--context', spec.context]),
          'exec',
          '-i',
          spec.container,
          spec.remoteBin ?? DEFAULT_REMOTE_BIN,
          ...EXEC_SERVER_ARGV,
        ],
      };
    case 'command':
      return {
        program: resolveProgramPath(spec.program),
        args: [...(spec.args ?? [])],
        env: spec.env,
      };
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isInsideCwd(path: string, cwd: string): boolean {
  const relativeCwd = resolve(cwd);
  const resolved = resolve(path);
  return resolved === relativeCwd || resolved.startsWith(relativeCwd + sep);
}

// Resolves a launcher program to an absolute PATH hit. Bare names are searched
// through PATH; hits inside the current working directory are refused so a
// project-level declaration cannot smuggle a repo-local binary.
export function resolveProgramPath(
  program: string,
  options?: { readonly cwd?: string; readonly pathEnv?: string },
): string {
  if (program.length === 0 || program.trim().length === 0) {
    throw new Error('launcher command must be a non-empty program name or absolute path');
  }
  const cwd = options?.cwd ?? process.cwd();
  if (program.includes('/') || program.includes('\\')) {
    if (!isAbsolute(program)) {
      throw new Error(`launcher command "${program}" must be an absolute path`);
    }
    if (!isExecutableFile(program)) {
      throw new Error(`launcher command "${program}" is not an executable file`);
    }
    if (isInsideCwd(program, cwd)) {
      throw new Error(`launcher command "${program}" resolves inside the working directory; refusing cwd match`);
    }
    return program;
  }
  const pathEnv = options?.pathEnv ?? process.env['PATH'] ?? '';
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const entry of pathEnv.split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    for (const extension of extensions) {
      const candidate = join(entry, program + extension.toLowerCase());
      if (!isExecutableFile(candidate)) continue;
      if (isInsideCwd(candidate, cwd)) {
        throw new Error(`launcher command "${program}" resolves inside the working directory; refusing cwd match`);
      }
      return candidate;
    }
  }
  throw new Error(`launcher command "${program}" was not found on PATH`);
}
