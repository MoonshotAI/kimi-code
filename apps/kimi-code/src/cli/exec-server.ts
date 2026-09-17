/**
 * `kimi exec-server --listen stdio` — the remote-executor light entry.
 *
 * This module is the argv pre-dispatch target of `src/main.ts` and must stay
 * light: only node builtins plus `./build-info` / `./host-package`. The SDK
 * mega-module (`@moonshot-ai/kimi-code-sdk`) would pull in full registration
 * (config/OAuth/telemetry/session services) at import time, so the executor
 * reaches its implementation exclusively through a dynamic import of
 * `@moonshot-ai/remote-exec/server` — the spec-sanctioned exception to the
 * "CLI consumes core capabilities only via the SDK" rule (remote-environment
 * spec §6/§10). `test/cli/exec-server.test.ts` guards this import graph.
 *
 * Wire discipline: stdout carries protocol frames only; every diagnostic
 * (usage errors, startup failures, executor logs) goes to stderr.
 */

import { readFileSync } from 'node:fs';

import { KIMI_BUILD_INFO } from './build-info';
import { getHostPackageJsonPath } from './host-package';

export const EXEC_SERVER_COMMAND = 'exec-server';

const EXEC_SERVER_ARGV_SHAPE = [EXEC_SERVER_COMMAND, '--listen', 'stdio'] as const;

/**
 * Exact-shape match for the light path. Node/tsx invoke as
 * `[exec, script, ...args]`, the SEA binary as `[exec, exec, ...args]` (or
 * `[exec, ...args]`), so the shape is accepted at either offset. Anything
 * else named `exec-server` falls through to the full CLI, where the hidden
 * Commander subcommand in `cli/commands.ts` owns validation and errors.
 */
export function isExecServerArgv(argv: readonly string[]): boolean {
  return hasExecServerShape(argv.slice(1)) || hasExecServerShape(argv.slice(2));
}

function hasExecServerShape(args: readonly string[]): boolean {
  return (
    args.length === EXEC_SERVER_ARGV_SHAPE.length &&
    args.every((arg, index) => arg === EXEC_SERVER_ARGV_SHAPE[index])
  );
}

/**
 * Executor version reported in the handshake (`executorVersion`): the host
 * CLI package version, so the client's `MIN_EXECUTOR_VERSION` gate and the
 * install/update guidance (spec D9) compare against the same version the
 * binary ships as. Build-info wins when injected (SEA/native bundles);
 * otherwise read the nearest package.json (npm dist, tsx dev).
 */
export function resolveExecutorVersion(): string {
  if (KIMI_BUILD_INFO.version !== undefined) {
    return KIMI_BUILD_INFO.version;
  }
  const pkg = JSON.parse(readFileSync(getHostPackageJsonPath(), 'utf-8')) as {
    version: string;
  };
  return pkg.version;
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
    const { runExecServer } = await import('@moonshot-ai/remote-exec/server');
    return await runExecServer({ version: resolveExecutorVersion() });
  } catch (error) {
    process.stderr.write(
      `error: exec-server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
