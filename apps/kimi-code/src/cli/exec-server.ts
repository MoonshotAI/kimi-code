/**
 * `kimi exec-server` (equivalently `--listen stdio`) — the remote-executor
 * light entry.
 *
 * This module is the argv pre-dispatch target of `src/main.ts` and must stay
 * light: only node builtins plus `./version` (and its `./build-info`). The SDK
 * root (`@moonshot-ai/kimi-code-sdk`) would pull in full registration
 * (config/OAuth/telemetry/session services) at import time, so the executor
 * reaches its implementation exclusively through a dynamic import of the SDK's
 * light `@moonshot-ai/kimi-code-sdk/exec-server` subpath, which re-exports the
 * engine's import-graph-isolated `remote/server` entry (enforced by
 * agent-core-v2's check-import-boundaries). `test/cli/exec-server.test.ts`
 * guards this import graph.
 *
 * Wire discipline: stdout carries protocol frames only; every diagnostic
 * (usage errors, startup failures, executor logs) goes to stderr.
 */

import { getVersion } from './version';

export const EXEC_SERVER_COMMAND = 'exec-server';

const EXEC_SERVER_ARGV_SHAPES: readonly (readonly string[])[] = [
  [EXEC_SERVER_COMMAND],
  [EXEC_SERVER_COMMAND, '--listen', 'stdio'],
];

/**
 * Exact-shape match for the light path: the bare command or the explicit
 * `--listen stdio` spelling (stdio is the only transport, so the flag is
 * ceremony kept for compatibility). Node/tsx invoke as
 * `[exec, script, ...args]`, the SEA binary as `[exec, exec, ...args]` (or
 * `[exec, ...args]`), so each shape is accepted at either offset. Anything
 * else named `exec-server` falls through to the full CLI, where the hidden
 * Commander subcommand in `cli/commands.ts` owns validation and errors.
 */
export function isExecServerArgv(argv: readonly string[]): boolean {
  return hasExecServerShape(argv.slice(1)) || hasExecServerShape(argv.slice(2));
}

function hasExecServerShape(args: readonly string[]): boolean {
  return EXEC_SERVER_ARGV_SHAPES.some(
    (shape) => shape.length === args.length && shape.every((arg, index) => arg === args[index]),
  );
}

/**
 * Validate the transport and run the executor until the stdio connection
 * closes. Returns the process exit code: 0 on clean shutdown, 1 on startup
 * failure, 2 on an unsupported `--listen` transport.
 */
export async function runExecServerCommand(listen: string): Promise<number> {
  if (listen !== 'stdio') {
    process.stderr.write(`error: exec-server supports only "--listen stdio" (got "--listen ${listen}")\n`);
    return 2;
  }
  try {
    const { runExecServer } = await import('@moonshot-ai/kimi-code-sdk/exec-server');
    // The handshake's `executorVersion` is the host CLI version, so the
    // client's MIN_EXECUTOR_VERSION gate compares against what the binary ships as.
    return await runExecServer({ version: getVersion() });
  } catch (error) {
    process.stderr.write(
      `error: exec-server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
