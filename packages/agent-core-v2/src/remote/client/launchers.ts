import { resolveProgramPath } from '#/environment/programPath';

export const DEFAULT_REMOTE_BIN = '~/.kimi-code/bin/kimi';
export const EXEC_SERVER_ARGV: readonly string[] = ['exec-server', '--listen', 'stdio'];

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

export function sshBaseArgs(): readonly string[] {
  return ['-T', ...SSH_CONFIG_OPTIONS];
}

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
    };

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

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const TILDE_PREFIX = /^~[a-zA-Z0-9._-]*/;

function sshRemoteCommand(remoteBin: string): string {
  const tilde = TILDE_PREFIX.exec(remoteBin);
  let quotedBin = shQuote(remoteBin);
  if (tilde !== null && remoteBin.length === tilde[0].length) {
    quotedBin = tilde[0];
  } else if (tilde !== null && remoteBin.startsWith('/', tilde[0].length)) {
    quotedBin = `${tilde[0]}${shQuote(remoteBin.slice(tilde[0].length))}`;
  }
  return [quotedBin, ...EXEC_SERVER_ARGV.map(shQuote)].join(' ');
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

export function resolveLauncher(spec: LauncherSpec): ResolvedLauncher {
  switch (spec.type) {
    case 'ssh':
      assertLauncherOperand('ssh host', spec.host);
      return {
        program: 'ssh',
        args: [...sshBaseArgs(), spec.host, sshRemoteCommand(spec.remoteBin ?? DEFAULT_REMOTE_BIN)],
      };
    case 'docker':
      assertLauncherOperand('docker container', spec.container);
      return {
        program: 'docker',
        args: [
          ...dockerBaseArgs(spec.context),
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
        env: commandLauncherEnv(spec.env),
      };
  }
}
