/**
 * `toolSelect` domain (L4) — `IAgentToolSelectService` implementation.
 *
 * Shapes the provider-visible tool and history views for progressive tool
 * disclosure, loads MCP schemas into `contextMemory`, and exposes
 * loadable-tools announcement text. Reads live tools from `toolRegistry`,
 * active-tool and capability state from `profile`, gates through `flag`,
 * hooks into `toolExecutor`, and listens to context lifecycle events through
 * `event`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import type { Tool } from '#/kosong/contract/tool';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ToolInfo } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';

import {
  collectLoadedDynamicToolNames,
  DYNAMIC_TOOL_SCHEMA_VARIANT,
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

export class AgentToolSelectService extends Disposable implements IAgentToolSelectService {
  declare readonly _serviceBrand: undefined;
  private readonly pendingLoaded = new Set<string>();

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
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
        if (splice.deleteCount === 0 || this.pendingLoaded.size === 0) return;
        const landed = collectLoadedDynamicToolNames(this.context.get());
        for (const name of this.pendingLoaded) {
          if (!landed.has(name)) this.pendingLoaded.delete(name);
        }
      }),
    );
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
      if (entry.source !== 'mcp') {
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
      toLoad.sort((a, b) => a.localeCompare(b));
      const tools = toLoad
        .map((name) => this.schemaOf(name))
        .filter((tool): tool is Tool => tool !== undefined);
      this.context.append({
        role: 'system',
        content: [],
        toolCalls: [],
        tools,
        origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
      });
      for (const name of toLoad) this.pendingLoaded.add(name);
    }
    return { toLoad, alreadyAvailable, unknown };
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
    const source = this.toolRegistry.list().find((info) => info.name === name)?.source;
    if (source !== 'mcp') return false;
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
    return (
      `Tool "${name}" was loaded but its MCP server is currently disconnected. ` +
      'It may become available again when the server reconnects; do not retry immediately.'
    );
  }

  private loadableToolNames(): string[] {
    return this.toolRegistry
      .list()
      .filter((info) => info.source === 'mcp' && this.profile.isToolActive(info.name, info.source))
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
    return this.profile.isToolActive(name, 'mcp');
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
        this.profile.isToolActive(entry.name, entry.source) ||
        (disclosure && entry.name === SELECT_TOOLS_TOOL_NAME);
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
  InstantiationType.Eager,
  'toolSelect',
);
