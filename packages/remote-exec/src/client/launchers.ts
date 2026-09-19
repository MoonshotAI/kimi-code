import { resolveProgramPath } from '@moonshot-ai/agent-core-v2/environment/programPath';

export { resolveProgramPath };

export const DEFAULT_REMOTE_BIN = '~/.kimi-code/bin/kimi';
export const EXEC_SERVER_ARGV: readonly string[] = ['exec-server', '--listen', 'stdio'];

// ssh and scp share the -o set (BatchMode against password prompts,
// accept-new against first-connect host-key prompts, ServerAlive for half-open
// detection); only the ssh invocation adds -T (no TTY on the bridge).
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

export function resolveLauncher(spec: LauncherSpec): ResolvedLauncher {
  switch (spec.type) {
    case 'ssh':
      return {
        program: 'ssh',
        args: [
          ...sshBaseArgs(),
          spec.host,
          spec.remoteBin ?? DEFAULT_REMOTE_BIN,
          ...EXEC_SERVER_ARGV,
        ],
      };
    case 'docker':
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
        env: spec.env,
      };
  }
}


