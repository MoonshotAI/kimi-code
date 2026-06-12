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

import type { Command } from 'commander';

import { join } from 'node:path';

import {
  ServerLockedError,
  resolveServiceManager,
  startServer,
  type ServiceStatus,
} from '@moonshot-ai/server';

import { getNativeWebAssetsDir } from '#/native/web-assets';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import { createKimiCodeHostIdentity, getHostPackageRoot, getVersion } from '../../version';
import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  serverOrigin,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';

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
      '--host <host>',
      `Bind host (default ${DEFAULT_SERVER_HOST})`,
      DEFAULT_SERVER_HOST,
    )
    .option(
      '--port <port>',
      `Bind port (default ${DEFAULT_SERVER_PORT})`,
      String(DEFAULT_SERVER_PORT),
    )
    .option(
      '--log-level <level>',
      `Log level: ${VALID_LOG_LEVELS.join('|')} (default ${DEFAULT_LOG_LEVEL})`,
      DEFAULT_LOG_LEVEL,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection. OFF by default; production callers leave this unset.',
      false,
    )
    .option(
      '--swagger',
      'Mount the Swagger UI at /documentation. OpenAPI JSON remains available at /openapi.json.',
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
  deps.stdout.write(`Kimi server: ${outcome.origin}\n`);
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
    swagger: options.swagger,
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
    stopCommand: mode === 'background' ? 'kimi server stop' : foregroundStopCommand(existing.pid),
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

function foregroundStopCommand(pid: number): string {
  if (process.platform === 'win32') return `taskkill /PID ${String(pid)} /T /F`;
  return 'pkill -f "kimi server run"';
}

function formatAlreadyRunning(details: AlreadyRunningDetails): string {
  return [
    `Kimi server already running in ${details.mode} (pid ${String(details.pid)}).`,
    `URL: ${details.url}`,
    `Stop: ${details.stopCommand}`,
    '',
  ].join('\n');
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
