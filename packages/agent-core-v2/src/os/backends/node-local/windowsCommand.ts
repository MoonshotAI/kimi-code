import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const BATCH_SCRIPT_EXTENSIONS = ['.cmd', '.bat'];
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

export interface WindowsSpawnTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

export function prepareWindowsSpawnTarget(
  command: string,
  args: readonly string[],
  env?: Record<string, string>,
  cwd?: string,
): WindowsSpawnTarget | undefined {
  const resolved = resolveBatchScript(command, env, cwd);
  if (resolved === undefined) return undefined;
  const doubleEscape = CMD_SHIM.test(resolved);
  const line = [escapeCommand(resolved), ...args.map((arg) => escapeArgument(arg, doubleEscape))].join(' ');
  return {
    command: envValue(env, 'ComSpec') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function resolveBatchScript(command: string, env?: Record<string, string>, cwd?: string): string | undefined {
  const baseCwd = cwd ?? process.cwd();
  if (command.includes('/') || command.includes('\\')) {
    if (!isBatchScript(command)) return undefined;
    const resolved = isAbsolute(command) ? command : resolve(baseCwd, command);
    return isFile(resolved) ? resolved : undefined;
  }
  if (/\.(exe|com)$/i.test(command)) return undefined;
  const dirs = (envValue(env, 'PATH') ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0);
  if (!command.includes('.')) {
    for (const dir of [baseCwd, ...dirs]) {
      if (isFile(join(dir, command + '.exe')) || isFile(join(dir, command + '.com'))) return undefined;
    }
  }
  const batchExts = pathExtensions(env).filter((ext) =>
    BATCH_SCRIPT_EXTENSIONS.includes(ext.toLowerCase()),
  );
  const names = command.includes('.') ? [command] : batchExts.map((ext) => command + ext.toLowerCase());
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isFile(candidate)) continue;
      return isBatchScript(candidate) ? candidate : undefined;
    }
  }
  return undefined;
}

function pathExtensions(env?: Record<string, string>): string[] {
  const raw = envValue(env, 'PATHEXT');
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PATHEXT;
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
}

function envValue(overrides: Record<string, string> | undefined, name: string): string | undefined {
  const upper = name.toUpperCase();
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key.toUpperCase() === upper) return value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

function isBatchScript(path: string): boolean {
  const lower = path.toLowerCase();
  return BATCH_SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function escapeCommand(arg: string): string {
  return arg.replace(CMD_META_CHARS, '^$1');
}

function escapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  let escaped = arg.replaceAll(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, '^$1');
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META_CHARS, '^$1');
  return escaped;
}
