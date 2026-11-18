import { setTimeout as sleep } from 'node:timers/promises';

import chalk from 'chalk';

import { CLI_MSH_PLATFORM, CLI_USER_AGENT_PRODUCT, KIMI_CODE_RC_UPGRADED_FROM_ENV } from '#/constant/app';
import { openUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { persistedKimiOAuthRef } from '#/utils/region';
import { generateRemoteControlQr } from '#/utils/remote-control-qr';

import { getVersion } from '../../version';
import { darkColors } from '../../../tui/theme/colors';
import { supportsHyperlinks, toTerminalHyperlink } from '../../../utils/terminal-hyperlink';
import {
  buildRemoteControlUrl,
  startRemoteControl,
  unixSocketOrigin,
  type RemoteControlHandle,
  type RemoteControlOptions,
  type RemoteControlStatus,
} from '@moonshot-ai/remote-control';
import {
  attachDaemon,
  DaemonBusyError,
  defaultEnsureDaemonDeps,
  kimiArgv,
  type AttachedDaemon,
  type DaemonExit,
} from './ensure-daemon';

export {
  acquireRemoteControlLock,
  buildRemoteControlUrl,
  filterForwardRequestHeaders,
  formatRemoteControlAlreadyRunning,
  inspectRemoteControlLock,
  parseRawHttpRequest,
  remoteControlLockPath,
  RemoteControlAlreadyRunningError,
  REMOTE_CONTROL_RELAY_ORIGIN,
  REMOTE_CONTROL_RELAY_URL_ENV,
  resolveRemoteControlRelayOrigin,
  rewriteRemoteControlResponse,
  startRemoteControl,
} from '@moonshot-ai/remote-control';
export type {
  ParsedRawHttpRequest,
  RemoteControlCloseReason,
  RemoteControlHandle,
  RemoteControlLock,
  RemoteControlLockInfo,
  RemoteControlOptions,
  RemoteControlStatus,
} from '@moonshot-ai/remote-control';

export const DAEMON_BUSY_RETRY_MS = 10_000;

const RESTART_REMOTE_CONTROL_HINT = 'run `kimi rc` to bring Remote Control back online';

type Execve = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never;

export interface RemoteControlServer {
  readonly localOrigin: string;
  readonly localServerToken?: () => string;
  readonly logPath?: string;
  readonly background: boolean;
  readonly closed: Promise<DaemonExit>;
  close(): Promise<void>;
}

export interface RemoteControlRunOptions {
  readonly open: boolean;
  readonly sessionId?: string;
}

export interface RemoteControlRunDeps {
  readonly attachServer: () => Promise<RemoteControlServer>;
  readonly startRemoteControl: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
  readonly onTerminate: (listener: () => void) => () => void;
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly openUrl: (url: string) => void;
  readonly relaunch?: () => Promise<void>;
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function relaunchKimi(
  args: readonly string[],
  execve: Execve | undefined = process.execve?.bind(process),
): Promise<void> {
  if (execve === undefined) throw new Error(`Kimi Code was upgraded on this machine; ${RESTART_REMOTE_CONTROL_HINT}.`);
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve());
  });
  const argv = [...kimiArgv(), ...args];
  try {
    execve(argv[0]!, argv, { ...process.env, [KIMI_CODE_RC_UPGRADED_FROM_ENV]: getVersion() });
  } catch (error) {
    throw new Error(
      `Kimi Code was upgraded on this machine, but Remote Control could not restart itself (${error instanceof Error ? error.message : String(error)}); ${RESTART_REMOTE_CONTROL_HINT}.`,
      { cause: error },
    );
  }
}

export function takeRemoteControlUpgradedFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const from = env[KIMI_CODE_RC_UPGRADED_FROM_ENV];
  delete env[KIMI_CODE_RC_UPGRADED_FROM_ENV];
  return from === undefined || from.length === 0 ? undefined : from;
}

export async function attachBackgroundServer(
  attach: () => Promise<AttachedDaemon> = () => attachDaemon(defaultEnsureDaemonDeps()),
): Promise<RemoteControlServer> {
  const daemon = await attach();
  return {
    localOrigin: unixSocketOrigin(daemon.socketPath),
    logPath: daemon.logPath,
    background: true,
    closed: daemon.lease.closed,
    close: async () => {
      daemon.lease.close();
    },
  };
}

export const DEFAULT_REMOTE_CONTROL_RUN_DEPS: Omit<RemoteControlRunDeps, 'attachServer'> = {
  startRemoteControl,
  onTerminate: (listener) => {
    process.once('SIGINT', listener);
    process.once('SIGTERM', listener);
    return () => {
      process.off('SIGINT', listener);
      process.off('SIGTERM', listener);
    };
  },
  wait: async (ms, signal) => {
    try {
      await sleep(ms, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  },
  openUrl,
  stdout: process.stdout,
  stderr: process.stderr,
};

export async function runRemoteControl(
  options: RemoteControlRunOptions,
  deps: RemoteControlRunDeps,
): Promise<void> {
  const terminated = new AbortController();
  const stopListening = deps.onTerminate(() => terminated.abort());
  let serverUpgraded = false;
  try {
    const server = await attachServerWhenFree(deps, terminated.signal);
    if (server === undefined) return;
    try {
      serverUpgraded = (await serveRemoteControl(server, options, deps, terminated.signal)) === 'upgraded';
    } finally {
      await server.close();
    }
  } finally {
    stopListening();
  }
  if (!serverUpgraded) return;
  if (deps.relaunch === undefined) throw new Error(`Kimi Code was upgraded on this machine; ${RESTART_REMOTE_CONTROL_HINT}.`);
  deps.stdout.write(formatStatusLine('↻', 'Kimi Code was upgraded on this machine; restarting Remote Control…'));
  await deps.relaunch();
}

async function attachServerWhenFree(
  deps: RemoteControlRunDeps,
  terminated: AbortSignal,
): Promise<RemoteControlServer | undefined> {
  let announced = false;
  while (!terminated.aborted) {
    try {
      return await deps.attachServer();
    } catch (error) {
      if (!(error instanceof DaemonBusyError)) throw error;
      if (!announced) deps.stdout.write(formatDaemonBusyStatus(error.runningVersion));
      announced = true;
    }
    await deps.wait(DAEMON_BUSY_RETRY_MS, terminated);
  }
  return undefined;
}

async function serveRemoteControl(
  server: RemoteControlServer,
  options: RemoteControlRunOptions,
  deps: RemoteControlRunDeps,
  terminated: AbortSignal,
): Promise<'upgraded' | undefined> {
  const dataDir = getDataDir();
  const persisted = persistedKimiOAuthRef();
  let outputReady = false;
  let stopping = false;
  const pendingStatuses: string[] = [];
  const onStatus = (status: RemoteControlStatus): void => {
    if (stopping) return;
    const line = formatRemoteControlStatus(status);
    if (outputReady) deps.stdout.write(line);
    else pendingStatuses.push(line);
  };
  let remoteControl: RemoteControlHandle;
  try {
    remoteControl = await deps.startRemoteControl({
      homeDir: dataDir,
      localOrigin: server.localOrigin,
      localServerToken: server.localServerToken,
      clientVersion: `${CLI_USER_AGENT_PRODUCT}/${getVersion()}`,
      urlSource: CLI_MSH_PLATFORM,
      configuredOAuthKey: persisted?.key,
      configuredOAuthHost: persisted?.oauthHost,
      stderr: deps.stderr,
      onStatus,
      signal: terminated,
    });
  } catch (error) {
    if (terminated.aborted) return;
    throw error;
  }
  let ended: 'terminated' | 'tunnel_closed' | DaemonExit;
  try {
    const url =
      options.sessionId === undefined
        ? remoteControl.url
        : buildRemoteControlUrl(
            remoteControl.deviceId,
            options.sessionId,
            remoteControl.relayOrigin,
            CLI_MSH_PLATFORM,
          );
    const qrCode = await generateRemoteControlQr(url, dataDir);
    deps.stdout.write(
      formatRemoteControlOutput({
        url,
        deviceName: remoteControl.deviceName,
        qrCode: qrCode.terminal,
        pngPath: qrCode.pngPath,
        logPath: server.logPath,
      }),
    );
    outputReady = true;
    for (const line of pendingStatuses) deps.stdout.write(line);
    if (options.open) deps.openUrl(url);
    ended = await Promise.race([
      whenAborted(terminated).then(() => 'terminated' as const),
      remoteControl.closed.then(
        () => 'tunnel_closed' as const,
        () => 'tunnel_closed' as const,
      ),
      server.closed,
    ]);
  } finally {
    stopping = true;
    await remoteControl.close().catch((error: unknown) => {
      deps.stderr.write(
        `Remote Control lock release failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }
  if (ended === 'upgraded') return 'upgraded';
  if (ended === 'stopped') {
    throw new Error('The background Kimi server stopped, so Remote Control went offline.');
  }
  if (server.background) deps.stdout.write(formatRemoteControlStopped());
  return undefined;
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export interface RemoteControlOutputOptions {
  readonly url: string;
  readonly deviceName: string;
  readonly qrCode: string;
  readonly pngPath: string;
  readonly logPath?: string;
}

export function formatRemoteControlOutput(options: RemoteControlOutputOptions): string {
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const status = (text: string): string => chalk.hex(darkColors.success)(text);
  const link = (url: string): string =>
    supportsHyperlinks() ? toTerminalHyperlink(accent(url), url) : accent(url);
  const docs = toTerminalHyperlink('docs', 'https://kimi.com/code/docs/remote-control');
  const feedback = toTerminalHyperlink('feedback', 'https://kimi.com/code/feedback');
  return [
    '',
    `  ${title('Kimi Remote Control ready')}  ${muted(getVersion())}`,
    `  ${muted('Use Kimi Code on this machine from your phone or another computer.')}`,
    '',
    `  ${label('1.')} Scan the QR code, or open ${link(options.url)}`,
    `  ${label('2.')} Log in with your Kimi account`,
    `  ${label('3.')} Start chatting — sessions run on this machine`,
    '',
    `  ${status('✓')} ${muted(`Connected to ${new URL(options.url).host}, waiting for remote devices…`)}`,
    `  ${label('This device: ')}${muted(options.deviceName)}`,
    `  ${status('⚠')} ${muted('This link grants control of this machine. Do not share it.')}`,
    '',
    options.qrCode.trimEnd().replaceAll(/^/gm, '    '),
    `  ${label('QR code PNG: ')}${options.pngPath} ${muted('(open this if the QR above does not scan)')}`,
    '',
    `  ${docs} ${muted('·')} ${feedback}`,
    `  ${label('Logs: ')}${muted(options.logPath ?? 'off (--log-level info)')} ${muted('·')} ${label('Stop: ')}${muted('Ctrl+C')}`,
    '',
  ].join('\n');
}

export function formatRemoteControlStatus(status: RemoteControlStatus): string {
  switch (status) {
    case 'relay_connected':
      return formatStatusLine('✓', 'Connected to relay, waiting for remote devices…');
    case 'relay_disconnected':
      return formatStatusLine('!', 'Relay disconnected; reconnecting…');
    case 'relay_terminated':
      return formatStatusLine('✕', 'Taken offline from the web; exiting…');
    case 'device_connected':
      return formatStatusLine('✓', 'Remote device connected (1 active session)');
    case 'device_disconnected':
      return formatStatusLine('→', 'Remote device disconnected');
  }
}

export function formatRemoteControlUpgraded(from: string): string {
  return formatStatusLine('✓', `Kimi Code upgraded from ${from} to ${getVersion()}; bringing Remote Control back online…`);
}

export function formatIgnoredServerOptions(flags: readonly string[]): string {
  return formatStatusLine(
    '!',
    `Ignoring ${flags.join(', ')}: Remote Control runs on the background Kimi server.`,
  );
}

function formatDaemonBusyStatus(runningVersion: string): string {
  return formatStatusLine(
    '!',
    `Kimi server ${runningVersion} is still running work on this device; Remote Control starts once it finishes…`,
  );
}

function formatRemoteControlStopped(): string {
  return formatStatusLine(
    '→',
    'Remote Control stopped; sessions keep running in the background Kimi server.',
  );
}

function formatStatusLine(marker: string, text: string): string {
  const label = chalk.bold.hex(darkColors.textDim)(text);
  const value = chalk.hex(darkColors.success)(marker);
  return `  ${value} ${label}\n`;
}
