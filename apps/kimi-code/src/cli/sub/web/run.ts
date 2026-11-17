import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createServerLogger, startServer, type ServerLogger } from '@moonshot-ai/kap-server';
import { shutdownTelemetry, track } from '@moonshot-ai/kimi-telemetry';
import chalk from 'chalk';
import { type Command, Option } from 'commander';

import { CLI_MSH_PLATFORM, CLI_SHUTDOWN_TIMEOUT_MS, CLI_USER_AGENT_PRODUCT, WEB_USER_AGENT_SUFFIX } from '#/constant/app';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { persistedKimiOAuthRef } from '#/utils/region';
import { generateRemoteControlQr } from '#/utils/remote-control-qr';

import { initializeServerTelemetry } from '../../telemetry';
import { createKimiCodeHostIdentity } from '../../host-identity';
import { getHostPackageRoot, getVersion } from '../../version';
import {
  accessUrlLines,
  browserOpenOrigin,
  buildOpenableUrl,
  isLoopbackHost,
  splitTokenFragment,
} from './access-urls';
import { type NetworkAddress } from './networks';
import {
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  startRemoteControl,
  type RemoteControlHandle,
  type RemoteControlOptions,
  type RemoteControlStatus,
} from './remote-control';
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

interface RoutedServer {
  readonly address: string;
  readonly logger: ServerLogger;
  close(): Promise<void>;
}

export interface WebCliOptions extends ServerCliOptions {
  open?: boolean;
  remoteControl?: boolean;
}

export interface ForegroundControls {
  requestShutdown(reason: string): void;
}

export interface StartForegroundHooks {
  onReady?: (origin: string, controls?: ForegroundControls) => void | Promise<void>;
  onShutdown?: (reason: string) => void | Promise<void>;
}

export interface WebCommandDeps {
  startServerForeground?: (
    options: ParsedServerOptions,
    hooks?: StartForegroundHooks,
  ) => Promise<never>;
  startRemoteControl?: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
  openUrl(url: string): void;
  resolveToken?: () => string | undefined;
  networkAddresses?: NetworkAddress[];
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export function buildWebUrl(origin: string, token: string): string {
  return buildOpenableUrl(origin, token);
}

export function buildWebCommand(
  cmd: Command,
  opts: { forceRemoteControl?: boolean; defaultOpen?: boolean } = {},
): Command {
  const forceRemoteControl = opts.forceRemoteControl === true;
  const defaultOpen = opts.defaultOpen ?? true;
  const withServerOptions = cmd
    .option(
      '--port <port>',
      `Bind port (default ${DEFAULT_SERVER_PORT})`,
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--host [host]',
      `Bind host. Omit to bind ${DEFAULT_SERVER_HOST} (this machine only); pass --host to bind ${DEFAULT_LAN_HOST} (all interfaces), or --host <host> for a specific host. The bearer token is printed at startup.`,
    )
    .option(
      '--allowed-host <host...>',
      'Extra Host header value to allow through the DNS-rebinding check. Repeat or comma-separate; a leading dot matches a domain suffix (e.g. .example.com).',
    )
    .option(
      '--insecure-no-tls',
      'Allow a non-loopback bind without a TLS-terminating reverse proxy. Defaults to true; only relevant for non-loopback binds.',
      true,
    )
    .option(
      '--allow-remote-shutdown',
      'On a non-loopback bind, keep POST /api/v1/shutdown enabled (default: route is disabled → 404).',
      false,
    )
    .option(
      '--dangerous-bypass-auth',
      'Disable bearer-token auth on every REST and WebSocket route, and advertise it via /api/v1/meta so the web UI connects without a token. Only use on a trusted network or behind your own authenticating proxy.',
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
      '--web-title <title>',
      'Set a custom browser tab title for this web UI instance (default: "<workspace dir> | Kimi Code").',
    );
  withServerOptions.addOption(new Option('--socket <path>').hideHelp());
  withServerOptions.addOption(new Option('--managed-by <owner>').hideHelp());
  if (!forceRemoteControl) {
    withServerOptions.addOption(
      new Option(
        '--rc, --remote-control',
        'Expose the web UI through Kimi Remote Control.',
      ).default(false),
    );
  }
  if (defaultOpen) {
    withServerOptions.option('--no-open', 'Do not open the web UI in the default browser.', true);
  } else {
    withServerOptions.option('--open', 'Open the web UI in the default browser.', false);
    withServerOptions.addOption(new Option('--no-open').hideHelp());
  }
  return withServerOptions.action(async (opts: WebCliOptions) => {
      try {
        await handleWebCommand(
          forceRemoteControl ? { ...opts, remoteControl: true } : opts,
        );
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
  if (opts.remoteControl === true && parsed.dangerousBypassAuth) {
    throw new Error('--remote-control cannot be combined with --dangerous-bypass-auth.');
  }
  if (opts.remoteControl === true && !isLoopbackHost(parsed.host)) {
    throw new Error('--remote-control requires a loopback host.');
  }
  const run = deps.startServerForeground ?? startServerForeground;
  let remoteControl: RemoteControlHandle | undefined;
  await run(parsed, {
    onReady: async (origin, controls) => {
      if (parsed.socketPath !== undefined) return;
      const token = parsed.dangerousBypassAuth ? undefined : deps.resolveToken?.();
      if (opts.remoteControl === true) {
        if (token === undefined) throw new Error('Unable to read the local server token.');
        const dataDir = getDataDir();
        const persisted = persistedKimiOAuthRef();
        let outputReady = false;
        const pendingStatuses: string[] = [];
        const onStatus = (status: RemoteControlStatus): void => {
          const line = formatRemoteControlStatus(status);
          if (outputReady) deps.stdout.write(line);
          else pendingStatuses.push(line);
        };
        remoteControl = await (deps.startRemoteControl ?? startRemoteControl)({
          homeDir: dataDir,
          localOrigin: origin,
          localServerToken: token,
          clientVersion: `${CLI_USER_AGENT_PRODUCT}/${getVersion()}`,
          urlSource: CLI_MSH_PLATFORM,
          configuredOAuthKey: persisted?.key,
          configuredOAuthHost: persisted?.oauthHost,
          stderr: deps.stderr,
          onStatus,
        });
        void remoteControl.closed.then(
          (reason) => {
            if (reason === 'user_requested') {
              controls?.requestShutdown('remote_control_user_requested');
            }
          },
          (error) => {
            deps.stderr.write(
              `Remote Control lock release failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            controls?.requestShutdown('remote_control_closed');
          },
        );
        const qrCode = await generateRemoteControlQr(remoteControl.url, dataDir);
        deps.stdout.write(
          formatRemoteControlOutput({
            url: remoteControl.url,
            localOrigin: origin,
            localServerToken: token,
            deviceName: remoteControl.deviceName,
            qrCode: qrCode.terminal,
            pngPath: qrCode.pngPath,
          }),
        );
        outputReady = true;
        for (const line of pendingStatuses) deps.stdout.write(line);
        if (opts.open === true) deps.openUrl(remoteControl.url);
        return;
      }
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
        const openOrigin = browserOpenOrigin(origin);
        deps.openUrl(token !== undefined ? buildWebUrl(openOrigin, token) : openOrigin);
      }
    },
    onShutdown: async () => {
      await remoteControl?.close();
    },
  });
}

function formatReadyLine(
  origin: string,
  token: string | undefined,
  dangerousBypassAuth = false,
): string {
  const notice = dangerousBypassAuth
    ? `${formatDangerNoticeLines().join('\n')}\n`
    : '';
  return `${notice}Kimi server: ${buildOpenableUrl(origin, token)}\n`;
}

function formatDangerNoticeLines(): string[] {
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  return [
    `  ${dangerBold('⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).')}`,
    `  ${danger('Anyone who can reach this port gets full access. Only continue if you understand the risk.')}`,
    `  ${danger('If you are unsure, stop this process now with ')}${dangerBold('Ctrl+C')}${danger('.')}`,
  ];
}

export async function startServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
): Promise<never> {
  return runServerInProcess(options, hooks);
}

async function runServerInProcess(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks,
): Promise<never> {
  const version = getVersion();
  initializeServerTelemetry({ version });

  let running: RoutedServer | undefined;
  let stopping = false;

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    running?.logger.info({ reason }, 'server shutting down');
    try {
      await hooks.onShutdown?.(reason);
    } catch (error) {
      running?.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'foreground shutdown hook error',
      );
    }
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

  const logger = createServerLogger({ level: options.logLevel });
  const webAssetsDir = serverWebAssetsDir();
  if (webAssetsDir === undefined) {
    logger.info(
      'dev mode: web assets not built; starting the API server without the web UI',
    );
  }
  const v2 = await startServer({
    host: options.host,
    port: options.port,
    serverVersion: version,
    hostIdentity: {
      ...createKimiCodeHostIdentity(version),
      userAgentSuffix: WEB_USER_AGENT_SUFFIX,
    },
    logLevel: options.logLevel,
    logger,
    debugEndpoints: options.debugEndpoints,
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowedHosts: options.allowedHosts,
    disableAuth: options.dangerousBypassAuth,
    webTitle: options.webTitle,
    socketPath: options.socketPath,
    managedBy: options.managedBy,
    telemetry: true,
    webAssetsDir,
  });
  logger.info('serving the REST/WS API and the bundled web UI');
  running = {
    address:
      options.socketPath === undefined ? `http://${v2.host}:${v2.port}` : `unix:${options.socketPath}`,
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

  try {
    await hooks.onReady?.(running.address, {
      requestShutdown: (reason) => void shutdown(reason),
    });
  } catch (error) {
    try {
      await hooks.onShutdown?.('startup_failed');
    } finally {
      await running.close();
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS }).catch(() => {});
    }
    throw error;
  }

  return new Promise<never>(() => {});
}

export function serverWebAssetsDir(
  env: NodeJS.ProcessEnv = process.env,
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string | undefined {
  const dir = resolveServerWebAssetsDir(nativeWebAssetsDir);
  if (env['KIMI_CODE_DEV_SERVER'] === '1' && !existsSync(join(dir, 'index.html'))) {
    return undefined;
  }
  return dir;
}

export function resolveServerWebAssetsDir(
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string {
  return nativeWebAssetsDir ?? join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

interface FormatReadyBannerOptions {
  token?: string;
  networkAddresses?: NetworkAddress[];
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
  const urlWithDimToken = (href: string): string => {
    const [base, frag] = splitTokenFragment(href);
    return frag === '' ? url(base) : url(base) + dim(frag);
  };

  const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
  const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
  const lines: string[] = [
    '',
    `  ${primary(logo[0])}  ${title('Kimi server ready')}  ${dim(getVersion())}`,
    `  ${primary(logo[1])}  ${dim('Local web UI is available from this machine.')}`,
    '',
  ];

  if (opts.dangerousBypassAuth === true) {
    lines.push(...formatDangerNoticeLines(), '');
  }

  for (const { label: text, url: href } of accessUrlLines(
    host,
    port,
    opts.token,
    opts.networkAddresses,
  )) {
    lines.push(`  ${label(text)}${urlWithDimToken(href)}`);
  }
  if (isLoopbackHost(host)) {
    lines.push(`  ${label('Network:  ')}${muted('off')}${dim('  use --host to enable')}`);
  }
  if (opts.token !== undefined) {
    lines.push('');
    lines.push(`  ${label('Token:    ')}${opts.token}`);
    lines.push('');
  }

  lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  lines.push(`  ${label('Stop:     ')}${muted('Ctrl+C')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  startServerForeground,
  openUrl: defaultOpenUrl,
  resolveToken: () => {
    return tryResolveServerToken(getDataDir());
  },
  stdout: process.stdout,
  stderr: process.stderr,
};
