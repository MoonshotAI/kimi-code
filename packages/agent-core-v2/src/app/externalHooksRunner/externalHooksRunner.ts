/**
 * `externalHooksRunner` domain (L6) — App-scope contract for executing
 * configured external hooks.
 *
 * A single App-scope executor owns the configured-hook lifecycle (load from
 * `IConfigService` + `IPluginService`, reload on plugin change) and runs
 * matching hooks. The per-scope observers (`AgentExternalHooksService`,
 * `SessionExternalHooksService`) inject this runner and pass per-call caller
 * facts (`cwd`, `sessionId`, `signal`, matcher/payload) at trigger time, so
 * the runner itself holds no per-scope state.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { HookBlockDecision, HookMatcherValue, HookResult } from '#/agent/externalHooks/types';

export interface ExternalHooksRunnerTriggerArgs {
  readonly matcherValue?: HookMatcherValue;
  readonly inputData?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly sessionId?: string;
}

export interface IExternalHooksRunnerService {
  readonly _serviceBrand: undefined;
  trigger(event: string, args?: ExternalHooksRunnerTriggerArgs): Promise<HookResult[]>;
  triggerBlock(
    event: string,
    args?: ExternalHooksRunnerTriggerArgs,
  ): Promise<HookBlockDecision | undefined>;
  fireAndForgetTrigger(event: string, args?: ExternalHooksRunnerTriggerArgs): Promise<HookResult[]>;
}

export const IExternalHooksRunnerService: ServiceIdentifier<IExternalHooksRunnerService> =
  createDecorator<IExternalHooksRunnerService>('externalHooksRunnerService');
