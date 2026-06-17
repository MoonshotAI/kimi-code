/**
 * `kimi server` parent command. Mounts:
 *   - `server run` (foreground; also used as the detached daemon child)
 *
 * The OS service-manager subcommands (`install/uninstall/start/stop/restart/
 * status`) are temporarily NOT registered — see the commented
 * `addLifecycleCommands(server)` below. Their implementation is preserved in
 * `./lifecycle.ts` + `packages/server/src/svc/*` for later re-exposure.
 *
 * The top-level `kimi web` alias is registered separately via
 * `registerWebAliasCommand` so it stays at the program root.
 */

import type { Command } from 'commander';

import { registerPsCommand } from './ps';
import { buildRunCommand } from './run';
import { registerWebAliasCommand } from './web-alias';

export function registerServerCommand(program: Command): void {
  const server = program
    .command('server')
    .description('Run the local Kimi server (REST + WebSocket + web UI).');

  buildRunCommand(
    server.command('run').description('Run the Kimi server in the foreground.'),
    { defaultOpen: false },
  );

  registerPsCommand(server);

  // OS service-manager commands (`install/uninstall/start/stop/restart/status`)
  // are temporarily hidden — the product now favors the on-demand background
  // daemon (`kimi web`) over service-ization. The implementation still lives in
  // `./lifecycle.ts` + `packages/server/src/svc/*`; re-import
  // `addLifecycleCommands` and call it here to re-expose.
  // addLifecycleCommands(server);

  registerWebAliasCommand(program);
}

export { registerWebAliasCommand };
