/**
 * `workspaceAgentProfileLoader` domain — `IWorkspaceAgentProfileLoader` contract.
 *
 * The workspace loader of the agent-profile extension point: owns the
 * `workspace` contribution in the App-scope `IAgentProfileRegistry` — the
 * agent files discovered under this handler's project root, tagged with the
 * handler's `workspaceId` so concurrent handlers never collide and the
 * sessions of THIS workspace project exactly this entry. `ready` tracks the
 * most recent discovery pass; `reload()` re-discovers and re-registers.
 * Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IWorkspaceAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const IWorkspaceAgentProfileLoader: ServiceIdentifier<IWorkspaceAgentProfileLoader> =
  createDecorator<IWorkspaceAgentProfileLoader>('workspaceAgentProfileLoader');
