import { createFacadeToken } from '@moonshot-ai/agent-core';
import { type RuntimeEvent, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import type { HookDef } from '#/features/externalHooks/index';
import type { OsHost } from '#/features/os/host/index';
import type { SkillDefinition, SkillRoot } from '#/features/skill/catalog/types';

import type { McpServerConfig } from './manifest/mcp-config';
import type {
  EnabledPluginSessionStart,
  EnabledPluginSystemPrompt,
  PluginAgentRoot,
  PluginCommandDef,
  PluginInfo,
  PluginMcpServerEntry,
  PluginMutationSummary,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from './types';

export interface PluginChangedEvent extends RuntimeEvent {
  readonly type: 'plugin.changed';
  readonly summary: ReloadSummary;
}

export interface PluginMutatedEvent extends RuntimeEvent {
  readonly type: 'plugin.mutated';
  readonly summary: PluginMutationSummary;
}

export type PluginEvent = PluginChangedEvent | PluginMutatedEvent;

export interface PluginFace {
  readonly lastMutation: ShallowRef<PluginMutationSummary | null>;
  readonly lastReload: ShallowRef<ReloadSummary | null>;
  listPlugins(): Promise<readonly PluginSummary[]>;
  installPlugin(source: string): Promise<PluginSummary>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
  removePlugin(id: string): Promise<void>;
  reloadPlugins(): Promise<ReloadSummary>;
  getPluginInfo(id: string): Promise<PluginInfo>;
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
  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
}

export const PluginRef = createFacadeToken<PluginFace>('plugin');

export interface CreatePluginProps {
  readonly homeDir: string;
  readonly host?: OsHost;
  readonly onWarn?: (message: string) => void;
}
