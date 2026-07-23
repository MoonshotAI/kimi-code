/**
 * `sandbox` domain (L3) — `ISandboxService` contract.
 *
 * Session-scoped decision point for the OS-level command sandbox: given a Bash
 * command line and its working directory, `decide` resolves the `[sandbox]`
 * config section and the probed backend into a `SandboxDecision` — wrap and run
 * sandboxed, run excluded, run unsandboxed (disabled / no backend / unsupported
 * platform), or block (fail-closed `require = true` with no backend). The
 * wrapped argv is a complete shell invocation, ready for the process runner.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SandboxDecision } from './sandboxTypes';

export interface ISandboxService {
  readonly _serviceBrand: undefined;

  decide(command: string, cwd: string): Promise<SandboxDecision>;
}

export const ISandboxService: ServiceIdentifier<ISandboxService> =
  createDecorator<ISandboxService>('sandboxService');
