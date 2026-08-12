/**
 * `toolSelect` domain — `IAgentToolSelectService` implementation.
 *
 * Shapes the provider-visible tool and history views for progressive tool
 * disclosure, tracks loaded dynamic schemas as pending declarations drained
 * by the `contextInjector` boundary provider (the declaration lands at a
 * quiescent boundary instead of mid-step inside a streaming tool exchange),
 * and exposes loadable-tools announcement text. Removal splices
 * (`undo`/`clear`) drop pending entries whose announcing exchange left the
 * conversation, while compaction's replacement splice keeps them, so the
 * declaration still lands at the post-compaction boundary. Reads live tools from
 * `toolRegistry`, active-tool and capability state from `profile`, gates
 * through `flag`, hooks into `toolExecutor`, and listens to context
 * lifecycle events through `event`. The mutable load-tracking state
 * (`pendingLoaded`) is registered into `agentState` (`IAgentStateService`)
 * and read/written through it. Bound at Agent scope.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import type { Tool } from '#/kosong/contract/tool';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isMcpToolName, type ToolInfo } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';

import {
  collectLoadedDynamicToolNames,
  foldAnnouncedToolNames,
  renderLoadableToolsAnnouncement,
  stripDynamicToolContext,
} from './dynamicTools';
import { TOOL_SELECT_FLAG_ID } from './flag';
import {
  IAgentToolSelectService,
  SELECT_TOOLS_TOOL_NAME,
  type LoadToolsResult,
  type ShapedToolEntry,
} from './toolSelect';

export const toolSelectPendingLoadedKey = defineState<Set<string>>(
  'toolSelect.pendingLoaded',
  () => new Set(),
);

export class AgentToolSelectService extends Service implements IAgentToolSelectService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(toolSelectPendingLoadedKey);
    this._register(
      toolExecutor.registerUnavailableToolDescriber((name) => this.describeUnavailableTool(name)),
    );
    this._register(
      toolExecutor.registerMissingToolDescriber((name) => this.describeMissingTool(name)),
    );
    this._register(
      eventBus.subscribe('compaction.completed', () => {
        this.pendingLoaded.clear();
      }),
    );
    this._register(
      eventBus.subscribe('context.spliced', (splice) => {
        if (splice.deleteCount === 0 || splice.messages.length > 0) return;
        this.dropPendingLoadedNotLanded();
      }),
    );
  }

  private get pendingLoaded(): Set<string> {
    return this.states.get(toolSelectPendingLoadedKey);
  }

  private dropPendingLoadedNotLanded(): void {
    if (this.pendingLoaded.size === 0) return;
    const landed = collectLoadedDynamicToolNames(this.context.get());
    for (const name of this.pendingLoaded) {
      if (!landed.has(name)) this.pendingLoaded.delete(name);
    }
  }

  enabled(): boolean {
    const capabilities = this.profile.getModelCapabilities();
    return (
      capabilities.dynamically_loaded_tools === true &&
      capabilities.tool_use &&
      this.flags.enabled(TOOL_SELECT_FLAG_ID)
    );
  }

  shapeTools(entries: readonly ToolInfo[]): readonly ShapedToolEntry[] {
    const disclosure = this.enabled();
    const activeEntries = this.activeEntries(entries, disclosure);
    if (!disclosure) return activeEntries;
    const loaded = this.loadedToolNames();
    const shaped: ShapedToolEntry[] = [];
    for (const entry of activeEntries) {
      if (entry.name === SELECT_TOOLS_TOOL_NAME) {
        shaped.push(entry);
        continue;
      }
      if (!this.isDynamicallyLoadable(entry)) {
        shaped.push(entry);
        continue;
      }
      if (!loaded.has(entry.name)) continue;
      shaped.push({ ...entry, deferred: true });
    }
    return shaped;
  }

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (this.enabled()) return this.shapeActiveHistory(messages);
    return stripDynamicToolContext(messages);
  }

  load(names: readonly string[]): LoadToolsResult {
    const loadable = new Set(this.loadableToolNames());
    const loaded = this.activeLoadedToolNames();
    const toLoad: string[] = [];
    const alreadyAvailable: string[] = [];
    const unknown: string[] = [];
    for (const name of new Set(names)) {
      if (loaded.has(name)) {
        alreadyAvailable.push(name);
      } else if (loadable.has(name)) {
        toLoad.push(name);
      } else {
        unknown.push(name);
      }
    }
    if (toLoad.length > 0) {
      for (const name of toLoad) this.pendingLoaded.add(name);
    }
    return { toLoad, alreadyAvailable, unknown };
  }

  drainPendingToolSchemas(): readonly Tool[] | undefined {
    if (!this.enabled() || this.pendingLoaded.size === 0) return undefined;
    const names = [...this.pendingLoaded].toSorted((a, b) => a.localeCompare(b));
    const tools: Tool[] = [];
    for (const name of names) {
      const tool = this.schemaOf(name);
      if (tool === undefined) continue;
      this.pendingLoaded.delete(name);
      tools.push(tool);
    }
    return tools.length === 0 ? undefined : tools;
  }

  loadableToolsAnnouncement(): string | undefined {
    if (!this.enabled()) return undefined;
    const loadable = this.loadableToolNames();
    const loadableSet = new Set(loadable);
    const announced = foldAnnouncedToolNames(this.context.get());
    const added = loadable.filter((name) => !announced.has(name));
    const removed = [...announced]
      .filter((name) => !loadableSet.has(name))
      .toSorted((a, b) => a.localeCompare(b));
    if (added.length === 0 && removed.length === 0) return undefined;
    return renderLoadableToolsAnnouncement(added, removed);
  }

  private shouldIntercept(name: string): boolean {
    if (!this.enabled()) return false;
    const info = this.toolRegistry.list().find((entry) => entry.name === name);
    if (info === undefined || !this.isDynamicallyLoadable(info)) return false;
    if (!this.loadableToolNames().includes(name)) return false;
    return !this.activeLoadedToolNames().has(name);
  }

  private describeUnavailableTool(name: string): string | undefined {
    if (this.isInactiveLoadedTool(name)) return inactiveLoadedToolOutput(name);
    if (!this.shouldIntercept(name)) return undefined;
    return notLoadedToolOutput(name);
  }

  private describeMissingTool(name: string): string | undefined {
    if (!this.enabled()) return undefined;
    if (this.toolRegistry.resolve(name) !== undefined) return undefined;
    if (!this.loadedToolNames().has(name)) return undefined;
    if (isMcpToolName(name)) {
      return (
        `Tool "${name}" was loaded but its MCP server is currently disconnected. ` +
        'It may become available again when the server reconnects; do not retry immediately.'
      );
    }
    return (
      `Tool "${name}" was loaded but is no longer registered. ` +
      'Do not retry it unless it becomes available again.'
    );
  }

  private loadableToolNames(): string[] {
    return this.toolRegistry
      .list()
      .filter(
        (info) =>
          this.isDynamicallyLoadable(info) &&
          this.toolPolicy.isToolActive(info.name, info.source),
      )
      .map((info) => info.name)
      .toSorted((a, b) => a.localeCompare(b));
  }

  private loadedToolNames(): Set<string> {
    const names = collectLoadedDynamicToolNames(this.context.get());
    for (const name of this.pendingLoaded) names.add(name);
    return names;
  }

  private activeLoadedToolNames(): Set<string> {
    const names = this.loadedToolNames();
    for (const name of names) {
      if (!this.isLoadedToolActive(name)) names.delete(name);
    }
    return names;
  }

  private isInactiveLoadedTool(name: string): boolean {
    if (!this.enabled()) return false;
    return this.loadedToolNames().has(name) && !this.isLoadedToolActive(name);
  }

  private isLoadedToolActive(name: string): boolean {
    const info = this.toolRegistry.list().find((entry) => entry.name === name);
    if (info !== undefined) {
      return (
        this.isDynamicallyLoadable(info) &&
        this.toolPolicy.isToolActive(name, info.source)
      );
    }
    if (isMcpToolName(name)) return this.toolPolicy.isToolActive(name, 'mcp');
    return false;
  }

  private isDynamicallyLoadable(info: ToolInfo): boolean {
    return info.source === 'mcp' || info.disclosure === 'deferred';
  }

  private shapeActiveHistory(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    let shaped: ContextMessage[] | undefined;
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i]!;
      const next = this.shapeActiveMessage(message);
      if (next === message) {
        if (shaped !== undefined) shaped.push(message);
        continue;
      }
      if (shaped === undefined) shaped = messages.slice(0, i);
      if (next !== undefined) shaped.push(next);
    }
    return shaped ?? messages;
  }

  private shapeActiveMessage(message: ContextMessage): ContextMessage | undefined {
    const tools = message.tools;
    if (tools === undefined || tools.length === 0) return message;

    let kept: Tool[] | undefined;
    for (let i = 0; i < tools.length; i += 1) {
      const tool = tools[i]!;
      if (this.isLoadedToolActive(tool.name)) {
        if (kept !== undefined) kept.push(tool);
        continue;
      }
      if (kept === undefined) kept = tools.slice(0, i);
    }
    if (kept === undefined) return message;
    if (kept.length > 0) return { ...message, tools: kept };

    const { tools: _tools, ...rest } = message;
    void _tools;
    if (rest.content.length === 0 && rest.toolCalls.length === 0) return undefined;
    return rest;
  }

  private schemaOf(name: string): Tool | undefined {
    const tool = this.toolRegistry.resolve(name);
    if (tool === undefined) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  private activeEntries(entries: readonly ToolInfo[], disclosure: boolean): readonly ToolInfo[] {
    let filtered: ToolInfo[] | undefined;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const active =
        this.toolPolicy.isToolActive(entry.name, entry.source) ||
        (disclosure &&
          entry.name === SELECT_TOOLS_TOOL_NAME &&
          this.toolPolicy.isToolActiveForDisclosure(entry.name, entry.source));
      const keep = active && (disclosure || entry.name !== SELECT_TOOLS_TOOL_NAME);
      if (keep) {
        if (filtered !== undefined) filtered.push(entry);
        continue;
      }
      if (filtered === undefined) filtered = entries.slice(0, i);
    }
    return filtered ?? entries;
  }
}

function notLoadedToolOutput(name: string): string {
  return (
    `Tool "${name}" is available but not loaded. ` +
    `Call select_tools with ["${name}"] first, then call the tool.`
  );
}

function inactiveLoadedToolOutput(name: string): string {
  return (
    `Tool "${name}" was loaded but is no longer active. ` +
    'Ask the user to enable it before calling it again.'
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolSelectService,
  AgentToolSelectService,
  ScopeActivation.OnScopeCreated,
  'toolSelect',
);
