/**
 * `kimi server run` — starts the local server.
 *
 * By default this ensures a single background daemon is running (spawning a
 * detached `kimi server run --daemon` child when needed) and returns once it is
 * healthy. Pass `--foreground` to run the server in-process and keep this
 * terminal attached until SIGINT/SIGTERM. OS-managed background operation
 * (launchd / systemd / schtasks) lives in `kimi server install` + `kimi server start`.
 *
 * `kimi web` is an alias of this command with `--open` defaulted to `true`,
 * registered in `./web-alias.ts`.
 */

import { join } from 'node:path';

import { shutdownTelemetry, track } from '@moonshot-ai/kimi-telemetry';
import { startServer, type RunningServer } from '@moonshot-ai/server';
import chalk from 'chalk';
import { Option, type Command } from 'commander';

import { CLI_SHUTDOWN_TIMEOUT_MS, WEB_UI_MODE } from '#/constant/app';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';

import { initializeServerTelemetry } from '../../telemetry';
import { createKimiCodeHostIdentity, getHostPackageRoot, getVersion } from '../../version';
import { accessUrlLines, buildOpenableUrl, splitTokenFragment } from './access-urls';
import { ensureDaemon } from './daemon';
import { type NetworkAddress } from './networks';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  tryResolveServerToken,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';

export interface RunCliOptions extends ServerCliOptions {
  open?: boolean;
  /** Run the server in-process instead of spawning a background daemon. */
  foreground?: boolean;
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string) => void;
}

export interface RunCommandDeps {
  startServerBackground(options: ParsedServerOptions): Promise<{ origin: string }>;
  /** Foreground runner; defaults to the real in-process runner when omitted. */
  startServerForeground?: (
    options: ParsedServerOptions,
    hooks?: StartForegroundHooks,
  ) => Promise<never>;
  openUrl(url: string): void;
  /**
   * Best-effort read of the server's persistent bearer token. When it returns
   * a token, the ready banner prints it and the opened Web UI URL carries it in
   * the `#token=` fragment (M5.5). Optional so callers/tests that don't supply
   * it simply print/open the plain origin.
   */
  resolveToken?: () => string | undefined;
  /**
   * Non-loopback interface addresses to display for a wildcard bind. Defaults
   * to the machine's own interfaces (`listNetworkAddresses()`); inject a fixed
   * list in tests for deterministic output.
   */
  networkAddresses?: NetworkAddress[];
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * Build the Web UI URL, carrying the bearer token in the URL fragment.
 *
 * The token rides in `#token=<token>` — a client-side fragment that is never
 * sent to the server (so it never appears in server access logs) and is not
 * logged by proxies. The Web UI reads it from `location.hash` after load.
 */
export function buildWebUrl(origin: string, token: string): string {
  return buildOpenableUrl(origin, token);
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
      '--host <host>',
      `Bind host (default ${DEFAULT_SERVER_HOST}). Use 0.0.0.0 to listen on all interfaces (requires --insecure-no-tls unless behind a TLS proxy). The bearer token is printed at startup.`,
      String(DEFAULT_SERVER_HOST),
    )
    .option(
      '--insecure-no-tls',
      'Allow a non-loopback bind without a TLS-terminating reverse proxy. Required to bind beyond 127.0.0.1; use a tunnel or reverse proxy in production.',
      false,
    )
    .option(
      '--allow-remote-shutdown',
      'On a non-loopback bind, keep POST /api/v1/shutdown enabled (default: route is disabled → 404).',
      false,
    )
    .option(
      '--allow-remote-terminals',
      'On a non-loopback bind, keep the PTY /api/v1/terminals/* routes enabled (default: disabled → 404). Remote shell is high risk.',
      false,
    )
    .option(
      '--log-level <level>',
      `Server log level: ${VALID_LOG_LEVELS.join('|')}. Omit to keep logs off.`,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection. OFF by default; production callers leave this unset.',
      false,
    )
    .option(
      '--foreground',
      'Run the server in the foreground and keep this terminal attached until SIGINT/SIGTERM (do not daemonize).',
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
  // Resolve the persistent token once: it is printed in the ready banner and
  // rides in the opened Web UI URL's `#token=` fragment (M5.5). Falls back to
  // the plain origin / no token line when unavailable.
  const writeReady = (origin: string): void => {
    const token = deps.resolveToken?.();
    deps.stdout.write(
      parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL
        ? formatReadyBanner(origin, parsed.host, {
            token,
            networkAddresses: deps.networkAddresses,
          })
        : formatReadyLine(origin, token),
    );
    if (opts.open === true) {
      deps.openUrl(token !== undefined ? buildWebUrl(origin, token) : origin);
    }
  };
  if (opts.foreground === true) {
    const run = deps.startServerForeground ?? startServerForeground;
    await run(parsed, { onReady: writeReady });
    return;
  }
  const { origin } = await deps.startServerBackground(parsed);
  writeReady(origin);
}

function formatReadyLine(origin: string, token: string | undefined): string {
  return `Kimi server: ${buildOpenableUrl(origin, token)}\n`;
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
    host: options.host,
    port: options.port,
    logLevel: options.logLevel,
    debugEndpoints: options.debugEndpoints,
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowRemoteTerminals: options.allowRemoteTerminals,
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
  return runServerInProcess(options, { daemon: true });
}

/**
 * `kimi server run --foreground` — runs the local server in-process, attached
 * to the current terminal. Resolves only via `process.exit` (SIGINT/SIGTERM).
 */
export async function startServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
): Promise<never> {
  return runServerInProcess(options, { daemon: false }, hooks.onReady);
}

/**
 * Start the server in the current process and block until shutdown. Shared by
 * the detached daemon (`daemon: true`, with idle-exit) and the foreground
 * runner (`daemon: false`). `onReady` fires once the server is listening.
 */
async function runServerInProcess(
  options: ParsedServerOptions,
  mode: { daemon: boolean },
  onReady?: (origin: string) => void,
): Promise<never> {
  const version = getVersion();
  const telemetry = initializeServerTelemetry({ version });

  let running: RunningServer | undefined;
  let stopping = false;

  const idle = mode.daemon
    ? createIdleShutdownHandler({
        graceMs: options.idleGraceMs,
        onIdle: () => {
          void shutdown('idle');
        },
      })
    : undefined;

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    idle?.cancel();
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
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowRemoteTerminals: options.allowRemoteTerminals,
    webAssetsDir: serverWebAssetsDir(),
    coreProcessOptions: {
      identity: createKimiCodeHostIdentity(version),
      telemetry,
    },
    wsGatewayOptions: {
      telemetry,
      onConnectionCountChange: idle
        ? (size) => {
            idle.onConnectionCountChange(size);
          }
        : undefined,
    },
  });

  track('server_started', { ui_mode: WEB_UI_MODE, daemon: mode.daemon });

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const readyFields = mode.daemon
    ? { address: running.address, idleGraceMs: options.idleGraceMs }
    : { address: running.address };
  running.logger.info(readyFields, mode.daemon ? 'daemon ready' : 'server ready');

  onReady?.(running.address);

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

interface FormatReadyBannerOptions {
  /** Persistent bearer token to print; omitted when unresolvable. */
  token?: string;
  /** Non-loopback interface addresses to list for a wildcard bind. */
  networkAddresses?: NetworkAddress[];
}

function formatReadyBanner(
  origin: string,
  host: string,
  opts: FormatReadyBannerOptions = {},
): string {
  const primary = (text: string): string => chalk.hex(darkColors.primary)(text);
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const url = (text: string): string => chalk.hex(darkColors.accent)(text);
  // Render the `#token=…` fragment in a de-emphasized gray so the host/port
  // stands out while the full URL stays selectable for copying.
  const urlWithDimToken = (href: string): string => {
    const [base, frag] = splitTokenFragment(href);
    return frag === '' ? url(base) : url(base) + dim(frag);
  };

  const port = Number(new URL(origin).port);
  // Borderless header: the Kimi sprite (the little mascot with eyes) sits next
  // to the title, keeping the brand without the enclosing box.
  const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
  const lines: string[] = [
    '',
    `  ${primary(logo[0])}  ${title('Kimi server ready')}  ${dim(getVersion())}`,
    `  ${primary(logo[1])}  ${dim('Local web UI is available from this machine.')}`,
    '',
  ];

  // Access links.
  for (const { label: text, url: href } of accessUrlLines(
    host,
    port,
    opts.token,
    opts.networkAddresses,
  )) {
    lines.push(`  ${label(text)}${urlWithDimToken(href)}`);
  }
  if (opts.token !== undefined) {
    // Set the token off with surrounding whitespace rather than color, so it is
    // easy to spot without being highlighted.
    lines.push('');
    lines.push(`  ${label('Token:    ')}${opts.token}`);
    lines.push('');
  }

  // Auxiliary controls last.
  lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  lines.push(`  ${label('Stop:     ')}${muted('kimi server kill')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_RUN_COMMAND_DEPS: RunCommandDeps = {
  startServerBackground,
  startServerForeground,
  openUrl: defaultOpenUrl,
  resolveToken: () => {
    // Read the persistent `<homeDir>/server.token` written on first boot
    // (M5.1). Best-effort: a missing/older server yields undefined and the
    // caller opens the plain origin.
    return tryResolveServerToken(getDataDir());
  },
  stdout: process.stdout,
  stderr: process.stderr,
};
