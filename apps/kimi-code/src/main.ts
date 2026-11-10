/**
 * Kimi Code process entry.
 *
 * `kimi exec-server` (or the explicit `--listen stdio` spelling) is the
 * remote-executor light entry, and the SSH askpass helper is another light
 * entry: the engine's SSH password retry re-enters this binary as
 * `SSH_ASKPASS`, recognised by its environment rather than argv. Both
 * dispatch before the CLI's static import chain pulls
 * `@moonshot-ai/kimi-code-sdk` into module evaluation (full registration,
 * config/OAuth/telemetry/session services). Only node builtins, the light
 * SDK subpaths and these light helpers are imported statically; the regular
 * CLI lives behind a dynamic import so npm and SEA bundles keep both paths
 * free of the SDK mega-module.
 */

import { isSshAskpassEnvironment, runSshAskpass } from '@moonshot-ai/kimi-code-sdk/ssh-askpass';

import { isExecServerArgv, runExecServerCommand } from './cli/exec-server';

if (isSshAskpassEnvironment()) {
  void runSshAskpass().then((code) => {
    process.exitCode = code;
  });
} else if (isExecServerArgv(process.argv)) {
  // stdout is reserved for protocol frames; the runner logs to stderr only.
  // No process.exit: the stdio streams drain on connection EOF and the
  // process exits with this code on its own.
  void runExecServerCommand('stdio').then((code) => {
    process.exitCode = code;
  });
} else {
  void import('./cli/main').then(({ main }) => main());
}
