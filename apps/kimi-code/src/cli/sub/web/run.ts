/**
 * `kimi web` — run the local server in the foreground and open the web UI.
 *
 * The server always runs in the foreground (the Rust `kimi-server-serve --http`
 * binary), attached to the terminal, and shuts down cleanly on
 * SIGINT/SIGTERM. `--no-open` skips the browser.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import chalk from 'chalk';
import { type Command } from 'commander';

import { t } from '#/i18n';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/shared/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';

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

export interface WebCliOptions extends ServerCliOptions {
  open?: boolean;
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string) => void;
}

export interface WebCommandDeps {
  /** Foreground runner; defaults to the real Rust-server runner when omitted. */
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
  // The Rust `kimi-server-serve --http` binary is the only server flavor
  // (the "only web is TS" direction); tests inject a fake runner.
  const run = deps.startServerForeground ?? startRustServerForeground;
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
 * Run the Rust `kimi-server-serve` binary in the foreground (the "only web is
 * TS" cutover: the Rust server replaces kap-server for REST/WS + the SPA).
 */
export async function startRustServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
): Promise<never> {
  const bin = resolveRustServeBin();
  if (!bin) {
    throw new Error(
      'kimi web: kimi-server-serve binary not found (set KIMI_RUST_SERVE_BIN or build target/debug/kimi-server-serve)',
    );
  }
  const args = ['--http', `${options.host}:${options.port}`];
  if (options.dangerousBypassAuth) args.push('--no-auth');
  if (!options.dangerousBypassAuth) {
    const assets = serverWebAssetsDir();
    if (assets) args.push('--assets', assets);
  }
  if (options.insecureNoTls) args.push('--insecure-no-tls');
  if (options.allowRemoteShutdown) args.push('--allow-remote-shutdown');
  for (const host of options.allowedHosts) {
    args.push('--allowed-host', host);
  }
  process.stderr.write(`kimi web: starting Rust server: ${bin} ${args.join(' ')}\n`);
  const child = spawn(bin, args, { stdio: 'inherit' });

  let stopping = false;
  function shutdown(): void {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    process.exit(0);
  }
  process.once('SIGINT', () => shutdown());
  process.once('SIGTERM', () => shutdown());

  const origin = `http://${options.host}:${options.port}`;
  await waitForHealth(origin);
  hooks.onReady?.(origin);
  return new Promise<never>(() => {
    child.once('exit', () => process.exit(0));
  });
}

/** Locate the Rust server binary: env override, repo build output, or PATH. */
function resolveRustServeBin(): string | null {
  const fromEnv = process.env['KIMI_RUST_SERVE_BIN'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidate = join(__dirname, '..', '..', '..', '..', 'target', 'debug', `kimi-server-serve${process.platform === 'win32' ? '.exe' : ''}`);
  if (existsSync(candidate)) return candidate;
  return null;
}

/** Probe `GET /api/v1/healthz` until the server answers (or 15s elapse).
 *  healthz is auth-bypassed (kap-server parity), so the probe works before
 *  the token file exists. */
async function waitForHealth(origin: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`kimi web: Rust server did not become healthy at ${origin}`);
    }
    try {
      const res = await fetch(`${origin}/api/v1/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }
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
  startServerForeground: startRustServerForeground,
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
