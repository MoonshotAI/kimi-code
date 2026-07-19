/**
 * Child-process entry for `spawnServerProcess` — boots ONE `kap-server`
 * instance on an ephemeral port and reports it over stdout.
 *
 * Spawning cannot run plain `node` on this file: the surrounding module
 * graph (kap-server → agent-core-v2) is TypeScript with `*.md?raw` imports.
 * The parent spawns `tsx` plus `build/register-raw-text-loader.mjs` to cover
 * both (see `serverProcess.ts` for the exact incantation), so a static
 * import of `@moonshot-ai/kap-server` is safe HERE — unlike in the helpers
 * that ship on the package barrel.
 *
 * Protocol (one JSON line each, see `spawnContract.ts`):
 *   - success: `{type:'ready', port, home}` on stdout, then serve until
 *     SIGTERM/SIGINT, which triggers `server.close()` and a clean exit.
 *   - failure: `{type:'error', message}` on stdout, exit code 1.
 */
import { startServer, type RunningServer } from '@moonshot-ai/kap-server';

import {
  SPAWN_SERVER_HOME_ENV,
  type SpawnServerMessage,
} from './spawnContract.js';

async function main(): Promise<void> {
  const home = process.env[SPAWN_SERVER_HOME_ENV];
  if (home === undefined || home.length === 0) {
    emit({ type: 'error', message: `${SPAWN_SERVER_HOME_ENV} is not set` });
    process.exitCode = 1;
    return;
  }

  let server: RunningServer;
  try {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      // Signal tests must not juggle tokens; the parent drives this server
      // over loopback only.
      disableAuth: true,
    });
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    return;
  }
  emit({ type: 'ready', port: server.port, home, pid: process.pid });

  // Graceful shutdown: `stop()` sends SIGTERM first and escalates to SIGKILL
  // on timeout, so exiting here only after `close()` settles keeps the
  // instance-registry / journal teardown on the slow path observable. Close
  // failures go to stderr (the parent captures the tail) but never block the
  // exit — signal tests need the process to actually die.
  let closing: Promise<void> | undefined;
  const onSignal = (): void => {
    closing ??= server
      .close()
      .catch((error: unknown) => {
        process.stderr.write(
          `server.close() failed during signal shutdown: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      })
      .finally(() => {
        process.exit(0);
      });
    void closing;
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

function emit(message: SpawnServerMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

void main();
