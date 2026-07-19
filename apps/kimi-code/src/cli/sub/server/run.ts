/**
 * `kimi server run` — starts the local server.
 *
 * By default this ensures a single background daemon is running (spawning a
 * detached `kimi server run --daemon` child when needed) and returns once it is
 * healthy. Pass `--foreground` to run the server in-process and keep this
 * terminal attached until SIGINT/SIGTERM. OS-managed background operation
 * (launchd / systemd / schtasks) lives in `kimi server install` + `kimi server start`.
 *
 * `kimi web` is an alias of this command (registered in `./web-alias.ts`) with
 * two flipped defaults: `--open` defaults to `true`, and it runs in the
 * foreground by default — pass `--background` to get the daemon behavior of
 * `kimi server run`.
 */

import { join } from 'node:path';

import { shutdownTelemetry, track } from '@moonshot-ai/kimi-telemetry';
import type { ServerLogger } from '@moonshot-ai/server';
import chalk from 'chalk';
import { Option, type Command } from 'commander';

import { isKimiV2Enabled } from '#/cli/experimental-v2';
import { CLI_SHUTDOWN_TIMEOUT_MS } from '#/constant/app';
import { t } from '#/i18n';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';

import { initializeServerTelemetry } from '../../telemetry';
import {
  buildKimiDefaultHeaders,
  createKimiCodeHostIdentity,
  getHostPackageRoot,
  getVersion,
} from '../../version';
import {
  accessUrlLines,
  buildOpenableUrl,
  isLoopbackHost,
  splitTokenFragment,
} from './access-urls';
import { ensureDaemon, findReusableDaemon, type EnsureDaemonResult } from './daemon';
import { maybeLoadRustEngine } from '#/cli/rust-engine';
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
 * `kimi server run` → server-v2 routing is gated by the master experimental
 * switch (`#/cli/experimental-v2`). When it is truthy, the in-process runner
 * boots the DI × Scope engine server (`@moonshot-ai/kap-server`) instead of
 * the default `@moonshot-ai/server`.
 *
 * Re-exported under the historical name so existing callers/tests keep working.
 */
export const isServerV2Enabled = isKimiV2Enabled;

/**
 * Minimal surface `runServerInProcess` needs from either server flavor. v1's
 * `RunningServer` already satisfies it; v2's `RunningServer` is adapted to it
 * (it returns `{ host, port, close }` instead of `{ address, logger, close }`).
 */
interface RoutedServer {
  readonly address: string;
  readonly logger: ServerLogger;
  close(): Promise<void>;
}

export interface RunCliOptions extends ServerCliOptions {
  open?: boolean;
  /** Run the server in-process instead of spawning a background daemon. */
  foreground?: boolean;
  /**
   * Run as a background daemon and return once healthy. Only registered on
   * `kimi web` (where foreground is the default); `kimi server run` has no
   * such flag because background is already its default.
   */
  background?: boolean;
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string) => void;
}

export interface RunCommandDeps {
  startServerBackground(options: ParsedServerOptions): Promise<{
    origin: string;
    /** True when an already-running daemon was reused (no new server started). */
    reused?: boolean;
    /** Bind host the running daemon is actually listening on (from the lock). */
    host?: string;
    /** Port the running daemon is actually listening on (from the lock). */
    port?: number;
    /** CLI version that started the reused server (from its lock), if recorded. */
    hostVersion?: string;
  }>;
  /** Foreground runner; defaults to the real in-process runner when omitted. */
  startServerForeground?: (
    options: ParsedServerOptions,
    hooks?: StartForegroundHooks,
  ) => Promise<never>;
  /**
   * Probe for an already-live, healthy daemon. Used by foreground-mode
   * `kimi web` to reuse a running server instead of failing to bind its port.
   * Defaults to the real lock-based probe when omitted.
   */
  findReusableDaemon?: () => Promise<EnsureDaemonResult | undefined>;
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
export function buildRunCommand(
  cmd: Command,
  options: { defaultOpen: boolean; defaultForeground?: boolean },
): Command {
  const defaultForeground = options.defaultForeground === true;
  cmd
    .option(
      '--port <port>',
      t('cli.optionDescriptions.serverRunOptionPort'),
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--host [host]',
      t('cli.optionDescriptions.serverRunOptionHost'),
    )
    .option(
      '--allowed-host <host...>',
      t('cli.optionDescriptions.serverRunOptionAllowedHost'),
    )
    .option(
      '--keep-alive',
      t('cli.optionDescriptions.serverRunOptionKeepAlive'),
      false,
    )
    .option(
      '--insecure-no-tls',
      t('cli.optionDescriptions.serverRunOptionInsecureNoTls'),
      true,
    )
    .option(
      '--allow-remote-shutdown',
      t('cli.optionDescriptions.serverRunOptionAllowRemoteShutdown'),
      false,
    )
    .option(
      '--allow-remote-terminals',
      t('cli.optionDescriptions.serverRunOptionAllowRemoteTerminals'),
      false,
    )
    .option(
      '--dangerous-bypass-auth',
      t('cli.optionDescriptions.serverRunOptionDangerousBypassAuth'),
      false,
    )
    .option(
      '--log-level <level>',
      t('cli.optionDescriptions.serverRunOptionLogLevel'),
    )
    .option(
      '--debug-endpoints',
      t('cli.optionDescriptions.serverRunOptionDebugEndpoints'),
      false,
    )
    .option(
      '--foreground',
      defaultForeground
        ? t('cli.optionDescriptions.serverRunOptionForegroundDefault')
        : t('cli.optionDescriptions.serverRunOptionForeground'),
      false,
    );
  if (defaultForeground) {
    cmd.option(
      '--background',
      t('cli.optionDescriptions.serverRunOptionBackground'),
      false,
    );
  }
  return cmd
    .option(
      options.defaultOpen ? '--no-open' : '--open',
      options.defaultOpen
        ? t('cli.optionDescriptions.serverRunOptionNoOpen')
        : t('cli.optionDescriptions.serverRunOptionOpen'),
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
        await handleRunCommand(opts, undefined, { defaultForeground });
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export interface RunCommandConfig {
  /**
   * True for the `kimi web` alias: foreground becomes the default and
   * `--background` opts back into the daemon. `kimi server run` leaves this
   * false, keeping its background default and plain `--foreground` semantics.
   */
  defaultForeground?: boolean;
}

export async function handleRunCommand(
  opts: RunCliOptions,
  deps: RunCommandDeps = DEFAULT_RUN_COMMAND_DEPS,
  config: RunCommandConfig = {},
): Promise<void> {
  const parsed = parseServerOptions(opts);
  if (parsed.daemon) {
    await startServerDaemon(parsed);
    return;
  }
  const foreground =
    opts.foreground === true || (config.defaultForeground === true && opts.background !== true);
  // Foreground is always keep-alive: a server attached to the operator's
  // terminal must never idle-kill itself. Background daemons respect the
  // derived `--keep-alive` flag.
  const runOptions: ParsedServerOptions = foreground ? { ...parsed, keepAlive: true } : parsed;
  // Resolve the persistent token once: it is printed in the ready banner and
  // rides in the opened Web UI URL's `#token=` fragment (M5.5). Falls back to
  // the plain origin / no token line when unavailable. When auth is bypassed,
  // the token is meaningless and is intentionally NOT shown or carried in the
  // opened URL.
  const writeReady = (result: {
    origin: string;
    reused?: boolean;
    host?: string;
    hostVersion?: string;
  }): void => {
    const { origin } = result;
    const host = result.host ?? parsed.host;
    // When a daemon is reused, this command's flags were NOT applied to the
    // already-running server. Don't trust the requested `--dangerous-bypass-auth`
    // for display/open: treat the server as token-protected so we never hide a
    // token the user actually needs, nor claim bypass for a server that is
    // authenticating. (Probing the running server's `/meta` would give its real
    // mode; we conservatively assume non-bypass on reuse.)
    const effectiveBypass = result.reused === true ? false : parsed.dangerousBypassAuth;
    const token = effectiveBypass ? undefined : deps.resolveToken?.();
    // True only when this process actually hosts the server: it stops with
    // Ctrl+C. A reused daemon lives elsewhere and still needs `server kill`.
    const attachedForeground = foreground && result.reused !== true;
    let output = '';
    if (result.reused === true) {
      // A daemon was already running, so this command's --host/--port/etc. did
      // not start a new one. Say so loudly, then print the actual running
      // server's URLs (using its real bind host, not the requested one).
      output += formatReuseNotice(origin);
      // The reused server may predate an upgrade of this CLI: it keeps
      // serving its own bundled web UI / API, so surface the mismatch.
      if (result.hostVersion !== undefined && result.hostVersion !== getVersion()) {
        output += formatServerUpgradeNotice(result.hostVersion);
      }
    }
    output +=
      parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL
        ? formatReadyBanner(origin, host, {
            token,
            networkAddresses: deps.networkAddresses,
            dangerousBypassAuth: effectiveBypass,
            foreground: attachedForeground,
          })
        : formatReadyLine(origin, token, effectiveBypass, attachedForeground);
    deps.stdout.write(output);
    if (opts.open === true) {
      deps.openUrl(token !== undefined ? buildWebUrl(origin, token) : origin);
    }
  };
  if (foreground) {
    if (config.defaultForeground === true) {
      // `kimi web` defaults to foreground, but binding the port while a server
      // is already running would fail — reuse it the way the daemon path does:
      // print the reuse notice and open the browser, then let this command exit.
      const probe = deps.findReusableDaemon ?? findReusableDaemon;
      const existing = await probe();
      if (existing !== undefined) {
        writeReady({
          origin: existing.origin,
          reused: true,
          host: existing.host,
          hostVersion: existing.hostVersion,
        });
        return;
      }
    }
    const run = deps.startServerForeground ?? startServerForeground;
    await run(runOptions, {
      onReady: (origin) => {
        writeReady({ origin, reused: false, host: parsed.host });
      },
    });
    return;
  }
  const result = await deps.startServerBackground(runOptions);
  writeReady(result);
}

function formatReuseNotice(origin: string): string {
  return (
    `${chalk.hex(darkColors.warning)(t('tui.statusMessages.serverReuseNoticeTitle'))} ${t('tui.statusMessages.serverReuseNoticeBody', { origin })} — ` +
    `${t('tui.statusMessages.serverReuseNoticeHint')}\n`
  );
}

/**
 * Shown after the reuse notice when the running server was started by a
 * different CLI version: it keeps serving its own bundled web UI/API, so the
 * user may want to restart it onto the version they just installed.
 */
function formatServerUpgradeNotice(runningVersion: string): string {
  return (
    `${chalk.hex(darkColors.warning)(t('tui.statusMessages.serverVersionMismatch'))}: ` +
    `${t('tui.statusMessages.serverVersionMismatchDetail', { runningVersion, cliVersion: getVersion() })}\n`
  );
}

function formatReadyLine(
  origin: string,
  token: string | undefined,
  dangerousBypassAuth = false,
  foreground = false,
): string {
  const notice = dangerousBypassAuth
    ? `${formatDangerNoticeLines({ foreground }).join('\n')}\n`
    : '';
  return `${notice}${t('tui.statusMessages.serverUrl', { url: buildOpenableUrl(origin, token) })}\n`;
}

/**
 * Red, impossible-to-miss notice emitted when `--dangerous-bypass-auth`
 * disables the bearer-token gate. Shared by the full ready banner and the
 * compact one-line output so the warning always shows regardless of log level.
 */
function formatDangerNoticeLines(opts: { foreground?: boolean } = {}): string[] {
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  // A foreground server stops with Ctrl+C; only a background daemon needs the
  // separate `kimi server kill` command.
  const stopAction = opts.foreground === true ? 'press Ctrl+C' : 'run kimi server kill';
  return [
    `  ${dangerBold(t('tui.statusMessages.serverDangerAuthDisabled'))}`,
    `  ${danger(t('tui.statusMessages.serverDangerAnyoneAccess'))}`,
    `  ${danger(t('tui.statusMessages.serverDangerUnsure'))}${dangerBold(t('tui.statusMessages.serverDangerUnsureCmd'))}${danger(t('tui.statusMessages.serverDangerUnsureSuffix'))}`,
  ];
}

/**
 * `kimi server run` (non-daemon) — ensures a background daemon is running
 * (spawning a detached `kimi server run --daemon` child if needed), then
 * returns its origin so the caller can print the ready banner and exit. The
 * server keeps running in the background after this returns.
 */
export async function startServerBackground(
  options: ParsedServerOptions,
): Promise<EnsureDaemonResult> {
  return ensureDaemon({
    host: options.host,
    port: options.port,
    logLevel: options.logLevel,
    debugEndpoints: options.debugEndpoints,
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowRemoteTerminals: options.allowRemoteTerminals,
    dangerousBypassAuth: options.dangerousBypassAuth,
    keepAlive: options.keepAlive,
    allowedHosts: options.allowedHosts,
    idleGraceMs: options.idleGraceMs,
  });
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

  let running: RoutedServer | undefined;
  let stopping = false;

  // Idle auto-shutdown is only for the on-demand personal daemon. It is skipped
  // in foreground mode (`mode.daemon` is false) and whenever `--keep-alive` is
  // set — explicitly, or implied by `--host` / `--allowed-host`.
  const idle =
    mode.daemon && !options.keepAlive
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

  if (isKimiV2Enabled()) {
    // Experimental: boot the DI × Scope engine server. v2 speaks the same
    // `/api/v1` wire interface but its `startServer` returns `{ host, port,
    // close }` rather than `{ address, logger, close }`, so adapt it to the
    // `RoutedServer` surface the rest of this runner consumes. Loaded lazily so
    // the default (flag-off) path keeps the exact v1-only module graph — v2 and
    // its agent-core-v2 engine are only resolved when the flag is on.
    const { createServerLogger: createServerV2Logger, startServer: startServerV2 } =
      await import('@moonshot-ai/kap-server');
    const { hostRequestHeadersSeed } = await import('@moonshot-ai/agent-core-v2');
    const logger = createServerV2Logger({ level: options.logLevel });
    const v2 = await startServerV2({
      host: options.host,
      port: options.port,
      logLevel: options.logLevel,
      logger,
      debugEndpoints: options.debugEndpoints,
      insecureNoTls: options.insecureNoTls,
      allowRemoteShutdown: options.allowRemoteShutdown,
      allowRemoteTerminals: options.allowRemoteTerminals,
      allowedHosts: options.allowedHosts,
      disableAuth: options.dangerousBypassAuth,
      // Seed the CLI's Kimi identity headers so the v2 engine's outbound
      // requests (model, WebSearch, FetchURL) carry the same User-Agent +
      // X-Msh-* identity as direct CLI runs.
      seeds: hostRequestHeadersSeed(buildKimiDefaultHeaders(version)),
      webAssetsDir: serverWebAssetsDir(),
    });
    // v2's connection registry exposes no count-change hook, so forward
    // add/remove to the daemon's idle-shutdown handler (a no-op when `idle`
    // is undefined, e.g. foreground or --keep-alive).
    if (idle !== undefined) {
      const registry = v2.connectionRegistry;
      const add = registry.add.bind(registry);
      const remove = registry.remove.bind(registry);
      registry.add = (conn) => {
        add(conn);
        idle.onConnectionCountChange(registry.size());
      };
      registry.remove = (connId) => {
        remove(connId);
        idle.onConnectionCountChange(registry.size());
      };
    }
    logger.info('server-v2 (KIMI_CODE_EXPERIMENTAL_FLAG) is serving the REST/WS API and the bundled web UI');
    running = {
      address: `http://${v2.host}:${v2.port}`,
      logger: logger as unknown as ServerLogger,
      close: () => v2.close(),
    };
  } else {
    const { startServer } = await import('@moonshot-ai/server');
    running = await startServer({
      host: options.host,
      port: options.port,
      logLevel: options.logLevel,
      debugEndpoints: options.debugEndpoints,
      insecureNoTls: options.insecureNoTls,
      allowRemoteShutdown: options.allowRemoteShutdown,
      allowRemoteTerminals: options.allowRemoteTerminals,
      dangerousBypassAuth: options.dangerousBypassAuth,
      allowedHosts: options.allowedHosts,
      webAssetsDir: serverWebAssetsDir(),
      coreProcessOptions: {
        identity: createKimiCodeHostIdentity(version),
        telemetry,
        // Wire the Rust agent engine if config has `agent.engine = "rust"`.
        ...(await resolveRunTurnOverride(version)),
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
  }

  track('server_started', { daemon: mode.daemon });

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  const readyFields = mode.daemon
    ? options.keepAlive
      ? { address: running.address, idleShutdown: 'disabled' as const }
      : { address: running.address, idleGraceMs: options.idleGraceMs }
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
  /** When true, render a red danger notice (auth is disabled). */
  dangerousBypassAuth?: boolean;
  /**
   * True when this process hosts the server attached to the terminal: the
   * Stop hint becomes Ctrl+C instead of `kimi server kill`.
   */
  foreground?: boolean;
}

/**
 * Render the ready banner shown when a server starts (or is reused) with the
 * default log level. Exported for `/web` in the TUI, which prints the same
 * banner when it hands the terminal over to a foreground server.
 */
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
    lines.push(...formatDangerNoticeLines({ foreground: opts.foreground === true }), '');
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
    lines.push(`  ${label(t('tui.statusMessages.serverAccessNetwork'))}${muted(t('tui.statusMessages.serverNetworkOff'))}${dim('  ' + t('tui.statusMessages.serverNetworkUseHost'))}`);
  }
  if (opts.token !== undefined) {
    // Set the token off with surrounding whitespace rather than color, so it is
    // easy to spot without being highlighted.
    lines.push('');
    lines.push(`  ${label(t('tui.statusMessages.serverTokenLabel'))}${opts.token}`);
    lines.push('');
  }

// Auxiliary controls last. A foreground server is stopped by interrupting
  // the terminal; only a detached daemon needs the `kill` subcommand.
  const stopHint = opts.foreground === true ? 'Ctrl+C' : t('tui.statusMessages.serverStopCmd');
  lines.push(`  ${label(t('tui.statusMessages.serverLogsLabel'))}${muted(t('tui.statusMessages.serverLogsOff'))}${dim('  ' + t('tui.statusMessages.serverLogsUseLevel'))}`);
  lines.push(`  ${label(t('tui.statusMessages.serverStopLabel'))}${muted(stopHint)}`);
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

/**
 * Resolve the Rust agent engine override for the daemon path.
 * Reads the config, checks `agent.engine`, and loads the Rust adapter if configured.
 */
async function resolveRunTurnOverride(version: string): Promise<{ runTurnOverride?: unknown }> {
  const telemetryBootstrap = await import('../../telemetry').then((m) => m.createCliTelemetryBootstrap());
  const override = await maybeLoadRustEngine(telemetryBootstrap.homeDir);
  if (override !== undefined) {
    return { runTurnOverride: override };
  }
  return {};
}
