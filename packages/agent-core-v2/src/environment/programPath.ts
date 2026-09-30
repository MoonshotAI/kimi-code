import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

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
