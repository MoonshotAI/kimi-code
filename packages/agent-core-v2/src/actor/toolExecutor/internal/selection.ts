import { Disposable } from '#/_base/di/lifecycle';
import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import { defineState } from '#/state/state';
import { IFlagService } from '#/app/flag/flag';
import type { Tool } from '#/kosong/contract/tool';
import { AgentContextMemory, ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { ContextSpliced } from '#/actor/contextMemory/contextEvents';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { CompactionCompleted } from '#/actor/fullCompaction/fullCompactionEvents';
import { AgentProfile, type ProfileRuntime } from '#/actor/profile/profileAgentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { isMcpToolName, type ToolInfo } from '#/tool/toolContract';
import { IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ToolCatalog } from '#/actor/toolExecutor/internal/catalog';
import type { AgentToolsPolicy } from '#/actor/toolExecutor/internal/toolPolicy';
import type { ToolExecutorPipeline } from '#/actor/toolExecutor/internal/executor';
import {
  collectLoadedDynamicToolNames,
  foldAnnouncedToolNames,
  renderLoadableToolsAnnouncement,
  stripDynamicToolContext,
} from '#/agent/toolSelect/dynamicTools';
import { TOOL_SELECT_FLAG_ID } from '#/agent/toolSelect/flag';
import {
  SELECT_TOOLS_TOOL_NAME,
  type LoadToolsResult,
  type ShapedToolEntry,
} from '#/actor/toolExecutor/toolSelection';

export const toolSelectPendingLoadedKey = defineState<Set<string>>(
  'toolSelect.pendingLoaded',
  () => new Set(),
);

export class AgentToolsSelection extends Disposable {
  private readonly context: ContextMemoryRuntime;
  private readonly manager: IAgentLifecycleService;
  private readonly flags: IFlagService;
  private readonly states: IAgentStateService;

  constructor(
    private readonly runtime: AgentRuntimeContext<unknown>,
    private readonly toolRegistry: ToolCatalog,
    private readonly toolPolicy: AgentToolsPolicy,
    pipeline: ToolExecutorPipeline,
  ) {
    super();
    this.manager = runtime.get(IAgentLifecycleService);
    this.flags = runtime.get(IFlagService);
    const host = runtime.get(IAgentHostService).of(runtime.agent);
    this.states = host.state;
    this.context = this.manager.resolve(runtime.agent, AgentContextMemory);
    this.states.contributeState(toolSelectPendingLoadedKey);
    this._register(pipeline.registerUnavailableToolDescriber((name) => this.describeUnavailableTool(name)));
    this._register(pipeline.registerMissingToolDescriber((name) => this.describeMissingTool(name)));
    this._register(
      host.eventBus.subscribe(CompactionCompleted, () => {
        this.pendingLoaded.clear();
      }),
    );
    this._register(
      host.eventBus.subscribe(ContextSpliced, (splice) => {
        if (splice.deleteCount === 0 || splice.messages.length > 0) return;
        this.dropPendingLoadedNotLanded();
      }),
    );
  }

  private get pendingLoaded(): Set<string> {
    return this.states.get(toolSelectPendingLoadedKey);
  }

  private profile(): ProfileRuntime {
    return this.manager.resolve(this.runtime.agent, AgentProfile);
  }

  private dropPendingLoadedNotLanded(): void {
    if (this.pendingLoaded.size === 0) return;
    const landed = collectLoadedDynamicToolNames(this.context.get());
    for (const name of this.pendingLoaded) {
      if (!landed.has(name)) this.pendingLoaded.delete(name);
    }
  }

  enabled(): boolean {
    const capabilities = this.profile().modelCapabilities();
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
          this.toolPolicy.isActive(info.name, info.source),
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
        this.toolPolicy.isActive(name, info.source)
      );
    }
    if (isMcpToolName(name)) return this.toolPolicy.isActive(name, 'mcp');
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
        this.toolPolicy.isActive(entry.name, entry.source) ||
        (disclosure &&
          entry.name === SELECT_TOOLS_TOOL_NAME &&
          this.toolPolicy.isActiveForDisclosure(entry.name, entry.source));
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

