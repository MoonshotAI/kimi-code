/**
 * `workspaceAgentProfileLoader` domain — `IExtraAgentProfileLoader` contract.
 *
 * The extra loader of the agent-profile extension point: owns the `extra`
 * record of the `AgentProfileContribution` collection — the agent files
 * discovered from the configured `extraAgentDirs`, tagged with this handler's
 * `workspaceId` (relative configured paths resolve against the workspace
 * root, so the record is workspace-local even though the config section
 * is global). `ready` tracks the most recent discovery pass; `reload()`
 * re-discovers and re-contributes. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IExtraAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const IExtraAgentProfileLoader: ServiceIdentifier<IExtraAgentProfileLoader> =
  createDecorator<IExtraAgentProfileLoader>('extraAgentProfileLoader');
