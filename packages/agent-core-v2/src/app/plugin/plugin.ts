import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { HookDef } from '#/agent/externalHooks/types';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { SkillRoot } from '#/app/globalSkillCatalog/types';

import type {
  EnabledPluginSessionStart,
  PluginCommandDef,
  PluginInfo,
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
  getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo | undefined>;
  listPluginCommands(): Promise<readonly PluginCommandDef[]>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  // --- consumption plane (loaded from enabled, error-free plugins) ---------

  /** Skill roots contributed by enabled plugins (fed into skill discovery). */
  pluginSkillRoots(): Promise<readonly SkillRoot[]>;
  /** Session-start reminders declared by enabled plugins. */
  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]>;
  /** MCP servers contributed by enabled plugins, keyed by runtime name. */
  enabledMcpServers(): Promise<Record<string, McpServerConfig>>;
  /** Hooks contributed by enabled plugins (cwd + env already resolved). */
  enabledHooks(): Promise<readonly HookDef[]>;
  /** Fires after a successful `reloadPlugins()` with the reload summary. */
  readonly onDidReload: Event<ReloadSummary>;
}

export const IPluginService: ServiceIdentifier<IPluginService> =
  createDecorator<IPluginService>('pluginService');
