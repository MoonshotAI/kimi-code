import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  createServerLogger,
  KAP_VERSION,
  KIMI_AGENT_PROTOCOL_VERSION,
  startServer,
  type IAuthTokenService,
  type ServerLogger,
} from '@moonshot-ai/kap-server';
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
import {
  computeManagedDaemonEnvHashes,
  daemonLogPath,
  daemonSocketPath,
  enableDaemonRemoteControl,
  ensureSharedDaemon,
  isSharedDaemonSupported,
  removeDaemonStateForPid,
  writeDaemonState,
} from './daemon-client';
import { type NetworkAddress } from './networks';
import {
  formatRemoteControlAlreadyRunning,
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  RemoteControlAlreadyRunningError,
  startRemoteControl,
  type RemoteControlHandle,
  type RemoteControlOptions,
  type RemoteControlStatus,
} from './remote-control';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_LAN_HOST,
  DEFAULT_LOG_LEVEL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  tryResolveServerToken,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';

const FOREGROUND_ONLY_OPTION_ENTRIES = [
  ['host', '--host'],
  ['port', '--port'],
  ['allowedHost', '--allowed-host'],
  ['insecureNoTls', '--insecure-no-tls'],
  ['allowRemoteShutdown', '--allow-remote-shutdown'],
  ['dangerousBypassAuth', '--dangerous-bypass-auth'],
  ['logLevel', '--log-level'],
  ['debugEndpoints', '--debug-endpoints'],
  ['webTitle', '--web-title'],
] as const;

interface RoutedServer {
  readonly address: string;
  readonly logger: ServerLogger;
  close(): Promise<void>;
}

export interface WebCliOptions extends ServerCliOptions {
  open?: boolean;
  json?: boolean;
  remoteControl?: boolean;
  daemon?: boolean;
  daemonServer?: boolean;
  explicitServerFlags?: readonly string[];
}

export interface ForegroundControls {
  requestShutdown(reason: string): void;
}

export interface StartForegroundHooks {
  onReady?: (origin: string, controls?: ForegroundControls) => void | Promise<void>;
  onShutdown?: (reason: string) => void | Promise<void>;
}

export interface WebCommandDeps {
  platform?: NodeJS.Platform;
  homeDir?: () => string;
  env?: NodeJS.ProcessEnv;
  ensureSharedDaemon?: typeof ensureSharedDaemon;
  enableDaemonRemoteControl?: typeof enableDaemonRemoteControl;
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

export function collectExplicitForegroundFlags(opts: WebCliOptions): string[] {
  if (opts.explicitServerFlags !== undefined) {
    return [...opts.explicitServerFlags];
  }
  const flags: string[] = [];
  if (opts.host !== undefined && opts.host !== false) flags.push('--host');
  if (opts.port !== undefined && opts.port !== String(DEFAULT_SERVER_PORT)) flags.push('--port');
  if (opts.allowedHost !== undefined && opts.allowedHost.length > 0) flags.push('--allowed-host');
  if (opts.insecureNoTls === false) flags.push('--no-insecure-no-tls');
  if (opts.allowRemoteShutdown === true) flags.push('--allow-remote-shutdown');
  if (opts.dangerousBypassAuth === true) flags.push('--dangerous-bypass-auth');
  if (opts.logLevel !== undefined) flags.push('--log-level');
  if (opts.debugEndpoints === true) flags.push('--debug-endpoints');
  if (opts.webTitle !== undefined) flags.push('--web-title');
  return flags;
}

export function buildWebCommand(
  cmd: Command,
  opts: {
    forceRemoteControl?: boolean;
    defaultOpen?: boolean;
    includeHiddenDaemonServerFlag?: boolean;
  } = {},
): Command {
  const forceRemoteControl = opts.forceRemoteControl === true;
  const defaultOpen = opts.defaultOpen ?? true;
  const withServerOptions = cmd
    .allowExcessArguments(false)
    .option(
      '--port <port>',
      `Bind port (default ${DEFAULT_SERVER_PORT}; requires --no-daemon or --json)`,
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--host [host]',
      `Bind host (requires --no-daemon or --json). Omit to bind ${DEFAULT_SERVER_HOST}; pass --host to bind ${DEFAULT_LAN_HOST}, or --host <host> for a specific host.`,
    )
    .option(
      '--allowed-host <host...>',
      'Extra Host header value to allow through the DNS-rebinding check (requires --no-daemon or --json).',
    )
    .option(
      '--insecure-no-tls',
      'Allow a non-loopback bind without a TLS-terminating reverse proxy. Defaults to true; only relevant for non-loopback binds.',
      true,
    )
    .option(
      '--allow-remote-shutdown',
      'On a non-loopback bind, keep POST /api/v1/shutdown enabled (requires --no-daemon).',
      false,
    )
    .option(
      '--dangerous-bypass-auth',
      'Disable bearer-token auth on every REST and WebSocket route (requires --no-daemon).',
      false,
    )
    .option(
      '--log-level <level>',
      `Server log level: ${VALID_LOG_LEVELS.join('|')} (requires --no-daemon or --json).`,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection (requires --no-daemon).',
      false,
    )
    .option(
      '--web-title <title>',
      'Set a custom browser tab title for this web UI instance (requires --no-daemon).',
    )
    .option(
      '--no-daemon',
      'Run an independent server in the foreground until Ctrl+C instead of sharing the background daemon.',
    );
  withServerOptions.addOption(new Option('--socket <path>').hideHelp());
  withServerOptions.addOption(new Option('--managed-by <owner>').hideHelp());
  if (opts.includeHiddenDaemonServerFlag === true) {
    withServerOptions.addOption(new Option('--daemon-server').hideHelp());
  }
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
  if (!forceRemoteControl) {
    withServerOptions.option(
      '--json',
      'Start with an in-memory ephemeral bearer token (implies --no-open and --no-daemon) and emit a single ready JSON line on stdout.',
      false,
    );
  }
  return withServerOptions.action(async (cliOpts: WebCliOptions, command: Command) => {
    const explicitServerFlags = FOREGROUND_ONLY_OPTION_ENTRIES.filter(
      ([name]) => command.getOptionValueSource(name) === 'cli',
    ).map(([, flag]) => flag);
    try {
      await handleWebCommand({
        ...cliOpts,
        ...(forceRemoteControl ? { remoteControl: true } : {}),
        explicitServerFlags,
      });
    } catch (error) {
      const text =
        error instanceof RemoteControlAlreadyRunningError
          ? formatRemoteControlAlreadyRunning(error.holder)
          : error instanceof Error
            ? error.message
            : String(error);
      process.stderr.write(`${text}\n`);
      process.exit(1);
    }
  });
}

function createEphemeralAuthTokenService(secret: string): IAuthTokenService {
  const expected = Buffer.from(secret, 'utf8');
  return {
    _serviceBrand: undefined,
    getToken: () => secret,
    isValid: async (candidate: string) => {
      const actual = Buffer.from(candidate, 'utf8');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}

export function formatJsonBootLine(origin: string, token: string): string {
  const trimmed = origin.replace(/\/+$/, '');
  const schemeIdx = trimmed.indexOf('://');
  const scheme = schemeIdx >= 0 ? trimmed.slice(0, schemeIdx) : 'http';
  const hostPort = schemeIdx >= 0 ? trimmed.slice(schemeIdx + 3) : trimmed;
  const lastColon = hostPort.lastIndexOf(':');
  const rawHost = lastColon >= 0 ? hostPort.slice(0, lastColon) : hostPort;
  const portSuffix = lastColon >= 0 ? hostPort.slice(lastColon) : '';
  const canonicalHost =
    rawHost === '' || rawHost === '0.0.0.0'
      ? '127.0.0.1'
      : rawHost === '::'
        ? '[::1]'
        : rawHost.includes(':') && !rawHost.startsWith('[')
          ? `[${rawHost}]`
          : rawHost;
  const normalizedOrigin = `${scheme}://${canonicalHost}${portSuffix}`;
  const url = new URL(normalizedOrigin);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${url.host}/api/v1/ws`;
  return `${JSON.stringify({
    origin: normalizedOrigin,
    ws_url: wsUrl,
    token,
    kimi_agent_protocol_version: KIMI_AGENT_PROTOCOL_VERSION,
  })}\n`;
}

export async function handleWebCommand(
  opts: WebCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  const homeDir = (deps.homeDir ?? getDataDir)();
  if (opts.daemonServer === true) {
    await runDaemonServerInProcess(homeDir, deps.env ?? process.env);
    return;
  }

  const parsed = parseServerOptions(opts);
  const jsonMode = opts.json === true;
  if (jsonMode && opts.remoteControl === true) {
    throw new Error('--json cannot be combined with --remote-control.');
  }
  if (jsonMode && parsed.dangerousBypassAuth) {
    throw new Error('--json cannot be combined with --dangerous-bypass-auth.');
  }
  if (jsonMode && parsed.socketPath !== undefined) {
    throw new Error('--json cannot be combined with --socket.');
  }
  if (jsonMode && parsed.debugEndpoints) {
    throw new Error('--json cannot be combined with --debug-endpoints.');
  }
  if (jsonMode && parsed.allowRemoteShutdown) {
    throw new Error('--json cannot be combined with --allow-remote-shutdown.');
  }
  if (opts.remoteControl === true && parsed.dangerousBypassAuth) {
    throw new Error('--remote-control cannot be combined with --dangerous-bypass-auth.');
  }
  if (opts.remoteControl === true && !isLoopbackHost(parsed.host)) {
    throw new Error('--remote-control requires a loopback host.');
  }

  const useForeground =
    opts.daemon === false ||
    jsonMode ||
    parsed.socketPath !== undefined ||
    deps.startServerForeground !== undefined ||
    !isSharedDaemonSupported(deps.platform ?? process.platform);

  if (!useForeground) {
    const incompatibleFlags = collectExplicitForegroundFlags(opts);
    if (incompatibleFlags.length > 0) {
      throw new Error(
        `Cannot apply ${incompatibleFlags.join(', ')} to the shared background daemon. Re-run with '--no-daemon' to start an independent foreground server with these options.`,
      );
    }
    const env = deps.env ?? process.env;
    const ensured = await (deps.ensureSharedDaemon ?? ensureSharedDaemon)({
      homeDir,
      env,
      checkEnv: true,
    });
    if (ensured.reusedBusyMismatch) {
      deps.stderr.write(
        `Note: Kimi daemon ${ensured.daemon.version} has active work; continuing with the running daemon. Run 'kimi daemon restart' after work finishes to switch to ${getVersion()}.\n`,
      );
    }
    const token = (deps.resolveToken ?? (() => tryResolveServerToken(homeDir)))();
    if (opts.remoteControl === true) {
      if (token === undefined) throw new Error('Unable to read the local server token.');
      const rc = await (deps.enableDaemonRemoteControl ?? enableDaemonRemoteControl)(
        ensured.daemon.socketPath,
        env,
      );
      const qrCode = await generateRemoteControlQr(rc.url, homeDir);
      deps.stdout.write(
        formatRemoteControlOutput({
          url: rc.url,
          localOrigin: ensured.daemon.origin,
          localServerToken: token,
          deviceName: rc.deviceName,
          qrCode: qrCode.terminal,
          pngPath: qrCode.pngPath,
          logPath: ensured.daemon.logPath,
          stopCommand: 'kimi rc stop',
        }),
      );
      if (opts.open === true) deps.openUrl(rc.url);
      return;
    }
    deps.stdout.write(
      formatReadyBanner(ensured.daemon.origin, ensured.daemon.host, {
        token,
        networkAddresses: deps.networkAddresses,
        logPath: ensured.daemon.logPath,
        stopCommand: 'kimi daemon stop',
      }),
    );
    if (opts.open === true) {
      const openOrigin = browserOpenOrigin(ensured.daemon.origin);
      deps.openUrl(token !== undefined ? buildWebUrl(openOrigin, token) : openOrigin);
    }
    return;
  }

  const ephemeralToken = jsonMode ? randomBytes(32).toString('base64url') : undefined;
  const runOptions: ParsedServerOptions = jsonMode
    ? {
        ...parsed,
        authTokenService: createEphemeralAuthTokenService(ephemeralToken!),
        skipInstanceRegistry: true,
        logToStderr: true,
      }
    : parsed;
  const run = deps.startServerForeground ?? startServerForeground;
  let remoteControl: RemoteControlHandle | undefined;
  await run(runOptions, {
    onReady: async (origin, controls) => {
      if (parsed.socketPath !== undefined) return;
      if (jsonMode) {
        deps.stdout.write(formatJsonBootLine(origin, ephemeralToken!));
        return;
      }
      const token = parsed.dangerousBypassAuth
        ? undefined
        : (deps.resolveToken ?? (() => tryResolveServerToken(homeDir)))();
      if (opts.remoteControl === true) {
        if (token === undefined) throw new Error('Unable to read the local server token.');
        const persisted = persistedKimiOAuthRef();
        let outputReady = false;
        const pendingStatuses: string[] = [];
        const onStatus = (status: RemoteControlStatus): void => {
          const line = formatRemoteControlStatus(status);
          if (outputReady) deps.stdout.write(line);
          else pendingStatuses.push(line);
        };
        remoteControl = await (deps.startRemoteControl ?? startRemoteControl)({
          homeDir,
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
        const qrCode = await generateRemoteControlQr(remoteControl.url, homeDir);
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

async function runDaemonServerInProcess(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<never> {
  const version = getVersion();
  const startedAt = new Date().toISOString();
  const socketPath = daemonSocketPath(homeDir);
  const logPath = daemonLogPath(homeDir);
  initializeServerTelemetry({ version });

  const logger = createServerLogger({ level: DEFAULT_LOG_LEVEL });
  const webAssetsDir = serverWebAssetsDir(env);
  if (webAssetsDir === undefined) {
    logger.info('dev mode: web assets not built; starting the daemon without the web UI');
  }

  let exiting = false;

  const finalizeExit = async (): Promise<void> => {
    if (exiting) return;
    exiting = true;
    await removeDaemonStateForPid(homeDir, process.pid).catch(() => {});
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS }).catch(() => {});
    process.exit(0);
  };

  const v2 = await startServer({
    homeDir,
    env,
    host: DEFAULT_SERVER_HOST,
    port: DEFAULT_SERVER_PORT,
    socketPath,
    persistRemoteControl: true,
    managedBy: 'daemon',
    serverVersion: version,
    hostIdentity: {
      ...createKimiCodeHostIdentity(version),
      userAgentSuffix: WEB_USER_AGENT_SUFFIX,
    },
    logLevel: DEFAULT_LOG_LEVEL,
    logger,
    telemetry: true,
    webAssetsDir,
    onDidClose: async () => {
      await removeDaemonStateForPid(homeDir, process.pid).catch(() => {});
      setImmediate(() => {
        void finalizeExit();
      });
    },
  });

  const shutdownFromSignal = async (reason: string): Promise<void> => {
    if (exiting) return;
    logger.info({ reason }, 'daemon shutting down');
    try {
      await v2.close();
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'daemon shutdown error',
      );
    }
    await finalizeExit();
  };

  const origin = `http://${v2.host}:${String(v2.port)}`;
  await writeDaemonState(homeDir, {
    pid: process.pid,
    host: v2.host,
    port: v2.port,
    origin,
    socketPath,
    logPath,
    startedAt,
    version,
    kapVersion: KAP_VERSION,
    envHashes: computeManagedDaemonEnvHashes(env),
  });

  track('server_started', { daemon: true });
  process.once('SIGINT', () => {
    void shutdownFromSignal('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdownFromSignal('SIGTERM');
  });
  logger.info({ origin, socketPath }, 'daemon ready');

  return new Promise<never>(() => {});
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

  const logger = createServerLogger({
    level: options.logLevel,
    stream: options.logToStderr === true ? process.stderr : undefined,
  });
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
    authTokenService: options.authTokenService,
    skipInstanceRegistry: options.skipInstanceRegistry,
    disableAuth: options.dangerousBypassAuth,
    webTitle: options.webTitle,
    socketPath: options.socketPath,
    listenTcp: options.socketPath === undefined,
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
  logPath?: string;
  stopCommand?: string;
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
    lines.push(
      `  ${label('Network:  ')}${muted('off')}${dim(opts.stopCommand !== undefined ? '  use --no-daemon --host to enable' : '  use --host to enable')}`,
    );
  }
  if (opts.token !== undefined) {
    lines.push('');
    lines.push(`  ${label('Token:    ')}${opts.token}`);
    lines.push('');
  }

  if (opts.logPath !== undefined) {
    lines.push(`  ${label('Logs:     ')}${opts.logPath}`);
  } else {
    lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  }
  lines.push(`  ${label('Stop:     ')}${muted(opts.stopCommand ?? 'Ctrl+C')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  openUrl: defaultOpenUrl,
  resolveToken: () => {
    return tryResolveServerToken(getDataDir());
  },
  stdout: process.stdout,
  stderr: process.stderr,
};
