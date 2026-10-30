import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { HookDef } from '#/features/externalHooks/internal/types';
import type { SkillRoot } from '#/features/skill/catalog/types';
import type { McpServerConfig } from '#/mcpCore/config-schema';

import type {
  EnabledPluginSessionStart,
  EnabledPluginSystemPrompt,
  PluginAgentRoot,
  PluginCapabilities,
  PluginCommandDef,
  PluginInfo,
  PluginMcpServerEntry,
  PluginMutationSummary,
  PluginReloadEvent,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from './types';

export type InstallPluginInput =
  | { readonly source: string }
  | {
      readonly marketplaceId: string;
      readonly expectedVersion: string;
      readonly marketplaceSource?: string;
      readonly migrateFrom?: string;
    };

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
  readonly locale?: string;
}

export interface PreviewPluginInput {
  readonly marketplaceId: string;
  readonly expectedVersion: string;
  readonly locale?: string;
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
  previewPlugin(input: PreviewPluginInput): Promise<PluginCapabilities>;
  listPluginCommands(): Promise<readonly PluginCommandDef[]>;
  checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
  pluginSkillRoots(): Promise<readonly SkillRoot[]>;
  pluginAgentRoots(): Promise<readonly PluginAgentRoot[]>;
  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]>;
  enabledSystemPrompts(): Promise<readonly EnabledPluginSystemPrompt[]>;
  enabledMcpServers(): Promise<Record<string, McpServerConfig>>;
  mcpServerEntries(): Promise<readonly PluginMcpServerEntry[]>;
  enabledHooks(): Promise<readonly HookDef[]>;
  hasLoadedSnapshot(): boolean;
  enabledPluginIds(): readonly string[] | undefined;
  readonly onDidReload: Event<PluginReloadEvent>;
  readonly onDidMutate: Event<PluginMutationSummary>;
}

export const IPluginService: ServiceIdentifier<IPluginService> =
  createDecorator<IPluginService>('pluginService');
