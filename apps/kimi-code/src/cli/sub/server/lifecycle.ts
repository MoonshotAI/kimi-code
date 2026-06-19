/**
 * `kimi server install/uninstall/start/stop/restart/status`.
 *
 * Phase 2 lands the CLI shape; the lifecycle calls into the platform service
 * manager from `@moonshot-ai/server`, which is filled in by Phase 3+.
 *
 * The Commander wiring here mirrors `addGatewayServiceCommands` from
 * `../openclaw/src/cli/daemon-cli/register-service-commands.ts:58`.
 */

import type { Command } from 'commander';

import {
  ServiceUnavailableError,
  ServiceUnsupportedError,
  resolveServiceManager,
  type InstallArgs,
  type ServiceManager,
  type ServiceStatus,
} from '@moonshot-ai/server';

import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseLogLevel,
  parsePort,
  serverOrigin,
  VALID_LOG_LEVELS,
} from './shared';

export interface InstallCliOptions {
  port?: string;
  logLevel?: string;
  force?: boolean;
  open?: boolean;
  json?: boolean;
}

export interface JsonCliOptions {
  json?: boolean;
}

export interface LifecycleCommandDeps {
  resolveManager(): ServiceManager;
  openUrl(url: string): void;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const DEFAULT_DEPS: LifecycleCommandDeps = {
  resolveManager: resolveServiceManager,
  openUrl: defaultOpenUrl,
  stdout: process.stdout,
  stderr: process.stderr,
};

/** Mount install/uninstall/start/stop/restart/status under a parent command. */
export function addLifecycleCommands(parent: Command, deps: LifecycleCommandDeps = DEFAULT_DEPS): void {
  parent
    .command('install')
    .description('Install the Kimi server as an OS-managed service (launchd/systemd/schtasks).')
    .option('--port <port>', `Bind port (default ${DEFAULT_SERVER_PORT})`, String(DEFAULT_SERVER_PORT))
    .option(
      '--log-level <level>',
      `Log level: ${VALID_LOG_LEVELS.join('|')} (default ${DEFAULT_LOG_LEVEL})`,
      DEFAULT_LOG_LEVEL,
    )
    .option('--force', 'Reinstall and overwrite if already installed', false)
    .option('--no-open', 'Do not open the web UI after install.', true)
    .option('--json', 'Output JSON', false)
    .action(async (opts: InstallCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const args: InstallArgs = {
          host: DEFAULT_SERVER_HOST,
          port: parsePort(opts.port, '--port', DEFAULT_SERVER_PORT),
          logLevel: parseLogLevel(opts.logLevel),
          force: opts.force === true,
        };
        const result = await mgr.install(args);
        const status = await readStatus(mgr);
        const enriched = withStatusDetails({
          ok: true,
          action: 'install',
          status: result.status,
          plistPath: result.plistPath,
          unitPath: result.unitPath,
          taskName: result.taskName,
          message: result.message,
        }, status, args);
        if (opts.json !== true && opts.open !== false && enriched.running === true && typeof enriched.url === 'string') {
          deps.openUrl(enriched.url);
        }
        return enriched;
      });
    });

  parent
    .command('uninstall')
    .description('Uninstall the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.uninstall();
        return { ok: result.ok, action: 'uninstall', message: result.message };
      });
    });

  parent
    .command('start')
    .description('Start the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.start();
        const status = await readStatus(mgr);
        return withStatusDetails({ ok: result.ok, action: 'start', message: result.message }, status);
      });
    });

  parent
    .command('stop')
    .description('Stop the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.stop();
        return { ok: result.ok, action: 'stop', message: result.message };
      });
    });

  parent
    .command('restart')
    .description('Restart the Kimi server service.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const result = await mgr.restart();
        const status = await readStatus(mgr);
        return withStatusDetails({ ok: result.ok, action: 'restart', message: result.message }, status);
      });
    });

  parent
    .command('status')
    .description('Show Kimi server service status and connectivity.')
    .option('--json', 'Output JSON', false)
    .action(async (opts: JsonCliOptions) => {
      await runLifecycle(deps, opts.json === true, async (mgr) => {
        const status: ServiceStatus = await mgr.status();
        return withStatusDetails({ ok: true, action: 'status', ...status }, status);
      });
    });
}

async function runLifecycle(
  deps: LifecycleCommandDeps,
  json: boolean,
  body: (mgr: ServiceManager) => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const mgr = deps.resolveManager();
    const result = await body(mgr);
    if (json) {
      deps.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    deps.stdout.write(formatHuman(result));
  } catch (error) {
    if (error instanceof ServiceUnavailableError || error instanceof ServiceUnsupportedError) {
      const payload = {
        ok: false,
        action: error instanceof ServiceUnavailableError ? 'unavailable' : 'unsupported',
        platform: error.platform,
        message: error.message,
      };
      if (json) {
        deps.stdout.write(`${JSON.stringify(payload)}\n`);
      } else {
        deps.stderr.write(`${error.message}\n`);
      }
      process.exit(2);
      return;
    }
    if (json) {
      deps.stdout.write(
        `${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`,
      );
    } else {
      deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  }
}

function formatHuman(result: Record<string, unknown>): string {
  const rawAction = result['action'];
  const action = typeof rawAction === 'string' ? rawAction : 'action';
  const rawMessage = result['message'];
  const message = typeof rawMessage === 'string' ? `: ${rawMessage}` : '';
  const lines = [`${action}${message}`];

  const url = result['url'];
  if (typeof url === 'string') lines.push(`URL: ${url}`);

  const running = result['running'];
  if (typeof running === 'boolean') lines.push(`Status: ${running ? 'running' : 'not running'}`);

  const logPath = result['logPath'];
  if (typeof logPath === 'string') lines.push(`Log: ${logPath}`);

  const notes = result['notes'];
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (typeof note === 'string' && note.length > 0) lines.push(`Note: ${note}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function readStatus(mgr: ServiceManager): Promise<ServiceStatus | undefined> {
  try {
    return await mgr.status();
  } catch {
    return undefined;
  }
}

function withStatusDetails(
  result: Record<string, unknown>,
  status: ServiceStatus | undefined,
  fallback?: { host: string; port: number },
): Record<string, unknown> & { url?: string; running?: boolean } {
  const host = status?.host ?? fallback?.host;
  const port = status?.port ?? fallback?.port;
  const url = host !== undefined && port !== undefined ? formatServiceUrl(host, port) : undefined;
  return {
    ...result,
    url,
    running: status?.running,
    host,
    port,
    logPath: status?.logPath,
    notes: status?.notes,
  };
}

function formatServiceUrl(host: string, port: number): string {
  return serverOrigin(host === '0.0.0.0' ? DEFAULT_SERVER_HOST : host, port);
}
