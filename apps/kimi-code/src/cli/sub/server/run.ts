/**
 * `kimi server run` — runs the local server in the foreground.
 *
 * Background ("daemonized") operation is not handled here. Use
 * `kimi server install` + `kimi server start` to register the server as an
 * OS-managed service (launchd / systemd / schtasks) instead.
 *
 * `kimi web` is an alias of this command with `--open` defaulted to `true`,
 * registered in `./web-alias.ts`.
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { join } from 'node:path';

import {
  ServerLockedError,
  resolveServiceManager,
  startServer,
  type ServiceStatus,
} from '@moonshot-ai/server';

import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import { createKimiCodeHostIdentity, getHostPackageRoot, getVersion } from '../../version';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  serverOrigin,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';
const READY_PANEL_WIDTH = 72;

export interface RunCliOptions extends ServerCliOptions {
  open?: boolean;
}

export interface RunCommandDeps {
  startServerForeground(options: ParsedServerOptions): Promise<{ origin: string }>;
  getServiceStatus(): Promise<ServiceStatus | undefined>;
  openUrl(url: string): void;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/** Build the `run` subcommand, mounted under a parent (`server` or top-level). */
export function buildRunCommand(cmd: Command, options: { defaultOpen: boolean }): Command {
  return cmd
    .option(
      '--port <port>',
      `Bind port (default ${DEFAULT_SERVER_PORT})`,
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--log-level <level>',
      `Enable foreground logs at level: ${VALID_LOG_LEVELS.join('|')}. Omit to keep logs off.`,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection. OFF by default; production callers leave this unset.',
      false,
    )
    .option(
      options.defaultOpen ? '--no-open' : '--open',
      options.defaultOpen
        ? 'Do not open the web UI in the default browser.'
        : 'Open the web UI in the default browser once the server is healthy.',
      options.defaultOpen,
    )
    .action(async (opts: RunCliOptions) => {
      try {
        await handleRunCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleRunCommand(
  opts: RunCliOptions,
  deps: RunCommandDeps = DEFAULT_RUN_COMMAND_DEPS,
): Promise<void> {
  const parsed = parseServerOptions(opts);
  let outcome: { origin: string };
  const startedAt = Date.now();
  try {
    outcome = await deps.startServerForeground(parsed);
  } catch (error) {
    if (error instanceof ServerLockedError) {
      const status = await deps.getServiceStatus();
      const alreadyRunning = describeAlreadyRunning(error.existing, status);
      deps.stdout.write(formatAlreadyRunning(alreadyRunning));
      deps.openUrl(alreadyRunning.url);
      return;
    }
    throw error;
  }
  const readyMs = Date.now() - startedAt;
  deps.stdout.write(
    parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL
      ? formatForegroundReadyBanner(outcome.origin, readyMs)
      : `Kimi server: ${outcome.origin}\n`,
  );
  if (opts.open === true) {
    deps.openUrl(outcome.origin);
  }
}

export async function startServerForeground(
  options: ParsedServerOptions,
): Promise<{ origin: string }> {
  const version = getVersion();
  const running = await startServer({
    host: options.host,
    port: options.port,
    logLevel: options.logLevel,
    debugEndpoints: options.debugEndpoints,
    webAssetsDir: serverWebAssetsDir(),
    coreProcessOptions: {
      identity: createKimiCodeHostIdentity(version),
    },
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    running.logger.info({ signal }, 'server shutting down');
    try {
      await running.close();
      process.exit(0);
    } catch (error) {
      running.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'server shutdown error',
      );
      process.exit(1);
    }
  };
  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal);
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  return { origin: serverOrigin(options.host, options.port) };
}

function serverWebAssetsDir(): string {
  return resolveServerWebAssetsDir();
}

export function resolveServerWebAssetsDir(
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string {
  return nativeWebAssetsDir ?? join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

interface AlreadyRunningDetails {
  readonly mode: 'background' | 'foreground';
  readonly pid: number;
  readonly url: string;
  readonly stopCommand: string;
}

function describeAlreadyRunning(
  existing: { readonly pid: number; readonly port: number; readonly host?: string },
  status: ServiceStatus | undefined,
): AlreadyRunningDetails {
  const mode = isBackgroundServer(existing, status) ? 'background' : 'foreground';
  const host = status?.host ?? existing.host ?? DEFAULT_SERVER_HOST;
  return {
    mode,
    pid: existing.pid,
    url: serverOrigin(host === '0.0.0.0' ? DEFAULT_SERVER_HOST : host, status?.port ?? existing.port),
    stopCommand: mode === 'background' ? 'kimi server stop' : formatForegroundStopCommand(existing.pid),
  };
}

function isBackgroundServer(
  existing: { readonly pid: number; readonly port: number },
  status: ServiceStatus | undefined,
): boolean {
  if (status?.running !== true) return false;
  if (status.pid !== undefined) return status.pid === existing.pid;
  if (status.port !== undefined) return status.port === existing.port;
  return status.installed;
}

export function formatForegroundStopCommand(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return `taskkill /PID ${String(pid)} /T /F`;
  return `kill -TERM ${String(pid)}`;
}

function formatAlreadyRunning(details: AlreadyRunningDetails): string {
  return [
    `Kimi server already running in ${details.mode} (pid ${String(details.pid)}).`,
    `URL: ${details.url}`,
    `Stop: ${details.stopCommand}`,
    '',
  ].join('\n');
}

function formatForegroundReadyBanner(origin: string, readyMs: number): string {
  const primary = (text: string): string => chalk.hex(darkColors.primary)(text);
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const url = chalk.hex(darkColors.accent)(displayOrigin(origin));
  const width = READY_PANEL_WIDTH;
  const innerWidth = width - 4;
  const pad = '  ';

  const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
  const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
  const gap = '  ';
  const textWidth = innerWidth - logoWidth - gap.length;
  const headerLines = [
    primary(logo[0].padEnd(logoWidth)) +
      gap +
      truncateToWidth(title('Kimi server ready'), textWidth, '…'),
    primary(logo[1].padEnd(logoWidth)) +
      gap +
      truncateToWidth(dim('Local web UI is available from this machine.'), textWidth, '…'),
  ];
  const infoLines = [
    label('URL:      ') + url,
    label('Network:  ') + muted('local only'),
    label('Logs:     ') + muted('off') + dim('  use --log-level info to enable'),
    label('Stop:     ') + muted('Ctrl+C'),
    label('Ready:    ') + muted(`${String(Math.max(0, readyMs))} ms`),
    label('Version:  ') + muted(getVersion()),
  ];
  const contentLines = [...headerLines, '', ...infoLines];

  const lines = [
    '',
    primary('╭' + '─'.repeat(width - 2) + '╮'),
    primary('│') + ' '.repeat(width - 2) + primary('│'),
  ];

  for (const content of contentLines) {
    const truncated = truncateToWidth(content, innerWidth, '…');
    const rightPad = Math.max(0, innerWidth - visibleWidth(truncated));
    lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
  }

  lines.push(primary('│') + ' '.repeat(width - 2) + primary('│'));
  lines.push(primary('╰' + '─'.repeat(width - 2) + '╯'));
  lines.push('');
  return lines.join('\n');
}

function displayOrigin(origin: string): string {
  return origin.endsWith('/') ? origin : `${origin}/`;
}

const DEFAULT_RUN_COMMAND_DEPS: RunCommandDeps = {
  startServerForeground,
  getServiceStatus: async () => {
    try {
      return await resolveServiceManager().status();
    } catch {
      return undefined;
    }
  },
  openUrl: defaultOpenUrl,
  stdout: process.stdout,
  stderr: process.stderr,
};
