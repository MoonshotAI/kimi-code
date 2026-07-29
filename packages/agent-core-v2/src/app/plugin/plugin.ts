/**
 * `plugin` domain (L3) — App-scoped plugin management and consumption contract.
 *
 * Defines `IPluginService`, which manages installed plugins and exposes their
 * enabled commands, skills, session-start content, system-prompt sections,
 * MCP servers, and hooks. Successful mutations expose an awaitable
 * `onDidChange` synchronization point whose `kind` tells consumers whether the
 * prompt-relevant catalog changed (`catalog`) or only MCP server enablement
 * did (`mcp`); explicit reloads are also announced through `onDidReload` as
 * soon as the reload commits, without waiting for `onDidChange`
 * participants. Participants are delivered and awaited one at a time, so a
 * mutation's latency grows with the number of live sessions; both kinds
 * share one change queue, so an `mcp` change also waits for a prior
 * `catalog` barrier to finish. `waitUntil`
 * work must never call back into plugin mutations — the new mutation queues
 * behind the barrier its own wait feeds, deadlocking the queue; consumption
 * reads and session-internal work are the safe kinds. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event, IWaitUntil } from '#/_base/event';
import type { HookDef } from '#/agent/externalHooks/types';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { SkillRoot } from '#/app/skillCatalog/types';

import type {
  EnabledPluginSessionStart,
  EnabledPluginSystemPrompt,
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

export type PluginChangeKind = 'catalog' | 'mcp';

export interface PluginChangedEvent extends IWaitUntil {
  readonly kind: PluginChangeKind;
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
  enabledSystemPrompts(): Promise<readonly EnabledPluginSystemPrompt[]>;
  enabledMcpServers(): Promise<Record<string, McpServerConfig>>;
  enabledHooks(): Promise<readonly HookDef[]>;
  readonly onDidChange: Event<PluginChangedEvent>;
  readonly onDidReload: Event<ReloadSummary>;
}

export const IPluginService: ServiceIdentifier<IPluginService> =
  createDecorator<IPluginService>('pluginService');
