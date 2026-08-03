/**
 * `workspaceAgentProfileLoader` domain — `IPluginAgentProfileLoader` contract.
 *
 * The plugin loader of the agent-profile extension point: owns the `plugin`
 * contribution in the App-scope `IAgentProfileRegistry` — the agent files
 * discovered from the enabled plugins' agent roots, tagged with this
 * handler's `workspaceId`. `ready` tracks the most recent discovery pass;
 * `reload()` re-discovers and re-registers. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IPluginAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const IPluginAgentProfileLoader: ServiceIdentifier<IPluginAgentProfileLoader> =
  createDecorator<IPluginAgentProfileLoader>('pluginAgentProfileLoader');
