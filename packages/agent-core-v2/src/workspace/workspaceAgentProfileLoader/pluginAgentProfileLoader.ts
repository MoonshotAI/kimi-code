/**
 * `workspaceAgentProfileLoader` domain — `IPluginAgentProfileLoader` contract.
 *
 * The plugin loader of the agent-profile extension point: owns the `plugin`
 * record of the `AgentProfileContribution` collection — the agent files
 * discovered from the enabled plugins' agent roots, tagged with this
 * handler's `workspaceId`. `ready` tracks the most recent discovery pass;
 * `reload()` re-discovers and re-contributes. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IPluginAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const IPluginAgentProfileLoader: ServiceIdentifier<IPluginAgentProfileLoader> =
  createDecorator<IPluginAgentProfileLoader>('pluginAgentProfileLoader');
