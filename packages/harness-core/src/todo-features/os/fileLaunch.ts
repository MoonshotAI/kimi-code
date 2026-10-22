import { dirname, join } from 'pathe';

import type { OsEnvironmentPort, OsHost, OsProcessPort } from './host/types';

export interface LaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell?: boolean;
  readonly windowsVerbatimArguments?: boolean;
}

export type LaunchPlatform = 'darwin' | 'win32' | 'linux';

export function launchPlatformFor(
  environment: Pick<OsEnvironmentPort, 'osKind' | 'pathClass'>,
): LaunchPlatform {
  if (environment.pathClass === 'win32') return 'win32';
  if (environment.osKind === 'macOS') return 'darwin';
  return 'linux';
}

export function openFileCommandFor(
  absolutePath: string,
  line: number | undefined,
  env: Record<string, string | undefined>,
  platform: LaunchPlatform,
): LaunchCommand {
  const editor = resolveEditorCommand(env);
  if (editor !== undefined) {
    const target =
      supportsLineTarget(editor) && line !== undefined ? `${absolutePath}:${line}` : absolutePath;
    return {
      command: `${editor} ${quoteShellArg(target, platform)}`,
      args: [],
      shell: true,
    };
  }

  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [absolutePath] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '""', absolutePath] };
    default:
      return { command: 'xdg-open', args: [absolutePath] };
  }
}

export function revealFileCommandFor(
  absolutePath: string,
  platform: LaunchPlatform,
): LaunchCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', absolutePath] };
    case 'win32':
      return {
        command: 'explorer.exe',
        args: [explorerSelectArg(absolutePath)],
        windowsVerbatimArguments: true,
      };
    default:
      return { command: 'xdg-open', args: [dirname(absolutePath)] };
  }
}

export const OPEN_IN_APP_IDS = ['finder', 'cursor', 'vscode', 'iterm', 'terminal'] as const;
export type OpenInAppId = (typeof OPEN_IN_APP_IDS)[number];

export interface OpenInAppOptions {
  readonly line?: number;
  readonly isDirectory?: boolean;
}

export function openInAppCommandFor(
  appId: OpenInAppId,
  absolutePath: string,
  options: OpenInAppOptions,
  platform: LaunchPlatform,
): LaunchCommand {
  switch (appId) {
    case 'vscode':
      return openInVsCodeLike('code', absolutePath, options.line, platform);
    case 'cursor':
      return openInVsCodeLike('cursor', absolutePath, options.line, platform);
    case 'finder':
      return openInFinder(absolutePath, options.isDirectory, platform);
    case 'iterm':
      return openInMacApp('iTerm', absolutePath, platform);
    case 'terminal':
      return openInMacApp('Terminal', absolutePath, platform);
  }
}

export async function detectOpenInApps(host: OsHost): Promise<readonly OpenInAppId[]> {
  await host.environment.ready;
  const platform = launchPlatformFor(host.environment);
  const available: OpenInAppId[] = [];
  for (const appId of OPEN_IN_APP_IDS) {
    if (await isOpenInAppAvailable(host, appId, platform)) available.push(appId);
  }
  return available;
}

async function isOpenInAppAvailable(
  host: OsHost,
  appId: OpenInAppId,
  platform: LaunchPlatform,
): Promise<boolean> {
  switch (appId) {
    case 'finder':
    case 'terminal':
      return platform === 'darwin';
    case 'iterm': {
      if (platform !== 'darwin') return false;
      return (
        (await pathExists(host, '/Applications/iTerm.app')) ||
        (await pathExists(host, join(host.environment.homeDir, 'Applications/iTerm.app')))
      );
    }
    case 'vscode':
      return commandExists(host, 'code', platform);
    case 'cursor':
      return commandExists(host, 'cursor', platform);
  }
}

async function pathExists(host: OsHost, path: string): Promise<boolean> {
  try {
    await host.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(
  host: OsHost,
  command: string,
  platform: LaunchPlatform,
): Promise<boolean> {
  try {
    const proc =
      platform === 'win32'
        ? await host.process.spawn('cmd', ['/c', 'where', command])
        : await host.process.spawn(host.environment.shellPath, ['-c', `command -v ${command}`]);
    try {
      proc.stdin.end();
    } catch {
    }
    try {
      return (await proc.wait()) === 0;
    } finally {
      proc.dispose();
    }
  } catch {
    return false;
  }
}

function openInVsCodeLike(
  binary: string,
  absolutePath: string,
  line: number | undefined,
  platform: LaunchPlatform,
): LaunchCommand {
  const target = line !== undefined ? `${absolutePath}:${line}` : absolutePath;
  const flag = line !== undefined ? '-g ' : '';
  return {
    command: `${binary} ${flag}${quoteShellArg(target, platform)}`,
    args: [],
    shell: true,
  };
}

function openInFinder(
  absolutePath: string,
  isDirectory: boolean | undefined,
  platform: LaunchPlatform,
): LaunchCommand {
  switch (platform) {
    case 'darwin':
      return isDirectory
        ? { command: 'open', args: [absolutePath] }
        : { command: 'open', args: ['-R', absolutePath] };
    case 'win32':
      return isDirectory
        ? { command: 'explorer.exe', args: [absolutePath] }
        : {
            command: 'explorer.exe',
            args: [explorerSelectArg(absolutePath)],
            windowsVerbatimArguments: true,
          };
    default:
      return {
        command: 'xdg-open',
        args: [isDirectory ? absolutePath : dirname(absolutePath)],
      };
  }
}

function openInMacApp(
  appName: string,
  absolutePath: string,
  platform: LaunchPlatform,
): LaunchCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', appName, absolutePath] };
  }
  return openFileCommandFor(absolutePath, undefined, process.env, platform);
}

export async function launchDetached(
  processPort: OsProcessPort,
  cmd: LaunchCommand,
): Promise<void> {
  const proc = await processPort.spawn(cmd.command, cmd.args, {
    shell: cmd.shell,
    windowsVerbatimArguments: cmd.windowsVerbatimArguments,
    windowsHide: false,
  });
  try {
    proc.stdin.end();
  } catch {
  }
  proc.dispose();
}

function resolveEditorCommand(env: Record<string, string | undefined>): string | undefined {
  for (const key of ['KIMI_CODE_EDITOR', 'VISUAL', 'EDITOR']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function supportsLineTarget(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return /(?:^|\/)(code|cursor|windsurf)(?:\.cmd|\.exe)?$/i.test(first);
}

function explorerSelectArg(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\\+$/, '');
  return `/select,"${trimmed}"`;
}

function quoteShellArg(value: string, platform: LaunchPlatform): string {
  if (platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
