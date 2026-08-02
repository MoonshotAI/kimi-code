/**
 * `kimi web` — run the local server in the foreground and open the web UI.
 *
 * The server always runs in the current process, attached to the terminal,
 * and shuts down cleanly on SIGINT/SIGTERM. `--no-open` skips the browser.
 * Multiple instances can share the home directory: each registers itself in
 * the instance registry and takes the next free port (see kap-server's
 * `startServer`).
 */

import { join } from 'node:path';

import { createServerLogger, startServer, type ServerLogger } from '@moonshot-ai/kap-server';
import { shutdownTelemetry, track } from '@moonshot-ai/kimi-telemetry';
import chalk from 'chalk';
import { type Command } from 'commander';

import { CLI_SHUTDOWN_TIMEOUT_MS } from '#/constant/app';
import { t } from '#/i18n';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';

import { initializeServerTelemetry } from '../../telemetry';
import { getHostPackageRoot, getVersion } from '../../version';
import {
  accessUrlLines,
  buildOpenableUrl,
  isLoopbackHost,
  splitTokenFragment,
} from './access-urls';
import { type NetworkAddress } from './networks';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_LAN_HOST,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  tryResolveServerToken,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';

/**
 * Minimal surface `runServerInProcess` needs from the server. kap-server's
 * `RunningServer` is adapted to it (it returns `{ host, port, close }`
 * instead of `{ address, logger, close }`).
 */
interface RoutedServer {
  readonly address: string;
  readonly logger: ServerLogger;
  close(): Promise<void>;
}

export interface WebCliOptions extends ServerCliOptions {
  open?: boolean;
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string) => void;
}

export interface WebCommandDeps {
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

/** Build the `web` command, mounting the runner action on `cmd` itself. */
export function buildWebCommand(cmd: Command): Command {
  return cmd
    .option(
      '--port <port>',
      t('cli.optionDescriptions.serverRunOptionPort', { port: String(DEFAULT_SERVER_PORT) }),
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--host [host]',
      t('cli.optionDescriptions.serverRunOptionHost', {
        host: DEFAULT_SERVER_HOST,
        lanHost: DEFAULT_LAN_HOST,
      }),
    )
    .option('--allowed-host <host...>', t('cli.optionDescriptions.serverRunOptionAllowedHost'))
    .option('--insecure-no-tls', t('cli.optionDescriptions.serverRunOptionInsecureNoTls'), true)
    .option(
      '--allow-remote-shutdown',
      t('cli.optionDescriptions.serverRunOptionAllowRemoteShutdown'),
      false,
    )
    .option(
      '--dangerous-bypass-auth',
      t('cli.optionDescriptions.serverRunOptionDangerousBypassAuth'),
      false,
    )
    .option(
      '--log-level <level>',
      t('cli.optionDescriptions.serverRunOptionLogLevel', { levels: VALID_LOG_LEVELS.join('|') }),
    )
    .option('--no-open', t('cli.optionDescriptions.serverRunOptionNoOpen'), true)
    .action(async (opts: WebCliOptions) => {
      try {
        await handleWebCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleWebCommand(
  opts: WebCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  const parsed = parseServerOptions(opts);
  const run = deps.startServerForeground ?? startServerForeground;
  await run(parsed, {
    onReady: (origin) => {
      // Resolve the persistent token only once the server is up: a fresh
      // server writes `server.token` on first boot, so reading it beforehand
      // would miss first-time starts and the browser would hit the auth gate.
      // It is printed in the ready banner and rides in the opened Web UI
      // URL's `#token=` fragment (M5.5); falls back to the plain origin / no
      // token line when unavailable. When auth is bypassed, the token is
      // meaningless and is intentionally NOT shown or carried in the URL.
      const token = parsed.dangerousBypassAuth ? undefined : deps.resolveToken?.();
      deps.stdout.write(
        parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL
          ? formatReadyBanner(origin, parsed.host, {
              token,
              networkAddresses: deps.networkAddresses,
              dangerousBypassAuth: parsed.dangerousBypassAuth,
            })
          : formatReadyLine(origin, token, parsed.dangerousBypassAuth),
      );
      if (opts.open === true) {
        deps.openUrl(token !== undefined ? buildWebUrl(origin, token) : origin);
      }
    },
  });
}

function formatReadyLine(
  origin: string,
  token: string | undefined,
  dangerousBypassAuth = false,
): string {
  const notice = dangerousBypassAuth ? `${formatDangerNoticeLines().join('\n')}\n` : '';
  return `${notice}Kimi server: ${buildOpenableUrl(origin, token)}\n`;
}

/**
 * Red, impossible-to-miss notice emitted when `--dangerous-bypass-auth`
 * disables the bearer-token gate. Shared by the full ready banner and the
 * compact one-line output so the warning always shows regardless of log level.
 */
function formatDangerNoticeLines(): string[] {
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  return [
    `  ${dangerBold(t('tui.statusMessages.serverDangerAuthDisabled'))}`,
    `  ${danger(t('tui.statusMessages.serverDangerAnyoneAccess'))}`,
    `  ${danger('If you are unsure, stop this process now with ')}${dangerBold('Ctrl+C')}${danger('.')}`,
  ];
}

/**
 * `kimi web` — runs the local server in-process, attached to the current
 * terminal. Resolves only via `process.exit` (SIGINT/SIGTERM).
 */
export async function startServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
): Promise<never> {
  return runServerInProcess(options, hooks.onReady);
}

/**
 * Start the server in the current process and block until shutdown.
 * `onReady` fires once the server is listening.
 */
async function runServerInProcess(
  options: ParsedServerOptions,
  onReady?: (origin: string) => void,
): Promise<never> {
  const version = getVersion();
  // Registers the telemetry provider for `track` / `shutdownTelemetry`; the
  // client itself is not passed into kap-server.
  initializeServerTelemetry({ version });

  let running: RoutedServer | undefined;
  let stopping = false;

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
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

  // kap-server (the Rust engine server) is the only server flavor. Its
  // `startServer` returns `{ host, port, close }` rather than `{ address,
  // logger, close }`, so adapt it to the `RoutedServer` surface the rest of
  // this runner consumes.
  const logger = createServerLogger({ level: options.logLevel });
  const v2 = await startServer({
    host: options.host,
    port: options.port,
    // Report the CLI's product version as `server_version` (/meta, web UI)
    // rather than kap-server's private package version.
    version,
    logLevel: options.logLevel,
    logger,
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowedHosts: options.allowedHosts,
    disableAuth: options.dangerousBypassAuth,
    webAssetsDir: serverWebAssetsDir(),
  });
  logger.info('serving the REST/WS API and the bundled web UI');
  running = {
    address: `http://${v2.host}:${v2.port}`,
    logger,
    close: () => v2.close(),
  };

  track('server_started', { daemon: false });

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  running.logger.info({ address: running.address }, 'server ready');

  onReady?.(running.address);

  return new Promise<never>(() => {
    // Keeps the event loop alive; the process ends via shutdown()/process.exit.
  });
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
  /** When true, render a red danger notice (auth is disabled). */
  dangerousBypassAuth?: boolean;
}

export function formatReadyBanner(
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
    `  ${primary(logo[0])}  ${title(t('tui.statusMessages.serverReadyBanner'))}  ${dim(getVersion())}`,
    `  ${primary(logo[1])}  ${dim(t('tui.statusMessages.serverReadyLocalUi'))}`,
    '',
  ];

  if (opts.dangerousBypassAuth === true) {
    // Red, impossible-to-miss notice: the bearer-token gate is off, so anyone
    // who can reach this port gets full session / filesystem / shell access.
    lines.push(...formatDangerNoticeLines(), '');
  }

  // Access links.
  for (const { label: text, url: href } of accessUrlLines(
    host,
    port,
    opts.token,
    opts.networkAddresses,
  )) {
    lines.push(`  ${label(text)}${urlWithDimToken(href)}`);
  }
  // On a loopback bind there is no network URL; show how to enable one.
  if (isLoopbackHost(host)) {
    lines.push(`  ${label('Network:  ')}${muted('off')}${dim('  use --host to enable')}`);
  }
  if (opts.token !== undefined) {
    // Set the token off with surrounding whitespace rather than color, so it is
    // easy to spot without being highlighted.
    lines.push('');
    lines.push(
      `  ${label('Token:    ')}${opts.token.slice(0, 8)}...${opts.token.slice(-4)}  ${dim('(use --token to customize)')}`,
    );
    lines.push('');
  }

  // Auxiliary controls last.
  lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  // The server always runs in the foreground attached to this terminal.
  lines.push(`  ${label('Stop:     ')}${muted('Ctrl+C')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
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
