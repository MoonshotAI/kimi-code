/**
 * `workspaceAgentProfileLoader` domain — `IExplicitAgentProfileLoader` contract.
 *
 * The explicit loader of the agent-profile extension point: owns the
 * `explicit` contribution in the App-scope `IAgentProfileRegistry` — the
 * runtime-selected agent files (`--agent-file`), tagged with this handler's `workspaceId`.
 * The loader is `fatal`: an invalid explicit file is an explicit user intent
 * that must not be silently dropped, so the rejection propagates into `ready`
 * and session materialization fails fast; `reload()` re-arms it once the
 * offending file is fixed. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IExplicitAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const IExplicitAgentProfileLoader: ServiceIdentifier<IExplicitAgentProfileLoader> =
  createDecorator<IExplicitAgentProfileLoader>('explicitAgentProfileLoader');
