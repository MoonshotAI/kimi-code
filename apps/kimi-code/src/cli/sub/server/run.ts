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

import { join } from 'node:path';

import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { shutdownTelemetry, track } from '@moonshot-ai/kimi-telemetry';
import { startServer, type RunningServer } from '@moonshot-ai/server';
import chalk from 'chalk';
import { Option, type Command } from 'commander';

import { CLI_SHUTDOWN_TIMEOUT_MS, WEB_UI_MODE } from '#/constant/app';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import { initializeServerTelemetry } from '../../telemetry';
import { createKimiCodeHostIdentity, getHostPackageRoot, getVersion } from '../../version';
import { ensureDaemon } from './daemon';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
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
  startServerBackground(options: ParsedServerOptions): Promise<{ origin: string }>;
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
      `Log level for the background daemon: ${VALID_LOG_LEVELS.join('|')}. Omit to keep logs off.`,
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
    .addOption(
      new Option('--daemon', 'Run as an idle-exiting background daemon (internal).').hideHelp(),
    )
    .addOption(
      new Option(
        '--idle-grace-ms <ms>',
        'Idle-shutdown grace in ms (daemon mode, internal).',
      ).hideHelp(),
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
  if (parsed.daemon) {
    await startServerDaemon(parsed);
    return;
  }
  const startedAt = Date.now();
  const { origin } = await deps.startServerBackground(parsed);
  const readyMs = Date.now() - startedAt;
  deps.stdout.write(
    parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL
      ? formatReadyBanner(origin, readyMs)
      : `Kimi server: ${origin}\n`,
  );
  if (opts.open === true) {
    deps.openUrl(origin);
  }
}

/**
 * `kimi server run` (non-daemon) — ensures a background daemon is running
 * (spawning a detached `kimi server run --daemon` child if needed), then
 * returns its origin so the caller can print the ready banner and exit. The
 * server keeps running in the background after this returns.
 */
export async function startServerBackground(
  options: ParsedServerOptions,
): Promise<{ origin: string }> {
  const { origin } = await ensureDaemon({
    port: options.port,
    logLevel: options.logLevel,
    debugEndpoints: options.debugEndpoints,
    idleGraceMs: options.idleGraceMs,
  });
  return { origin };
}

/**
 * `kimi server run --daemon` — runs the local server as a background daemon.
 *
 * Spawned as a detached child by {@link startServerBackground}. The process is
 * expected to be detached (no controlling terminal) and self-terminates after
 * the last web client disconnects and a grace period elapses. The grace timer
 * is driven by the WS connection count reported through `wsGatewayOptions`.
 * Resolves only via `process.exit`.
 */
export async function startServerDaemon(options: ParsedServerOptions): Promise<never> {
  const version = getVersion();
  const telemetry = initializeServerTelemetry({ version });

  let running: RunningServer | undefined;
  let stopping = false;

  const idle = createIdleShutdownHandler({
    graceMs: options.idleGraceMs,
    onIdle: () => {
      void shutdown('idle');
    },
  });

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    idle.cancel();
    running?.logger.info({ reason }, 'server shutting down');
    try {
      await running?.close();
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    } catch (error) {
      running?.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'server shutdown error',
      );
    }
    process.exit(0);
  }

  running = await startServer({
    host: options.host,
    port: options.port,
    logLevel: options.logLevel,
    debugEndpoints: options.debugEndpoints,
    webAssetsDir: serverWebAssetsDir(),
    coreProcessOptions: {
      identity: createKimiCodeHostIdentity(version),
      telemetry,
    },
    wsGatewayOptions: {
      telemetry,
      onConnectionCountChange: (size) => {
        idle.onConnectionCountChange(size);
      },
    },
  });

  track('server_started', { ui_mode: WEB_UI_MODE, daemon: true });

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  running.logger.info(
    { address: running.address, idleGraceMs: options.idleGraceMs },
    'daemon ready',
  );

  return new Promise<never>(() => {
    // Keeps the event loop alive; the process ends via shutdown()/process.exit.
  });
}

/**
 * Pure idle-shutdown state machine, exported for tests.
 *
 * Watches the live WS connection count and fires `onIdle` exactly once, after
 * the count has dropped back to zero for `graceMs` ms *and* at least one
 * client had connected since startup. A reconnect before the grace elapses
 * cancels the pending exit. The initial "no clients yet" state never arms the
 * timer (so a freshly-spawned daemon is not killed before anyone connects).
 */
export function createIdleShutdownHandler(opts: { graceMs: number; onIdle: () => void }): {
  onConnectionCountChange(size: number): void;
  cancel(): void;
} {
  let timer: NodeJS.Timeout | undefined;
  let seenClient = false;

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    onConnectionCountChange(size: number): void {
      if (size > 0) {
        seenClient = true;
        cancel();
        return;
      }
      if (seenClient) {
        cancel();
        timer = setTimeout(opts.onIdle, opts.graceMs);
      }
    },
    cancel,
  };
}

function serverWebAssetsDir(): string {
  return resolveServerWebAssetsDir();
}

export function resolveServerWebAssetsDir(
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string {
  return nativeWebAssetsDir ?? join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

function formatReadyBanner(origin: string, readyMs: number): string {
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
    label('Stop:     ') + muted('kimi server kill'),
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
  startServerBackground,
  openUrl: defaultOpenUrl,
  stdout: process.stdout,
  stderr: process.stderr,
};
