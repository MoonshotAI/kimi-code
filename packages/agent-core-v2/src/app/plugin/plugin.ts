/**
 * `plugin` domain (L3) — App-scoped plugin management and consumption contract.
 *
 * Defines `IPluginService`, which manages installed plugins and exposes their
 * enabled commands, skills, session-start content, MCP servers, and hooks.
 * Successful reloads are announced through `onDidReload`. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { HookDef } from '#/agent/externalHooks/types';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { SkillRoot } from '#/app/skillCatalog/types';

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
  getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo>;
  listPluginCommands(): Promise<readonly PluginCommandDef[]>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  pluginSkillRoots(): Promise<readonly SkillRoot[]>;
  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]>;
  enabledMcpServers(): Promise<Record<string, McpServerConfig>>;
  enabledHooks(): Promise<readonly HookDef[]>;
  readonly onDidReload: Event<ReloadSummary>;
}

export const IPluginService: ServiceIdentifier<IPluginService> =
  createDecorator<IPluginService>('pluginService');
