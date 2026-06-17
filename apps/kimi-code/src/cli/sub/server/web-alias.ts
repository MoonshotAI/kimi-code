/**
 * `kimi web` — open the Kimi web UI.
 *
 * Non-blocking: ensures a single background daemon is running (spawning one if
 * needed) and opens the browser at its origin, then returns. The daemon keeps
 * running in a detached process until all web clients leave (see `./daemon.ts`
 * and the `--daemon` branch in `./run.ts`).
 */

import type { Command } from 'commander';

import type { ServerLogLevel } from '@moonshot-ai/server';

import { openUrl as defaultOpenUrl } from '#/utils/open-url';

import { ensureDaemon, type EnsureDaemonOptions } from './daemon';
import {
  DEFAULT_SERVER_PORT,
  parseLogLevel,
  parsePort,
  VALID_LOG_LEVELS,
} from './shared';

interface WebCliOptions {
  port?: string;
  logLevel?: string;
  open?: boolean;
}

export interface WebCommandDeps {
  ensureDaemon(options: EnsureDaemonOptions): Promise<{ origin: string }>;
  openUrl(url: string): void;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
}

export async function handleWebCommand(
  opts: WebCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  const port = parsePort(opts.port, '--port', DEFAULT_SERVER_PORT);
  const logLevel: ServerLogLevel | undefined =
    opts.logLevel === undefined ? undefined : parseLogLevel(opts.logLevel);
  const { origin } = await deps.ensureDaemon({ port, logLevel });
  deps.stdout.write(`Kimi server: ${origin}\n`);
  if (opts.open !== false) {
    deps.openUrl(origin);
  }
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  ensureDaemon,
  openUrl: defaultOpenUrl,
  stdout: process.stdout,
};

export function registerWebAliasCommand(program: Command): void {
  program
    .command('web')
    .description('Open the Kimi web UI (starts a background daemon if needed).')
    .option('--port <port>', `Preferred daemon port (default ${String(DEFAULT_SERVER_PORT)}).`)
    .option(
      '--log-level <level>',
      `Daemon log level when spawned: ${VALID_LOG_LEVELS.join('|')}. Defaults to info.`,
    )
    .option('--no-open', 'Do not open the web UI in the default browser.')
    .action(async (opts: WebCliOptions) => {
      try {
        await handleWebCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
