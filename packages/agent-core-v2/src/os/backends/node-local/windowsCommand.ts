import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const BATCH_SCRIPT_EXTENSIONS = ['.cmd', '.bat'];
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

export interface WindowsSpawnTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

export function prepareWindowsSpawnTarget(
  command: string,
  args: readonly string[],
  env?: Record<string, string>,
): WindowsSpawnTarget | undefined {
  const resolved = resolveBatchScript(command, env);
  if (resolved === undefined) return undefined;
  const line = [resolved, ...args].map(escapeCmdToken).join(' ');
  return {
    command: envValue(env, 'ComSpec') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function resolveBatchScript(command: string, env?: Record<string, string>): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    return isBatchScript(command) && isFile(command) ? command : undefined;
  }
  const pathEnv = envValue(env, 'PATH') ?? '';
  const extensions = pathExtensions(env);
  const hasOwnExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const names = hasOwnExtension ? [command] : extensions.map((ext) => command + ext.toLowerCase());
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

function escapeCmdToken(token: string): string {
  if (token.length > 0 && !/[\s"]/.test(token)) return token;
  return `"${token.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
