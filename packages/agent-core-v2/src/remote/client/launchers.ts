import { resolveProgramPath } from '#/environment/programPath';
import type { RemoteEnvironmentEntry } from '#/remote/declaration/remoteEnvironmentDeclaration';

export const DEFAULT_REMOTE_BIN = '~/.kimi-code/bin/kimi';
export const EXEC_SERVER_SUBCOMMAND = 'exec-server';
export const EXEC_SERVER_ARGV: readonly string[] = [EXEC_SERVER_SUBCOMMAND, '--listen', 'stdio'];

const EXEC_SERVER_WORD = /(^|[\s=])exec-server(\s|$)/;

export const SSH_CONFIG_OPTIONS: readonly string[] = [
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
];

export function dockerBaseArgs(context?: string): readonly string[] {
  return context === undefined ? [] : ['--context', context];
}

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
      readonly remoteBin?: string;
    };

export function toLauncherSpec(entry: RemoteEnvironmentEntry): LauncherSpec {
  if ('command' in entry) {
    return { type: 'command', program: entry.command, args: entry.args, env: entry.env, remoteBin: entry.remoteBin };
  }
  return entry.type === 'ssh'
    ? { type: 'ssh', host: entry.host, remoteBin: entry.remoteBin }
    : { type: 'docker', container: entry.container, context: entry.context, remoteBin: entry.remoteBin };
}

export function declarationFingerprint(entry: RemoteEnvironmentEntry): string {
  const launcher = { ...toLauncherSpec(entry), remoteBin: entry.remoteBin ?? DEFAULT_REMOTE_BIN };
  return JSON.stringify(launcher.type === 'command'
    ? { ...launcher, args: launcher.args ?? [], env: Object.fromEntries(Object.entries(launcher.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b))) }
    : launcher);
}

export interface ResolvedLauncher {
  readonly program: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

export function assertLauncherOperand(kind: string, value: string): void {
  if (value.length === 0) throw new Error(`${kind} must not be empty`);
  if (value.startsWith('-')) {
    throw new Error(`${kind} must not start with '-': ${value}`);
  }
}

export function launcherRemoteBin(spec: LauncherSpec): string | undefined {
  if (spec.type === 'command' && (spec.args ?? []).some((arg) => EXEC_SERVER_WORD.test(arg))) return undefined;
  return spec.remoteBin ?? DEFAULT_REMOTE_BIN;
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const TILDE_PREFIX = /^~[a-zA-Z0-9._-]*/;

function execServerShellCommand(remoteBin: string): string {
  const tilde = TILDE_PREFIX.exec(remoteBin);
  if (tilde === null) {
    return [shQuote(remoteBin), ...EXEC_SERVER_ARGV.map(shQuote)].join(' ');
  }
  const prefix = tilde[0];
  const rest = remoteBin.slice(prefix.length);
  let bin: string;
  if (prefix === '~') {
    bin = rest.length === 0 ? '"$HOME"' : `"$HOME"${shQuote(rest)}`;
  } else if (rest.length === 0) {
    bin = prefix;
  } else if (rest === '/') {
    bin = `${prefix}/`;
  } else if (rest.startsWith('/')) {
    bin = `${prefix}/${shQuote(rest.slice(1))}`;
  } else {
    bin = shQuote(remoteBin);
  }
  return [bin, ...EXEC_SERVER_ARGV.map(shQuote)].join(' ');
}

const COMMAND_LAUNCHER_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'USER',
  'LOGNAME',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
]);

export function commandLauncherEnv(
  specEnv?: Record<string, string>,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (COMMAND_LAUNCHER_ENV_KEYS.has(key) || key.startsWith('LC_')) {
      env[key] = value;
    }
  }
  if (specEnv !== undefined) Object.assign(env, specEnv);
  return env;
}

export function resolveLauncher(spec: LauncherSpec, interactiveSshAuth = false): ResolvedLauncher {
  switch (spec.type) {
    case 'ssh': {
      assertLauncherOperand('ssh host', spec.host);
      const authOptions = interactiveSshAuth
        ? ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1']
        : ['-o', 'BatchMode=yes'];
      return {
        program: 'ssh',
        args: ['-T', ...authOptions, ...SSH_CONFIG_OPTIONS.slice(2), spec.host, execServerShellCommand(spec.remoteBin ?? DEFAULT_REMOTE_BIN)],
      };
    }
    case 'docker':
      assertLauncherOperand('docker container', spec.container);
      return {
        program: 'docker',
        args: [
          ...dockerBaseArgs(spec.context),
          'exec',
          '-i',
          spec.container,
          'sh',
          '-c',
          `exec ${execServerShellCommand(spec.remoteBin ?? DEFAULT_REMOTE_BIN)}`,
        ],
      };
    case 'command': {
      const remoteBin = launcherRemoteBin(spec);
      if (remoteBin !== undefined) assertLauncherOperand('remote bin', remoteBin);
      return {
        program: resolveProgramPath(spec.program, { pathEnv: spec.env?.['PATH'] }),
        args: remoteBin === undefined
          ? [...(spec.args ?? [])]
          : [...(spec.args ?? []), remoteBin, EXEC_SERVER_SUBCOMMAND],
        env: commandLauncherEnv(spec.env),
      };
    }
  }
}
