/**
 * `externalHooks` domain (L6) — Session-scope external hook observer contract.
 *
 * The implementation registers session lifecycle callbacks from its
 * constructor (for `SessionStart` / `SessionEnd`) and observes the
 * requester-side agent-run hook slots hosted on `agentLifecycle`'s
 * `IAgentLifecycleService` to translate them into `SubagentStart` /
 * `SubagentStop` external hook commands. The slot host and its observer live
 * in separate Session-scope services so the runner (`mirrorAgentRun`) owns the
 * slots it runs, matching the Agent-scope pattern where the behavior services
 * own the slots and the external-hooks adapter only observes.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionExternalHooksService {
  readonly _serviceBrand: undefined;
}

export const ISessionExternalHooksService: ServiceIdentifier<ISessionExternalHooksService> =
  createDecorator<ISessionExternalHooksService>('sessionExternalHooksService');
