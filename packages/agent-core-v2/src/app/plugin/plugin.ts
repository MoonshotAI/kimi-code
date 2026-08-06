/**
 * `plugin` domain — App-scoped plugin management and consumption contract.
 *
 * Defines `IPluginService`, which manages installed plugins and exposes their
 * enabled commands, skills, session-start content, system-prompt sections,
 * MCP servers, and hooks. Successful reloads are announced through
 * `onDidReload`. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { HookDef } from '#/agent/externalHooks/types';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { SkillRoot } from '#/app/skillCatalog/types';

import type {
  EnabledPluginSessionStart,
  EnabledPluginSystemPrompt,
  PluginAgentRoot,
  PluginCommandDef,
  PluginInfo,
  PluginMutationSummary,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from './types';

export interface InstallPluginInput {
  readonly source: string;
}

export interface SetPluginEnabledInput {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SetPluginMcpServerEnabledInput {
  readonly id: string;
  readonly server: string;
  readonly enabled: boolean;
}

export interface RemovePluginInput {
  readonly id: string;
}

export interface GetPluginInfoInput {
  readonly id: string;
}

export interface IPluginService {
  readonly _serviceBrand: undefined;

  listPlugins(): Promise<readonly PluginSummary[]>;
  installPlugin(input: InstallPluginInput): Promise<PluginSummary>;
  setPluginEnabled(input: SetPluginEnabledInput): Promise<void>;
  setPluginMcpServerEnabled(input: SetPluginMcpServerEnabledInput): Promise<void>;
  removePlugin(input: RemovePluginInput): Promise<void>;
  reloadPlugins(): Promise<ReloadSummary>;
  getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo>;
  listPluginCommands(): Promise<readonly PluginCommandDef[]>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  pluginSkillRoots(): Promise<readonly SkillRoot[]>;
  pluginAgentRoots(): Promise<readonly PluginAgentRoot[]>;
  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]>;
  enabledSystemPrompts(): Promise<readonly EnabledPluginSystemPrompt[]>;
  enabledMcpServers(): Promise<Record<string, McpServerConfig>>;
  enabledHooks(): Promise<readonly HookDef[]>;
  // Consumption reads resolve to a per-method fallback (never reject) while
  // no snapshot has loaded; consumers pinning a read use this to tell a real
  // empty snapshot from the fallback.
  hasLoadedSnapshot(): boolean;
  readonly onDidReload: Event<ReloadSummary>;
  // Fires only after a mutation (install / enable / disable / remove) has
  // reloaded and notified — unlike `onDidReload`, an explicit
  // `reloadPlugins()` does not raise it, so live-session consumers can tell
  // "the plugin set changed under you" apart from a deliberate reload.
  readonly onDidMutate: Event<PluginMutationSummary>;
}

export const IPluginService: ServiceIdentifier<IPluginService> =
  createDecorator<IPluginService>('pluginService');
