import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { abortable } from '#/_base/utils/abort';
import { IFlagService } from '#/app/flag/flag';
import type { ToolDescription as Tool } from '#human/llm/message';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isMcpToolName, type ToolInfo } from '#/tool/toolContract';
import { toLegacyToolReturn } from '#/tool/executor';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { legacyRejectedResult, runLegacyStarting } from '#/agent/toolExecutor/legacyHooks';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';

import {
  collectCurrentDynamicTools,
  collectLoadedDynamicTools,
  collectPendingSchemaUpdateNames,
  foldAnnouncedToolNames,
  isDynamicToolSchemaMessage,
  isLoadableToolsAnnouncement,
  renderLoadableToolsAnnouncement,
  shapeUnsupportedDynamicToolContext,
} from './dynamicTools';
import { TOOL_SELECT_FLAG_ID } from './flag';
import {
  IAgentToolSelectService,
  SELECT_TOOLS_TOOL_NAME,
  type LoadToolsResult,
  type ShapedToolEntry,
  type ToolSelectAnnouncement,
  type ToolSelectAnnouncementDisclosure,
  type ToolSelectCapabilities,
} from './toolSelect';
import {
  ToolSelectInitialized,
  ToolSelectToolsChanged,
  toolSelectKey,
  toolSelectVersionSignature,
  type ToolSelectModelState,
  type ToolSelectTool,
} from './toolSelectOps';

const STOP_RETRY_THRESHOLD = 2;
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

export class AgentToolSelectService extends Service implements IAgentToolSelectService {
  declare readonly _serviceBrand: undefined;

  private reconcileTail: Promise<void> = Promise.resolve();
  private readonly notifiedUpdates = new Set<string>();
  private pendingInitialization: readonly ToolSelectTool[] | undefined;

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentLoopService private readonly profile: IAgentLoopService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionMcpHandle private readonly mcpHandle: ISessionMcpHandle,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
  ) {
    super();
    this.states.contributeState(toolSelectKey);
    this._register(toolExecutor.registerHook({
      validating: (context) => {
        if (!collectPendingSchemaUpdateNames(this.history(), this.toolRegistry.list()).has(context.call.name)) {
          return undefined;
        }
        const text = schemaUpdateUnsupportedToolOutput(context.call.name);
        return {
          reject: text,
          result: toLegacyToolReturn({ output: text, isError: true }, context.call.name),
        };
      },
      starting: (context) => {
        const text = this.describeUnavailableTool(context.call.name);
        return text === undefined
          ? undefined
          : runLegacyStarting(context, (event) => event.veto({ output: text, isError: true }));
      },
      afterExecute: (context) => {
        const text = this.describeMissingTool(context.call.name);
        return text === undefined ? undefined : legacyRejectedResult(context, text);
      },
    }));
  }

  private history(): readonly ContextMessage[] {
    const space = this.scopeContext.agentContext.space;
    return space instanceof AgentSpaceImpl ? space.readHistory() as readonly ContextMessage[] : [];
  }

  featureEnabled(): boolean {
    return this.flags.enabled(TOOL_SELECT_FLAG_ID);
  }

  enabled(capabilities: ToolSelectCapabilities = this.profile.getModelCapabilities()): boolean {
    return (
      capabilities.dynamically_loaded_tools === true &&
      capabilities.tool_use === true &&
      this.featureEnabled()
    );
  }

  async prepareForRequest(signal?: AbortSignal): Promise<void> {
    await this.reconcileForRequest(signal, true);
  }

  async prepareCatalog(signal?: AbortSignal): Promise<void> {
    await this.reconcileForRequest(signal, false);
  }

  private async reconcileForRequest(signal: AbortSignal | undefined, publishInitialization: boolean): Promise<void> {
    await (signal === undefined ? this.mcpHandle.ready : abortable(this.mcpHandle.ready, signal));
    const work = this.reconcileTail.then(async () => {
      if (publishInitialization) await this.publishDeferredInitialization();
      await this.reconcile(signal, publishInitialization);
    });
    this.reconcileTail = work.catch(() => {});
    await (signal === undefined ? work : abortable(work, signal));
  }

  defaultTools(disclosure = this.enabled()): readonly Tool[] {
    return this.defaultToolsForDisclosure(disclosure);
  }

  initialTools(): readonly Tool[] {
    const tools = this.initialToolInfos();
    return this.activeEntries(tools, this.featureEnabled()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      deferred: tool.disclosure === 'deferred' ? true : undefined,
    }));
  }

  requestTools(
    base: readonly Tool[] | undefined,
    disclosure = this.enabled(),
    dynamic = false,
    messages: readonly ContextMessage[] = this.history(),
  ): readonly Tool[] {
    if (!dynamic) return base ?? this.defaultToolsForDisclosure(disclosure);
    if (disclosure) return base ?? [];
    const loaded = collectLoadedDynamicTools(messages);
    const tools = (base ?? []).filter((tool) => tool.name !== SELECT_TOOLS_TOOL_NAME && tool.deferred !== true);
    const names = new Set(tools.map((tool) => tool.name));
    for (const tool of loaded.values()) {
      if (names.has(tool.name)) continue;
      tools.push({ ...tool, deferred: undefined });
      names.add(tool.name);
    }
    return tools.toSorted((left, right) => left.name.localeCompare(right.name));
  }

  shapeTools(
    entries: readonly ToolInfo[],
    disclosure = this.enabled(),
  ): readonly ShapedToolEntry[] {
    return this.shapeToolsForDisclosure(entries, disclosure);
  }

  shapeHistory(
    messages: readonly ContextMessage[],
    disclosure = this.enabled(),
    tools = this.defaultTools(disclosure),
  ): readonly ContextMessage[] {
    return this.shapeHistoryForDisclosure(messages, disclosure, tools);
  }

  load(names: readonly string[]): LoadToolsResult {
    const current = this.currentTools();
    const loadable = new Set(this.loadableToolNames());
    const loaded = collectCurrentDynamicTools(this.history(), current);
    const historicallyLoaded = this.historicallyLoadedToolNames();
    this.resetFailuresIfToolsChanged(current);
    const toLoad: string[] = [];
    const alreadyAvailable: string[] = [];
    const alreadyCallable: string[] = [];
    const staleLoaded: string[] = [];
    const policyDenied: string[] = [];
    const unknown: string[] = [];
    for (const name of new Set(names)) {
      const info = current.find((entry) => entry.name === name);
      if (
        this.toolPolicy.isToolDenied(name, info?.source) ||
        (info !== undefined && !this.isToolActiveForSelection(info))
      ) {
        policyDenied.push(name);
      } else if (loadable.has(name)) {
        if (loaded.has(name)) alreadyAvailable.push(name);
        else toLoad.push(name);
      } else if (this.isStaticCallable(name, current)) {
        alreadyCallable.push(name);
      } else if (historicallyLoaded.has(name)) {
        staleLoaded.push(name);
      } else {
        unknown.push(name);
      }
    }
    const escalated: Record<string, number> = {};
    const succeeded = toLoad.length > 0 || alreadyAvailable.length > 0 || alreadyCallable.length > 0;
    this.consecutiveFailures = succeeded ? 0 : this.consecutiveFailures + 1;
    for (const name of [...toLoad, ...alreadyAvailable, ...alreadyCallable]) {
      this.failedSelectionAttempts.delete(name.toLowerCase());
    }
    const attemptsByKey = new Map<string, number>();
    for (const name of [...staleLoaded, ...policyDenied, ...unknown]) {
      const key = name.toLowerCase();
      let attempts = attemptsByKey.get(key);
      if (attempts === undefined) {
        attempts = (this.failedSelectionAttempts.get(key) ?? 0) + 1;
        this.failedSelectionAttempts.set(key, attempts);
        attemptsByKey.set(key, attempts);
      }
      if (attempts >= STOP_RETRY_THRESHOLD) escalated[name] = attempts;
    }
    const suggestions: Record<string, readonly string[]> = {};
    const suggestionPool = [...loadable];
    for (const name of unknown) {
      const candidates = suggestToolNames(name, suggestionPool);
      if (candidates.length > 0) suggestions[name] = candidates;
    }
    return {
      toLoad,
      alreadyAvailable,
      alreadyCallable,
      staleLoaded,
      policyDenied,
      unknown,
      escalated,
      consecutiveFailures: this.consecutiveFailures,
      suggestions,
      loadable: [...loadable].filter((name) => !loaded.has(name)),
      schemas: toLoad
        .flatMap((name) => {
          const schema = this.schemaOf(name);
          return schema === undefined ? [] : [schema];
        })
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    };
  }

  loadableToolsAnnouncement(
    lastDisclosure?: ToolSelectAnnouncementDisclosure,
  ): ToolSelectAnnouncement | undefined {
    const enabled = this.featureEnabled();
    const state = this.modelState();
    if (state.initial === undefined) return undefined;
    this.resetFailuresIfToolsChanged(state.current);
    const revision = state.changes.length;
    const runtimeRevision = enabled
      ? -1
      : state.changes.findIndex((change) => change.added.some((tool) => tool.origin === 'runtime'));
    const lastRevision = lastDisclosure?.revision ?? (runtimeRevision < 0 ? undefined : runtimeRevision);
    if (lastRevision === undefined || lastRevision > revision) {
      if (!enabled) return undefined;
      const legacy = this.legacyAnnouncement(revision);
      if (legacy !== undefined) return legacy;
      const tools = state.current.filter(
        (info) => this.isDynamicallyLoadable(info) && this.toolPolicy.isToolActive(info.name, info.source),
      );
      return {
        content: renderSnapshotAnnouncement(tools),
        disclosure: { kind: 'snapshot', revision, tools },
      };
    }
    for (let index = lastRevision; index < revision; index += 1) {
      const change = state.changes[index];
      if (change === undefined) return undefined;
      const added = change.added.filter((tool) => enabled ? this.isDynamicallyLoadable(tool) : tool.origin === 'runtime');
      const removed = change.removed.filter((tool) =>
        enabled
          ? this.isDynamicallyLoadable(tool) || !change.added.some(
              (next) => next.name === tool.name && !this.isDynamicallyLoadable(next),
            )
          : tool.origin === 'runtime');
      if (added.length === 0 && removed.length === 0) continue;
      return {
        content: renderDeltaAnnouncement(
          added,
          removed,
          state.current.some((tool) => this.isDynamicallyLoadable(tool)),
        ),
        disclosure: {
          kind: 'delta',
          revision: index + 1,
          added,
          removed,
        },
      };
    }
    return enabled ? this.legacyAnnouncement(revision) : undefined;
  }

  private legacyAnnouncement(revision: number): ToolSelectAnnouncement | undefined {
    const state = this.modelState();
    const history = this.history();
    const announced = foldAnnouncedToolNames(history);
    const loadable = state.current.filter(
      (info) => this.isDynamicallyLoadable(info) && this.toolPolicy.isToolActive(info.name, info.source),
    );
    const loadableNames = new Set(loadable.map((tool) => tool.name));
    const added = loadable.filter((tool) => !announced.has(tool.name));
    const known = [
      ...state.current,
      ...(state.initial ?? []),
      ...state.changes.flatMap((change) => [...change.added, ...change.removed]),
    ];
    const removed = [...announced]
      .filter((name) => !loadableNames.has(name))
      .toSorted((a, b) => a.localeCompare(b))
      .flatMap((name) => {
        const tool = known.find((entry) => entry.name === name);
        return tool === undefined ? [] : [tool];
      });
    if (added.length > 0 || removed.length > 0) {
      return {
        content: renderDeltaAnnouncement(added, removed, loadable.length > 0),
        disclosure: { kind: 'delta', revision, added, removed },
      };
    }
    if (loadable.length > 0) return undefined;
    const last = history.findLast(isLoadableToolsAnnouncement);
    const text = last?.content.map((part) => part.type === 'text' ? part.text : '').join('') ?? '';
    if (text.includes('No tools are currently available for dynamic loading in this session.')) {
      return undefined;
    }
    return {
      content: renderSnapshotAnnouncement([]),
      disclosure: { kind: 'snapshot', revision, tools: [] },
    };
  }

  private modelState(): ToolSelectModelState {
    return this.states.get(toolSelectKey);
  }

  private currentTools(): readonly ToolSelectTool[] {
    const state = this.modelState();
    if (state.initial !== undefined) return state.current;
    return this.activeTools('initial');
  }

  private initialToolInfos(): readonly ToolSelectTool[] {
    return this.modelState().initial ?? this.activeTools('initial');
  }

  private activeTools(origin: ToolSelectTool['origin']): readonly ToolSelectTool[] {
    return this.toolRegistry.list()
      .map((info) => normalizeTool(info, origin))
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  private liveTools(origin: ToolSelectTool['origin']): readonly ToolSelectTool[] {
    const live = this.toolRegistry.list();
    return live
      .map((info) => normalizeTool(info, origin))
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  private async publishDeferredInitialization(): Promise<void> {
    const tools = this.pendingInitialization;
    if (tools === undefined) return;
    this.pendingInitialization = undefined;
    await this.dispatcher.dispatch(
      new ToolSelectInitialized({ agentId: this.scopeContext.agentId, tools }),
    );
  }

  private async reconcile(signal: AbortSignal | undefined, publishInitialization: boolean): Promise<void> {
    signal?.throwIfAborted();
    const state = this.modelState();
    const live = this.liveTools('initial');
    if (state.initial === undefined) {
      const tools = this.activeTools('initial');
      if (publishInitialization) {
        await this.dispatcher.dispatch(
          new ToolSelectInitialized({ agentId: this.scopeContext.agentId, tools }),
        );
      } else {
        this.pendingInitialization = tools;
        this.states.set(toolSelectKey, {
          initial: tools.map((tool) => ({ ...tool })),
          current: tools.map((tool) => ({ ...tool })),
          changes: [],
        });
      }
      this.notifyUpdatedTools(live, signal);
      return;
    }
    const current = state.current;
    const currentNames = new Set(current.map((tool) => tool.name));
    const active = this.activeTools('initial');
    const activeNames = new Set(active.map((tool) => tool.name));
    const removed = current.filter((tool) => !activeNames.has(tool.name));
    const added = active.flatMap((tool) =>
      currentNames.has(tool.name) ? [] : [{ ...tool, origin: 'runtime' as const }]);
    if (added.length > 0 || removed.length > 0) {
      signal?.throwIfAborted();
      await this.dispatcher.dispatch(
        new ToolSelectToolsChanged({
          agentId: this.scopeContext.agentId,
          added,
          removed,
        }),
      );
    }
    this.notifyUpdatedTools(live, signal);
  }

  private notifyUpdatedTools(live: readonly ToolSelectTool[], signal?: AbortSignal): void {
    const liveByName = new Map(live.map((tool) => [tool.name, tool]));
    for (const active of this.modelState().current) {
      const next = liveByName.get(active.name);
      if (next === undefined || toolSelectVersionSignature(next) === toolSelectVersionSignature(active)) {
        continue;
      }
      const signature = toolSelectVersionSignature(next);
      if (this.notifiedUpdates.has(signature)) continue;
      signal?.throwIfAborted();
      this.notifiedUpdates.add(signature);
      this.reminder.notify(
        `Tool "${active.name}" has an update, but the update is not applied in this session. ` +
          'Continue using the currently registered version.',
        { variant: 'tool_update_pending' },
      );
    }
  }

  private defaultToolsForDisclosure(disclosure: boolean): readonly Tool[] {
    const entries = this.capableTools(disclosure);
    return this.shapeToolsForDisclosure(entries, disclosure).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      deferred: tool.deferred,
    }));
  }

  private capableTools(includeRuntime: boolean): readonly ToolSelectTool[] {
    const initial = this.initialToolInfos();
    const initialNames = new Set(initial.map((tool) => tool.name));
    const current = this.currentTools();
    const currentByName = new Map(current.map((tool) => [tool.name, tool]));
    return [
      ...initial.map((tool) => currentByName.get(tool.name) ?? tool),
      ...current.filter((tool) => includeRuntime && tool.origin === 'runtime' && !initialNames.has(tool.name)),
    ].toSorted((left, right) => left.name.localeCompare(right.name));
  }

  private shapeToolsForDisclosure(
    entries: readonly (ToolInfo | ToolSelectTool)[],
    disclosure: boolean,
  ): readonly ShapedToolEntry[] {
    const activeEntries = this.activeEntries(entries, disclosure);
    if (!disclosure) return activeEntries;
    const loaded = collectCurrentDynamicTools(this.history(), this.currentTools());
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

  private shapeHistoryForDisclosure(
    messages: readonly ContextMessage[],
    disclosure: boolean,
    tools: readonly Tool[],
  ): readonly ContextMessage[] {
    if (!disclosure) return shapeUnsupportedDynamicToolContext(messages);
    return this.shapeActiveHistory(messages, tools);
  }

  private readonly failedSelectionAttempts = new Map<string, number>();

  private consecutiveFailures = 0;
  private selectionEnvironment: string | undefined;

  private resetFailuresIfToolsChanged(registryInfos: readonly ToolSelectTool[]): void {
    const environment = JSON.stringify([
      this.toolPolicy.getPolicyFingerprint(),
      registryInfos
        .map((info) => [
          info.name,
          info.description,
          info.parameters,
          info.source,
          info.disclosure,
          info.origin,
        ] as const)
        .toSorted((left, right) => left[0].localeCompare(right[0])),
    ]);
    if (environment === this.selectionEnvironment) return;
    this.selectionEnvironment = environment;
    this.consecutiveFailures = 0;
    this.failedSelectionAttempts.clear();
  }

  private historicallyLoadedToolNames(): Set<string> {
    const names = new Set<string>();
    for (const message of this.history()) {
      if (!isDynamicToolSchemaMessage(message)) continue;
      for (const tool of message.tools ?? []) names.add(tool.name);
    }
    return names;
  }

  private loadableToolNames(): string[] {
    return this.currentTools()
      .filter(
        (info) =>
          this.isDynamicallyLoadable(info) &&
          this.toolPolicy.isToolActive(info.name, info.source),
      )
      .map((info) => info.name)
      .toSorted((a, b) => a.localeCompare(b));
  }

  private isInactiveLoadedTool(name: string): boolean {
    return this.historicallyLoadedToolNames().has(name) && !this.isLoadedToolActive(name);
  }

  private isLoadedToolActive(name: string): boolean {
    const info = this.currentTools().find((entry) => entry.name === name);
    if (info === undefined) {
      return isMcpToolName(name) && this.toolPolicy.isToolActive(name, 'mcp');
    }
    return (
      this.toolPolicy.isToolActive(name, info.source) &&
      !collectPendingSchemaUpdateNames(this.history(), this.toolRegistry.list()).has(name) &&
      (!this.isDynamicallyLoadable(info) ||
        collectCurrentDynamicTools(this.history(), this.currentTools()).has(name))
    );
  }

  private isDynamicallyLoadable(info: ToolInfo | ToolSelectTool): boolean {
    return info.disclosure === 'deferred' ||
      ('origin' in info && info.origin === 'runtime' &&
        !this.initialToolInfos().some(
          (tool) => tool.name === info.name && tool.disclosure !== 'deferred',
        ));
  }

  private isStaticCallable(name: string, registryInfos: readonly ToolSelectTool[]): boolean {
    const info = registryInfos.find((entry) => entry.name === name);
    if (info === undefined) return false;
    return !this.isDynamicallyLoadable(info) && this.isToolActiveForSelection(info);
  }

  private isToolActiveForSelection(info: ToolInfo | ToolSelectTool): boolean {
    return info.name === SELECT_TOOLS_TOOL_NAME
      ? this.toolPolicy.isToolActiveForDisclosure(info.name, info.source)
      : this.toolPolicy.isToolActive(info.name, info.source);
  }

  private shapeActiveHistory(
    messages: readonly ContextMessage[],
    tools: readonly Tool[],
  ): readonly ContextMessage[] {
    const inlineNames = new Set(tools.filter((tool) => tool.deferred !== true).map((tool) => tool.name));
    const firstToolDeclarations = new Map<string, { message: ContextMessage; toolIndex: number }>();
    const latestToolDeclarations = new Map<string, { message: ContextMessage; toolIndex: number }>();
    for (const message of messages) {
      if (message.role !== 'system' || message.tools === undefined) continue;
      for (let toolIndex = 0; toolIndex < message.tools.length; toolIndex += 1) {
        const tool = message.tools[toolIndex]!;
        if (!firstToolDeclarations.has(tool.name)) {
          firstToolDeclarations.set(tool.name, { message, toolIndex });
        }
        latestToolDeclarations.set(tool.name, { message, toolIndex });
      }
    }
    const pendingSchemaUpdates = collectPendingSchemaUpdateNames(messages, this.toolRegistry.list());
    let shaped: ContextMessage[] | undefined;
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i]!;
      const next = this.shapeActiveMessage(
        message,
        inlineNames,
        firstToolDeclarations,
        latestToolDeclarations,
        pendingSchemaUpdates,
      );
      if (next === message) {
        if (shaped !== undefined) shaped.push(message);
        continue;
      }
      if (shaped === undefined) shaped = messages.slice(0, i);
      if (next !== undefined) shaped.push(next);
    }
    return shaped ?? messages;
  }

  private shapeActiveMessage(
    message: ContextMessage,
    inlineNames: ReadonlySet<string>,
    firstToolDeclarations: ReadonlyMap<string, { readonly message: ContextMessage; readonly toolIndex: number }>,
    latestToolDeclarations: ReadonlyMap<string, { readonly message: ContextMessage; readonly toolIndex: number }>,
    pendingSchemaUpdates: ReadonlySet<string>,
  ): ContextMessage | undefined {
    if (message.role !== 'system') return message;
    const tools = message.tools;
    if (tools === undefined || tools.length === 0) return message;

    let kept: Tool[] | undefined;
    const schemaUpdates: string[] = [];
    for (let i = 0; i < tools.length; i += 1) {
      const tool = tools[i]!;
      const firstDeclaration = firstToolDeclarations.get(tool.name);
      const isFirstDeclaration =
        firstDeclaration !== undefined &&
        firstDeclaration.message === message &&
        firstDeclaration.toolIndex === i;
      if (!inlineNames.has(tool.name) && isFirstDeclaration) {
        if (kept !== undefined) kept.push(tool);
        continue;
      }
      const latestDeclaration = latestToolDeclarations.get(tool.name);
      const isLatestDeclaration =
        latestDeclaration !== undefined &&
        latestDeclaration.message === message &&
        latestDeclaration.toolIndex === i;
      if (
        !inlineNames.has(tool.name) &&
        !isFirstDeclaration &&
        isLatestDeclaration &&
        pendingSchemaUpdates.has(tool.name)
      ) {
        schemaUpdates.push(tool.name);
      }
      if (kept === undefined) kept = tools.slice(0, i);
    }
    if (kept === undefined) return message;
    const content: ContextMessage['content'] = [
      ...message.content,
      ...schemaUpdates.map((name) => ({
        type: 'text' as const,
        text: wrapSystemReminder(schemaUpdateUnsupportedToolOutput(name)),
      })),
    ];
    if (kept.length > 0) return { ...message, tools: kept, content };

    const { tools: _tools, ...rest } = message;
    void _tools;
    if (content.length === 0) return undefined;
    return { ...rest, content };
  }

  private schemaOf(name: string): Tool | undefined {
    const tool = this.currentTools().find((entry) => entry.name === name);
    if (tool === undefined) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  private activeEntries<T extends ToolInfo | ToolSelectTool>(
    entries: readonly T[],
    disclosure: boolean,
  ): readonly T[] {
    let filtered: T[] | undefined;
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

  private describeUnavailableTool(name: string): string | undefined {
    if (collectPendingSchemaUpdateNames(this.history(), this.toolRegistry.list()).has(name)) {
      return schemaUpdateUnsupportedToolOutput(name);
    }
    if (!this.isInactiveLoadedTool(name)) return undefined;
    return inactiveLoadedToolOutput(name);
  }

  private describeMissingTool(name: string): string | undefined {
    if (this.toolRegistry.resolve(name) !== undefined) return undefined;
    if (!this.historicallyLoadedToolNames().has(name)) return undefined;
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
}

function normalizeTool(info: ToolInfo, origin: ToolSelectTool['origin']): ToolSelectTool {
  return {
    name: info.name,
    description: info.description,
    parameters: structuredClone(info.parameters ?? EMPTY_TOOL_PARAMETERS),
    source: info.source,
    disclosure: info.disclosure,
    origin,
  };
}

function renderSnapshotAnnouncement(tools: readonly ToolSelectTool[]): string {
  const names = tools.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b));
  return renderLoadableToolsAnnouncement(names, [], names.length > 0);
}

function renderDeltaAnnouncement(
  added: readonly ToolSelectTool[],
  removed: readonly ToolSelectTool[],
  hasLoadable: boolean,
): string {
  return renderLoadableToolsAnnouncement(
    added.map((tool) => tool.name),
    removed.map((tool) => tool.name),
    hasLoadable,
  );
}

function suggestToolNames(name: string, pool: readonly string[]): readonly string[] {
  const lower = name.toLowerCase();
  const caseFix = pool.filter((candidate) => candidate.toLowerCase() === lower);
  if (caseFix.length > 0) return caseFix.toSorted((a, b) => a.localeCompare(b)).slice(0, 3);
  const matches = new Set<string>();
  const stripped = lower.startsWith('mcp__') ? lower.slice('mcp__'.length) : lower;
  if (stripped.length >= 3) {
    for (const candidate of pool) {
      if (candidate.toLowerCase().includes(stripped)) matches.add(candidate);
    }
  }
  if (matches.size === 0) {
    for (const candidate of pool) {
      const segments = candidate.split('__');
      const last = segments.at(-1)!.toLowerCase();
      if (last.length >= 3 && lower.includes(last)) matches.add(candidate);
    }
  }
  return [...matches].toSorted((a, b) => a.localeCompare(b)).slice(0, 3);
}

function schemaUpdateUnsupportedToolOutput(name: string): string {
  return (
    `Tool "${name}" has a schema update, but applying schema updates is not supported in this session. ` +
    'Start a new session to use the updated schema.'
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
