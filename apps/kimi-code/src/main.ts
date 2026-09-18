/**
 * Kimi Code process entry.
 *
 * `kimi exec-server` (or the explicit `--listen stdio` spelling) is the
 * remote-executor light entry
 * (remote-environment spec §6): it must dispatch before the CLI's static import
 * chain pulls `@moonshot-ai/kimi-code-sdk` into module evaluation (full
 * registration, config/OAuth/telemetry/session services). This module
 * therefore stays light — only `cli/exec-server` (node builtins) is imported
 * statically — and the regular CLI lives behind a dynamic import so npm and
 * SEA bundles keep the executor path free of the SDK mega-module.
 */

import { isExecServerArgv, runExecServerCommand } from './cli/exec-server';

if (isExecServerArgv(process.argv)) {
  // stdout is reserved for protocol frames; the runner logs to stderr only.
  // No process.exit: the stdio streams drain on connection EOF and the
  // process exits with this code on its own.
  runExecServerCommand('stdio').then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `error: exec-server failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
} else {
  void import('./cli/main').then(({ main }) => main());
}
