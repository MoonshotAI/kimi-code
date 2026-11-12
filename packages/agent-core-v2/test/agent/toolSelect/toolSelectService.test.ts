import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';

import { DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { createServices, type ServiceRegistration, type TestInstantiationService } from '#/_base/di/test';
import { OrderedHookSlot } from '#/hooks';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2, Event2Class } from '#/app/event/event2';
import { IFlagService } from '#/app/flag/flag';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import type { Message, ToolCall, ToolDescription as Tool } from '#human/llm/message';
import type { LlmRequest } from '#human/llm/request';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { contextFromHistoryEntry } from '#/agent/loop/history';
import { AgentSpaceImpl } from '#/agent/agentContext/agentSpace';
import type { HistoryMessage } from '#human/agent/turn';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { createReminderHarness } from '../../features/reminder/stubs';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type LoopSnapshot,
  type PromptSubmitContext,
  type Turn,
} from '#/agent/loop/loop';
import { createToolSelectResolver } from '#/agent/loop/toolSelectPolicy';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { StubEffectiveProfileReader } from '../loop/stubs';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolExecution,
} from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { executeLegacyTool, type LegacyExecutionResult } from '../toolExecutor/execute';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { memoryOutputStore } from '#/tool/executor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { DYNAMIC_TOOL_SCHEMA_VARIANT, LOADABLE_TOOLS_VARIANT } from '#/agent/toolSelect/dynamicTools';
import { TOOL_SELECT_FLAG_ID } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { AgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncementsService';
import { AgentToolSelectService } from '#/agent/toolSelect/toolSelectService';
import {
  ToolSelectInitialized,
  ToolSelectToolsChanged,
  toolSelectKey,
} from '#/agent/toolSelect/toolSelectOps';
import { SelectToolsTool } from '#/agent/tools/select-tools/selectToolsTool';
import { kimiOpenAIProtocol } from '#human/llm/builtin/provider/kimi/protocol';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IWireService } from '#/wire/wire';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { registerLogServices } from '../../_base/log/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';
import { registerStateServices } from '../../state/stubs';
import { stubToolExecutor, stubWire } from '../loop/stubs';
import { registerToolResultTruncationServices } from '../toolResultTruncation/stubs';

function toolsOf(message: Message | undefined) {
  return message?.role === 'system' ? message.tools : undefined;
}

const MCP_ALPHA = 'mcp__srv__alpha';
const MCP_BETA = 'mcp__srv__beta';
const MCP_GAMMA = 'mcp__srv__gamma';
const MCP_GONE = 'mcp__srv__gone';
const USER_DEFERRED = 'dashboard_create';
const USER_INLINE = 'echo_inline';
const UNKNOWN_SELECTION_REASON =
  'This name is not in the current loadable tool list. ' +
  'select_tools only loads exact announced names; it cannot search for capabilities or install tools. ';
const NO_ALIAS_GUIDANCE =
  ' Do not guess aliases; use an available tool or tell the user what capability is missing.';
const REQUIRED_PAYLOAD_PARAMETERS = {
  type: 'object',
  required: ['payload'],
  properties: { payload: { type: 'string' } },
  additionalProperties: false,
};

let disposables: DisposableStore;
let capabilities: ModelCapability;
let flagEnabled: boolean;
let activeToolNames: ReadonlySet<string> | undefined;
let disclosureToolActive: boolean;
let deniedToolNames: ReadonlySet<string>;

beforeEach(() => {
  disposables = new DisposableStore();
  capabilities = makeCapabilities({ tool_use: true, dynamically_loaded_tools: true });
  flagEnabled = false;
  activeToolNames = undefined;
  disclosureToolActive = true;
  deniedToolNames = new Set();
});

afterEach(() => disposables.dispose());

function makeCapabilities(overrides: {
  readonly tool_use?: boolean;
  readonly dynamically_loaded_tools?: boolean;
} = {}): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: overrides.tool_use ?? false,
    max_context_tokens: 128_000,
    dynamically_loaded_tools: overrides.dynamically_loaded_tools,
  };
}

function toolCall(id: string, name: string, args: unknown = {}): ToolCall {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function schemaMessage(...names: string[]): ContextMessage {
  return {
    role: 'system',
    content: [],
    tools: names.map((name) => ({
      name,
      description: name.startsWith('mcp__') ? `${name} desc` : 'Echo input text.',
      parameters: { type: 'object', additionalProperties: true },
    })),
    origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
  };
}

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  description: string;
  calls = 0;
  readonly parameters: Record<string, unknown>;

  constructor(
    readonly name: string,
    private readonly output: string = 'mcp ok',
    parameters?: Record<string, unknown>,
  ) {
    this.description = `${name} desc`;
    this.parameters = parameters ?? {
      type: 'object',
      additionalProperties: true,
    };
  }

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: this.output };
      },
    };
  }
}

class EchoTool implements ExecutableTool<Record<string, unknown>> {
  readonly parameters: Record<string, unknown> = { type: 'object', additionalProperties: true };
  calls = 0;

  constructor(readonly name = 'Echo', readonly description = 'Echo input text.') {}

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: 'echo ok' };
      },
    };
  }
}

class RecordingEventBus implements IEventBus {
  readonly _serviceBrand = undefined;
  private readonly typedHandlers = new Map<string, Array<(event: Event2) => void>>();
  private readonly allHandlers: Array<(event: Event2) => void> = [];
  readonly published: Event2[] = [];

  publish(event: Event2): void {
    this.published.push(event);
    for (const handler of this.allHandlers) handler(event);
    for (const handler of this.typedHandlers.get(event.type) ?? []) handler(event);
  }

  subscribe(
    typeOrHandler: string | Event2Class | ((event: Event2) => void),
    maybeHandler?: (event: Event2) => void,
  ) {
    if (typeof typeOrHandler === 'function' && !('type' in typeOrHandler)) {
      const handler = typeOrHandler as (event: Event2) => void;
      this.allHandlers.push(handler);
      return toDisposable(() => {
        const index = this.allHandlers.indexOf(handler);
        if (index >= 0) this.allHandlers.splice(index, 1);
      });
    }
    const type = typeof typeOrHandler === 'string' ? typeOrHandler : (typeOrHandler as Event2Class).type;
    const list = this.typedHandlers.get(type) ?? [];
    const handler = maybeHandler!;
    list.push(handler);
    this.typedHandlers.set(type, list);
    return toDisposable(() => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    });
  }
}

class FakeLoopService extends StubEffectiveProfileReader implements IAgentLoopService {
  readonly _serviceBrand = undefined;
  readonly requester = {} as IAgentLoopService['requester'];

  async start(): Promise<void> {}

  baselineTools(): readonly Tool[] {
    return [];
  }

  override getModelCapabilities(): ModelCapability {
    return capabilities;
  }

  bindingSnapshot(): ReturnType<IAgentLoopService['bindingSnapshot']> {
    return { thinkingLevel: 'off', systemPrompt: '' };
  }

  async setProfile(): Promise<void> {}

  async bindProfile(): Promise<void> {}

  async applyBindingSnapshot(): Promise<void> {}

  async setModel(model: string) {
    return { model };
  }

  history(): readonly ContextMessage[] {
    return [];
  }

  historyRevision(): number {
    return 0;
  }

  replaceHistory(_entries: readonly HistoryMessage[]): boolean {
    return true;
  }

  async initializeHistory(_entries: readonly HistoryMessage[]): Promise<void> {}

  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot<BeforeStepContext>(),
    onDidFinishStep: new OrderedHookSlot<AfterStepContext>(),
    onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>(),
  };

  submit(): never {
    throw new Error('unused in this suite');
  }

  steer(): never {
    throw new Error('unused in this suite');
  }

  cancel(): never {
    throw new Error('unused in this suite');
  }

  detachTool(): void {}

  registerToolBatchStarting(): IDisposable {
    return toDisposable(() => {});
  }

  abortTool(): void {}

  snapshot(): LoopSnapshot {
    return {
      state: 'idle',
      activeTurnId: undefined,
      activePromptId: undefined,
      queue: [],
      notificationCount: 0,
      paused: false,
      hasPendingRequests: false,
      turn: undefined,
      activeRequestId: undefined,
    };
  }

  promptHandle(): never {
    throw new Error('unused in this suite');
  }

  notifyClient(): never {
    throw new Error('unused in this suite');
  }

  notify(): never {
    throw new Error('unused in this suite');
  }

  sendNow(): never {
    throw new Error('unused in this suite');
  }

  remind(): void {}

  flushReminders(): void {}

  tryAcquireQuiescence(): IDisposable | undefined {
    return toDisposable(() => {});
  }

  tryAcquireHistorySnapshot(): IDisposable | undefined {
    return toDisposable(() => {});
  }

  async settled(): Promise<void> {}

  async retry(): Promise<never> {
    throw new Error('unused in this suite');
  }

  async close(): Promise<void> {}

  registerLoopErrorHandler(): IDisposable {
    throw new Error('unused in this suite');
  }
}

class FakeContextMemory extends FakeLoopService {
  readonly messages: ContextMessage[] = [];
  readonly appended: ContextMessage[] = [];

  override history(): readonly ContextMessage[] {
    return this.messages;
  }

  override replaceHistory(entries: readonly HistoryMessage[], _reason?: string): boolean {
    this.messages.splice(0, this.messages.length, ...entries.map((entry) => contextFromHistoryEntry(entry)));
    return true;
  }

  override async initializeHistory(entries: readonly HistoryMessage[]): Promise<void> {
    this.replaceHistory(entries);
  }

  override remind(...entries: readonly HistoryMessage[]): void {
    this.appended.push(...entries.map((entry) => contextFromHistoryEntry(entry)));
  }

  landAppended(): void {
    this.messages.push(...this.appended);
    this.appended.length = 0;
  }

  landAnnouncement(content: string): void {
    this.messages.push({
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>\n${content.trim()}\n</system-reminder>` }],
      origin: { kind: 'system_trigger', name: LOADABLE_TOOLS_VARIANT },
    });
  }
}

interface Harness {
  readonly ix: TestInstantiationService;
  readonly sut: IAgentToolSelectService;
  readonly registry: IAgentToolRegistryService;
  readonly contextMemory: FakeContextMemory;
  readonly loop: FakeLoopService;
  readonly eventBus: RecordingEventBus;
}

function registerSharedServices(
  reg: ServiceRegistration,
  contextMemory: FakeContextMemory,
  loop: FakeLoopService,
  eventBus: RecordingEventBus,
): void {
  const states = registerStateServices(reg);
  reg.defineInstance(IEventBus, eventBus);
  reg.defineInstance(IAgentLoopService, loop);
  reg.definePartialInstance(IAgentMcpService, {
    waitForInitialLoad: () => Promise.resolve(),
  });
  reg.definePartialInstance(ISessionMcpHandle, {
    ready: Promise.resolve(),
  });
  reg.defineInstance(IAgentLoopService, contextMemory);
  const scope = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main', generation: 1 });
  if (scope.agentContext.space instanceof AgentSpaceImpl) {
    scope.agentContext.space._setHistoryProvider(() => contextMemory.history());
  }
  reg.defineInstance(IAgentScopeContext, scope);
  reg.definePartialInstance(IAgentToolPolicyService, {
    isToolActive: (name: string) => activeToolNames === undefined || activeToolNames.has(name),
    isToolDenied: (name: string) => deniedToolNames.has(name),
    getPolicyFingerprint: () => JSON.stringify([
      activeToolNames === undefined ? null : [...activeToolNames].toSorted(),
      [...deniedToolNames].toSorted(),
    ]),
    isToolActiveForDisclosure: () => disclosureToolActive,
  });
  reg.definePartialInstance(IFlagService, {
    enabled: (id: string) => (id === TOOL_SELECT_FLAG_ID ? flagEnabled : false),
  });
  reg.defineInstance(IWireService, stubWire());
  reg.defineInstance(IEventDispatcher, {
    _serviceBrand: undefined,
    hooks: { onDidRestore: new OrderedHookSlot() },
    dispatch: async (event: Event2) => {
      eventBus.publish(event);
      if (!(event instanceof ToolSelectInitialized) && !(event instanceof ToolSelectToolsChanged)) return;
      const fold = toolSelectKey.replayable.folds.get(event.constructor as Event2Class);
      if (fold === undefined) throw new Error(`Missing tool-select fold for ${event.type}`);
      const next = produce(states.agent.get(toolSelectKey), (draft) => {
        fold(draft, event, {
          silent: true,
          checkpoint: () => {},
          clearCheckpoints: () => {},
          undoToCheckpoint: () => {},
          emit: () => {},
        });
      });
      states.agent.set(toolSelectKey, next);
    },
  } as unknown as IEventDispatcher);
  reg.defineInstance(
    IAgentReminderService,
    createReminderHarness(loop, contextMemory, eventBus),
  );
  reg.define(IAgentToolRegistryService, AgentToolRegistryService);
  reg.define(IAgentToolSelectService, AgentToolSelectService);
  reg.define(IAgentToolSelectAnnouncementsService, AgentToolSelectAnnouncementsService);
  registerLogServices(reg);
}

function mountAnnouncements(ix: TestInstantiationService): void {
  ix.get(IAgentToolSelectAnnouncementsService);
}

function createHarness(): Harness {
  const contextMemory = new FakeContextMemory();
  const loop = new FakeLoopService();
  const eventBus = new RecordingEventBus();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerSharedServices(reg, contextMemory, loop, eventBus);
      reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
    },
    strict: true,
  });
  mountAnnouncements(ix);
  return {
    ix,
    sut: ix.get(IAgentToolSelectService),
    registry: ix.get(IAgentToolRegistryService),
    contextMemory,
    loop,
    eventBus,
  };
}

function resolveWith(
  h: Harness,
  input: {
    readonly messages: readonly ContextMessage[];
    readonly tools?: readonly Tool[];
    readonly capabilities?: ModelCapability;
    readonly inferredCapabilities?: ModelCapability;
    readonly dynamic?: boolean;
  },
): Promise<LlmRequest> {
  const request: LlmRequest = {
    protocol: {
      base: {
        capability: () => input.inferredCapabilities,
      } as unknown as LlmRequest['protocol']['base'],
    },
    model: {
      spec: { provider: 'test', name: 'test-model', capability: input.capabilities },
    },
    profile: { tools: input.tools },
    content: { messages: input.messages },
  };
  return createToolSelectResolver(h.sut, input.dynamic).resolve(request, {
    signal: new AbortController().signal,
    appliedRecoveries: [],
    report: () => {},
  });
}

interface ExecutorHarness extends Harness {
  readonly executor: IAgentToolExecutorService;
}

function createExecutorHarness(): ExecutorHarness {
  const contextMemory = new FakeContextMemory();
  const loop = new FakeLoopService();
  const eventBus = new RecordingEventBus();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerSharedServices(reg, contextMemory, loop, eventBus);
      reg.defineInstance(ITelemetryService, recordingTelemetry([]));
      const scope = makeAgentScopeContext({ agentId: 'main', agentScope: '' });
      if (scope.agentContext.space instanceof AgentSpaceImpl) {
        scope.agentContext.space._setHistoryProvider(() => contextMemory.history());
      }
      reg.defineInstance(IAgentScopeContext, scope);
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      reg.defineInstance(IAgentTaskOutputService, { open: memoryOutputStore().open } as unknown as IAgentTaskOutputService);
      registerToolResultTruncationServices(reg);
    },
    strict: true,
  });
  mountAnnouncements(ix);
  return {
    ix,
    sut: ix.get(IAgentToolSelectService),
    registry: ix.get(IAgentToolRegistryService),
    executor: ix.get(IAgentToolExecutorService),
    contextMemory,
    loop,
    eventBus,
  };
}

function registerMcp(
  h: Harness,
  tool: StubMcpTool,
  disclosure: ToolDisclosure = 'deferred',
): IDisposable {
  h.registry.unregister(tool.name);
  const registration = h.registry.register(tool, { source: 'mcp', disclosure });
  disposables.add(registration);
  return registration;
}

function registerBuiltin(h: Harness, tool: EchoTool): void {
  disposables.add(h.registry.register(tool, { source: 'builtin' }));
}

function registerUser(
  h: Harness,
  tool: EchoTool,
  disclosure?: ToolDisclosure,
): IDisposable {
  h.registry.unregister(tool.name);
  const registration = h.registry.register(tool, { source: 'user', disclosure });
  disposables.add(registration);
  return registration;
}

function announcementText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function isNewAnnouncement(message: ContextMessage): boolean {
  return message.origin?.kind === 'injection' && message.origin.variant === LOADABLE_TOOLS_VARIANT;
}

async function announce(h: Harness, step = 1): Promise<string | undefined> {
  const before = h.contextMemory.appended.length;
  await h.loop.hooks.onWillBeginStep.run({
    turnId: 1,
    step,
    firstStepOfTurn: step === 1,
    signal: new AbortController().signal,
  });
  const announcement = h.contextMemory.appended.slice(before).find(isNewAnnouncement);
  h.contextMemory.landAppended();
  if (announcement === undefined) return undefined;
  return announcementText(announcement);
}

async function announceAfterCompaction(h: Harness): Promise<string | undefined> {
  h.eventBus.publish(
    new ContextSpliced({ agentId: 'main',
      start: 0,
      deleteCount: 1,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Compacted summary.' }],
              origin: { kind: 'compaction_summary' },
        },
      ],
    }),
  );
  return announce(h, 99);
}

async function execute(
  h: ExecutorHarness,
  call: ToolCall,
): Promise<readonly LegacyExecutionResult[]> {
  const results = await executeLegacyTool(h.executor, [call], {
    signal: new AbortController().signal,
    turnId: 1,
  });
  h.contextMemory.landAppended();
  return results;
}

describe('AgentToolSelectService gate', () => {
  it('opens only when dynamically_loaded_tools capability, tool_use capability and flag are all on', () => {
    flagEnabled = true;
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(true);
  });

  it('stays closed without the dynamically_loaded_tools capability', () => {
    flagEnabled = true;
    capabilities = makeCapabilities({ tool_use: true, dynamically_loaded_tools: false });
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(false);
  });

  it('stays closed without tool_use capability', () => {
    flagEnabled = true;
    capabilities = makeCapabilities({ tool_use: false, dynamically_loaded_tools: true });
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(false);
  });

  it('stays closed without the flag', () => {
    flagEnabled = false;
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(false);
  });
});

describe('AgentToolSelectService S0 baseline (gate closed)', () => {
  it.each([false, true])('keeps initial schemas pinned without dynamic loading (restored: %s)', async (restoring) => {
    flagEnabled = true;
    const h = createHarness();
    const old = new StubMcpTool('SchemaTool');
    const registration = h.registry.register(old, { source: 'builtin' });
    disposables.add(registration);
    registerBuiltin(h, new EchoTool('Unchanged'));
    disposables.add(h.registry.register(h.ix.createInstance(SelectToolsTool), { source: 'builtin' }));
    await h.sut.prepareForRequest();
    registration.dispose();
    const updated = new StubMcpTool('SchemaTool', 'ok', REQUIRED_PAYLOAD_PARAMETERS);
    disposables.add(h.registry.register(updated, { source: 'builtin' }));
    registerBuiltin(h, new EchoTool('LateTool'));
    await h.sut.prepareForRequest();
    const persisted = JSON.stringify(h.ix.get(IAgentStateService).get(toolSelectKey));
    const current = restoring ? createHarness() : h;
    if (restoring) {
      disposables.add(current.registry.register(updated, { source: 'builtin' }));
      registerBuiltin(current, new EchoTool('Unchanged'));
      registerBuiltin(current, new EchoTool('LateTool'));
      disposables.add(current.registry.register(current.ix.createInstance(SelectToolsTool), { source: 'builtin' }));
      current.ix.get(IAgentStateService).set(toolSelectKey, JSON.parse(persisted));
    }
    current.contextMemory.messages.push({
      role: 'system', content: [],
      tools: [{ name: updated.name, description: updated.description, parameters: updated.parameters }],
    }, userMessage('continue'));
    const history = structuredClone(current.contextMemory.history());
    const capabilities = makeCapabilities({ tool_use: true, dynamically_loaded_tools: false });
    const resolved = await resolveWith(current, { messages: current.contextMemory.history(), capabilities });
    expect(resolved.profile?.tools?.map((tool) => tool.name)).toEqual(['SchemaTool', 'Unchanged']);
    expect(resolved.profile?.tools?.find((tool) => tool.name === updated.name)?.parameters).toEqual(old.parameters);
    expect(resolved.content.messages).toEqual([userMessage('continue')]);
    expect(current.contextMemory.history()).toEqual(history);
    expect(JSON.stringify(current.ix.get(IAgentStateService).get(toolSelectKey))).toBe(persisted);
    expect(current.ix.get(IAgentStateService).get(toolSelectKey).initial?.find((tool) => tool.name === old.name)?.parameters)
      .toEqual(old.parameters);
    expect(current.ix.get(IAgentStateService).get(toolSelectKey).current.find((tool) => tool.name === old.name)?.parameters)
      .toEqual(old.parameters);
    const baseline = current.sut.initialTools();
    expect(baseline.find((tool) => tool.name === old.name)?.parameters).toEqual(old.parameters);
    expect(baseline.some((tool) => tool.name === 'LateTool')).toBe(false);
    activeToolNames = new Set(['Unchanged']);
    const filtered = await resolveWith(current, { messages: current.contextMemory.history(), capabilities });
    expect(filtered.profile?.tools?.map((tool) => tool.name)).toEqual(['Unchanged']);
  });

  it('shapeTools returns the identical array when dynamically_loaded_tools is absent', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);
    const baseline = h.sut.initialTools();
    expect(baseline.find((tool) => tool.name === MCP_ALPHA)?.deferred).toBe(true);
    expect(baseline.find((tool) => tool.name === 'Echo')?.deferred).toBeUndefined();
  });

  it('shapeHistory returns the identical array when there is nothing to strip', () => {
    const h = createHarness();
    const messages: readonly ContextMessage[] = [userMessage('a'), userMessage('b')];
    expect(h.sut.shapeHistory(messages)).toBe(messages);
  });

  it('shapeTools filters select_tools itself out of the view', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual(['Echo']);
    expect(shaped.every((entry) => entry.deferred === undefined)).toBe(true);
  });

  it('keeps deferred user tools inline while the disclosure gate is closed', () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(shaped.map((entry) => entry.name)).toContain(USER_DEFERRED);
    expect(shaped.find((entry) => entry.name === USER_DEFERRED)?.deferred).toBeUndefined();
  });

  it('shapeTools applies profile filtering and removes select_tools while the gate is closed', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    activeToolNames = new Set(['Echo']);

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual(['Echo']);
  });

  it('select_tools execution does not self-guard on model capabilities', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const execution = selectTools.resolveExecution({ names: [MCP_ALPHA] });
    expect(execution.isError).toBeUndefined();
    if (execution.isError === true) throw new Error('expected a runnable execution');
    const reminded: ContextMessage[] = [];
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'call-1',
      signal: new AbortController().signal,
      remind: (message) => reminded.push(message),
    });
    expect(result).toEqual({ output: `Loaded: ${MCP_ALPHA}` });
    expect(reminded).toHaveLength(1);
    expect(toolsOf(reminded[0])?.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
    expect(reminded[0]?.origin).toEqual({ kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT });
  });

  it('resolver strips dynamic context and chooses explicit, inline, or no tools by capability', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.landAnnouncement('<tools_added>\nt\n</tools_added>');
    const selectCall = toolCall('select-1', SELECT_TOOLS_TOOL_NAME, { names: ['t'] });
    const otherCall = toolCall('other-1', 'other');
    h.contextMemory.messages.push(
      schemaMessage('t'),
      { role: 'assistant', content: [], toolCalls: [selectCall] },
      { role: 'tool', toolCallId: 'select-1', content: [{ type: 'text', text: 'loaded' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'keep' }], toolCalls: [otherCall] },
      { role: 'tool', toolCallId: 'other-1', content: [{ type: 'text', text: 'other result' }] },
      userMessage('keep'),
    );
    const messages = h.contextMemory.history();
    const explicitTools: Tool[] = [
      { name: 'explicit', description: 'explicit tool', parameters: {}, deferred: true },
    ];

    const resolved = await resolveWith(h, { messages, tools: explicitTools });

    expect(resolved.profile?.tools).toBe(explicitTools);
    expect(resolved.content.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(resolved.content.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('The available tools changed during this session.'),
    });
    expect(resolved.content.messages[1]).toEqual(
      expect.objectContaining({ role: 'assistant', toolCalls: [otherCall] }),
    );
    expect(messages).toHaveLength(7);

    const inline = await resolveWith(h, {
      messages,
      capabilities: makeCapabilities({ tool_use: true, dynamically_loaded_tools: false }),
    });
    expect(inline.profile?.tools?.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
    expect(inline.profile?.tools?.[0]?.deferred).toBeUndefined();

    const withoutToolUse = await resolveWith(h, {
      messages,
      capabilities: makeCapabilities({ tool_use: false, dynamically_loaded_tools: false }),
    });
    expect(withoutToolUse.profile?.tools?.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
    expect(withoutToolUse.profile?.tools?.[0]?.deferred).toBeUndefined();
  });

  it('missing-tool wording falls back to the default message', async () => {
    const h = createExecutorHarness();
    const results = await execute(h, toolCall('call-1', MCP_GONE));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe(`Tool "${MCP_GONE}" not found`);
    expect(results[0]!.result.isError).toBe(true);
  });
});

describe('AgentToolSelectService view shaping (gate open)', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it.each(['builtin', 'mcp'] as const)('keeps pinned inline %s tools without duplicate declarations', async (source) => {
    const h = createExecutorHarness();
    const name = source === 'mcp' ? MCP_BETA : 'Echo';
    const old = new EchoTool(name);
    const registration = h.registry.register(old, { source, disclosure: 'inline' });
    disposables.add(registration);
    registerBuiltin(h, new EchoTool('Unchanged'));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await h.sut.prepareForRequest();
    const before = h.sut.defaultTools();
    const firstAnnouncement = h.sut.loadableToolsAnnouncement();
    await h.sut.prepareForRequest();
    expect(h.sut.defaultTools()).toEqual(before);

    registration.dispose();
    const updated = new EchoTool(name, 'Updated echo input text.');
    disposables.add(h.registry.register(updated, { source, disclosure: 'inline' }));
    registerUser(h, new EchoTool('LateTool'));
    await h.sut.prepareForRequest();
    const schema = { name, description: old.description, parameters: old.parameters };
    const earlierCall = toolCall('earlier-call', name);
    h.contextMemory.landAnnouncement(`<tools_added>\n${name}\n</tools_added>`);
    h.contextMemory.messages.push(
      userMessage('before update'),
      { role: 'assistant', content: [], toolCalls: [earlierCall] },
      { role: 'tool', toolCallId: earlierCall.id, content: [{ type: 'text', text: 'earlier result' }] },
      { role: 'system', content: [], tools: [schema] },
      { role: 'system', content: [{ type: 'text', text: 'keep body' }], tools: [schema] },
      schemaMessage(MCP_ALPHA),
    );
    const persisted = JSON.stringify(h.ix.get(IAgentStateService).get(toolSelectKey));
    const restored = createExecutorHarness();
    disposables.add(restored.registry.register(updated, { source, disclosure: 'inline' }));
    registerBuiltin(restored, new EchoTool('Unchanged'));
    registerMcp(restored, new StubMcpTool(MCP_ALPHA));
    registerUser(restored, new EchoTool('LateTool'));
    restored.ix.get(IAgentStateService).set(toolSelectKey, JSON.parse(persisted));
    restored.contextMemory.messages.push(...structuredClone(h.contextMemory.history()));

    for (const current of [h, restored]) {
      const resolved = await resolveWith(current, { messages: current.contextMemory.history(), capabilities });
      const top = resolved.profile?.tools ?? [];
      expect(top.find((tool) => tool.name === name)).toEqual({ ...schema, deferred: undefined });
      expect(top.find((tool) => tool.name === 'Unchanged')).toEqual(before.find((tool) => tool.name === 'Unchanged'));
      expect(top.some((tool) => tool.name === 'LateTool')).toBe(false);
      expect(top.find((tool) => tool.name === MCP_ALPHA)?.deferred).toBe(true);
      expect(current.sut.load([name])).toMatchObject({ alreadyCallable: [name], toLoad: [], schemas: [] });
      const announcement = current.sut.loadableToolsAnnouncement(firstAnnouncement?.disclosure);
      expect(announcement?.content).toContain('LateTool');
      expect(announcement?.content).not.toContain(name);
      const legacy = current.sut.loadableToolsAnnouncement()?.disclosure;
      expect(legacy?.kind).toBe('delta');
      if (legacy?.kind !== 'delta') throw new Error('expected a legacy loading correction');
      expect(legacy.added.map((tool) => tool.name)).not.toContain(name);
      expect(legacy.removed.map((tool) => tool.name)).toContain(name);
      expect(resolved.content.messages.some((message) => toolsOf(message)?.some((tool) => tool.name === name))).toBe(false);
      expect(resolved.content.messages).toContainEqual({ role: 'system', content: [{ type: 'text', text: 'keep body' }] });
      expect(resolved.content.messages).toContainEqual({ role: 'assistant', content: [], toolCalls: [earlierCall] });
      const encoded = kimiOpenAIProtocol.encode({
        model: { spec: { provider: 'kimi', name: 'test-model' } },
        profile: resolved.profile ?? {},
        content: resolved.content,
        options: undefined,
      });
      expect(encoded.params.tools).toContainEqual({ type: 'function', function: schema });
      expect(encoded.params.messages.some((message) => 'tools' in message &&
        (message.tools as Array<{ function: { name: string } }>).some((tool) => tool.function.name === name))).toBe(false);
      const results = await execute(current, toolCall('current-call', name));
      expect(results[0]?.result.output).toBe('echo ok');
      expect(JSON.stringify(current.ix.get(IAgentStateService).get(toolSelectKey))).toBe(persisted);
      const original = current.ix.get(IAgentStateService).get(toolSelectKey).initial?.find((tool) => tool.name === name);
      expect(original?.description).toBe(old.description);
    }
  });

  it('preserves removal announcements for initial inline tools that disappear', async () => {
    const h = createHarness();
    const registration = registerUser(h, new EchoTool(USER_INLINE));
    await h.sut.prepareForRequest();
    const initial = h.sut.loadableToolsAnnouncement();
    registration.dispose();
    await h.sut.prepareForRequest();
    const next = h.sut.loadableToolsAnnouncement(initial?.disclosure);
    expect(next?.content).toContain(`<tools_removed>\n${USER_INLINE}\n</tools_removed>`);
  });

  it('deduplicates historical schemas and drops empty system messages', async () => {
    const h = createHarness();
    const original = new StubMcpTool(MCP_ALPHA);
    const registration = registerMcp(h, original);
    await h.sut.prepareForRequest();
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    h.contextMemory.messages.push({
      role: 'system',
      content: [{ type: 'text', text: 'keep body' }],
      tools: [{ name: MCP_ALPHA, description: original.description, parameters: original.parameters }],
      origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
    });
    registration.dispose();
    const updated = new StubMcpTool(MCP_ALPHA, 'ok', REQUIRED_PAYLOAD_PARAMETERS);
    registerMcp(h, updated);
    await h.sut.prepareForRequest();
    h.contextMemory.landAnnouncement(`<tools_removed>\n${MCP_ALPHA}\n</tools_removed>`);
    expect(h.sut.shapeHistory(h.contextMemory.history())).toHaveLength(2);
    h.contextMemory.messages.push({
      role: 'system',
      content: [],
      tools: [{ name: MCP_ALPHA, description: updated.description, parameters: updated.parameters }],
      origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
    });
    const resolved = await resolveWith(h, {
      messages: h.contextMemory.history(),
      tools: [],
      capabilities,
      dynamic: true,
    });
    expect(resolved.profile?.tools).toEqual([]);
    expect(resolved.content.messages).toHaveLength(3);
    expect(resolved.content.messages.flatMap((message) => toolsOf(message) ?? []).map((tool) => tool.parameters))
      .toEqual([updated.parameters]);
    expect(resolved.content.messages).toContainEqual({
      role: 'system',
      content: [{ type: 'text', text: 'keep body' }],
      origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
    });
    expect(h.contextMemory.history()).toHaveLength(4);
  });

  it.each(['inline', 'deferred', 'empty'] as const)('uses actual explicit %s tools when shaping historical definitions', async (mode) => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    const tools: Tool[] = mode === 'empty' ? [] : [{
      name: MCP_ALPHA,
      description: 'Explicit definition.',
      parameters: {},
      deferred: mode === 'deferred' ? true : undefined,
    }];
    const resolved = await resolveWith(h, { messages: h.contextMemory.history(), tools, capabilities });
    expect(resolved.profile?.tools).toBe(tools);
    expect(resolved.content.messages.flatMap((message) => toolsOf(message) ?? []).map((tool) => tool.name))
      .toEqual(mode === 'inline' ? [] : [MCP_ALPHA]);
    expect(h.contextMemory.history()).toHaveLength(1);
  });

  it('resolver freezes the turn baseline and projects history with protocol-inferred capabilities', async () => {
    capabilities = makeCapabilities({ tool_use: false, dynamically_loaded_tools: false });
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    const messages = h.contextMemory.history();
    const baseline = h.sut.initialTools();

    const resolved = await resolveWith(h, {
      messages,
      tools: baseline,
      inferredCapabilities: makeCapabilities({ tool_use: true, dynamically_loaded_tools: true }),
      dynamic: true,
    });

    const shaped = resolved.profile?.tools ?? [];
    expect(shaped).toBe(baseline);
    expect(shaped.map((entry) => entry.name)).toEqual(['Echo', MCP_ALPHA, MCP_BETA, SELECT_TOOLS_TOOL_NAME]);
    const byName = new Map(shaped.map((entry) => [entry.name, entry]));
    expect(byName.get(MCP_ALPHA)?.deferred).toBe(true);
    expect(byName.get(MCP_BETA)?.deferred).toBe(true);
    expect(byName.get('Echo')?.deferred).toBeUndefined();
    expect(byName.get(SELECT_TOOLS_TOOL_NAME)?.deferred).toBeUndefined();
    expect(resolved.content.messages).toBe(messages);

    const frozen = shaped.filter((tool) => tool.name !== 'Echo' && tool.name !== MCP_ALPHA);
    expect(h.sut.requestTools(undefined, true, true)).toEqual([]);
    expect(h.sut.requestTools([], true, true)).toEqual([]);
    expect(h.sut.requestTools(frozen, true, false)).toBe(frozen);
    expect(h.sut.requestTools(frozen, true, true)).toBe(frozen);
    const staticTools = h.sut.requestTools(shaped, false, true, messages);
    expect(staticTools.map((tool) => tool.name)).toEqual(['Echo', MCP_ALPHA]);
    expect(staticTools.find((tool) => tool.name === MCP_ALPHA)?.deferred).toBeUndefined();
    expect(h.sut.requestTools(shaped, true, true, messages)).toBe(shaped);
    expect(shaped.find((tool) => tool.name === SELECT_TOOLS_TOOL_NAME)).toBeDefined();
  });

  it('keeps inline-disclosed MCP tools visible and out of the loadable manifest', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA), 'inline');
    registerMcp(h, new StubMcpTool(MCP_BETA));
    await h.sut.prepareForRequest();

    const shaped = h.sut.shapeTools(h.registry.list());
    const byName = new Map(shaped.map((entry) => [entry.name, entry]));
    expect(byName.get(MCP_ALPHA)?.deferred).toBeUndefined();
    expect(byName.has(MCP_BETA)).toBe(false);

    const announcement = h.sut.loadableToolsAnnouncement();
    expect(announcement?.content).toContain(MCP_BETA);
    expect(announcement?.content).not.toContain(MCP_ALPHA);
  });

  it('defers only opted-in user tools and restores them after selection', () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    registerUser(h, new EchoTool(USER_INLINE));

    const beforeLoad = h.sut.shapeTools(h.registry.list());
    expect(beforeLoad.map((entry) => entry.name)).toContain(USER_INLINE);
    expect(beforeLoad.map((entry) => entry.name)).not.toContain(USER_DEFERRED);

    h.contextMemory.messages.push(schemaMessage(USER_DEFERRED));
    const afterLoad = h.sut.shapeTools(h.registry.list());
    expect(afterLoad.map((entry) => entry.name)).toContain(USER_DEFERRED);
    expect(afterLoad.find((entry) => entry.name === USER_DEFERRED)?.deferred).toBe(true);
    expect(afterLoad.find((entry) => entry.name === USER_INLINE)?.deferred).toBeUndefined();
  });

  it('keeps select_tools visible when the profile omits it while hiding inactive tools', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    activeToolNames = new Set([MCP_ALPHA]);

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual([
      MCP_ALPHA,
      SELECT_TOOLS_TOOL_NAME,
    ]);
  });

  it('hides select_tools when an explicit policy disables disclosure', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    activeToolNames = new Set([MCP_ALPHA]);
    disclosureToolActive = false;

    const shaped = h.sut.shapeTools(h.registry.list());

    expect(shaped.map((entry) => entry.name)).not.toContain(SELECT_TOOLS_TOOL_NAME);
  });

  it('shapeHistory returns the identical array', () => {
    const h = createHarness();
    h.contextMemory.messages.push(userMessage('a'), schemaMessage(MCP_ALPHA));
    const messages = h.contextMemory.history();
    expect(h.sut.shapeHistory(messages)).toBe(messages);
  });

  it('shapeHistory keeps loaded schemas when the current policy changes without a history removal', () => {
    const h = createHarness();
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA, MCP_BETA), userMessage('keep'));
    activeToolNames = new Set([MCP_BETA]);
    const messages = h.contextMemory.history();

    const shaped = h.sut.shapeHistory(messages);

    expect(shaped).toBe(messages);
    expect(toolsOf(shaped[0])?.map((tool) => tool.name)).toEqual([MCP_ALPHA, MCP_BETA]);
  });

  it('shapeHistory preserves a deferred user schema after unregister while execution reports it stale', () => {
    const h = createHarness();
    const registration = registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    h.contextMemory.messages.push(schemaMessage(USER_DEFERRED));
    const messages = h.contextMemory.history();
    registration.dispose();

    expect(h.sut.shapeHistory(messages)).toBe(messages);
    expect(h.sut.load([USER_DEFERRED])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      alreadyCallable: [],
      staleLoaded: [USER_DEFERRED],
      policyDenied: [],
      unknown: [],
      escalated: {},
      consecutiveFailures: 1,
      suggestions: {},
      loadable: [],
      schemas: [],
    });
    expect(toolsOf(h.contextMemory.history()[0])?.map((tool) => tool.name)).toEqual([
      USER_DEFERRED,
    ]);
  });

  it('shapeHistory keeps a deferred schema after an explicit same-name inline replacement', async () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    h.contextMemory.messages.push(schemaMessage(USER_DEFERRED));
    await h.sut.prepareForRequest();
    registerUser(h, new EchoTool(USER_DEFERRED));
    await h.sut.prepareForRequest();

    expect(h.sut.shapeHistory(h.contextMemory.history())).toHaveLength(1);
    const current = h.sut
      .shapeTools(h.registry.list())
      .find((entry) => entry.name === USER_DEFERRED);
    expect(current).toMatchObject({ name: USER_DEFERRED, disclosure: undefined });
    expect(current).not.toHaveProperty('deferred');
    expect(h.sut.load([USER_DEFERRED])).toEqual({
      toLoad: [],
      alreadyAvailable: [USER_DEFERRED],
      alreadyCallable: [],
      staleLoaded: [],
      policyDenied: [],
      unknown: [],
      escalated: {},
      consecutiveFailures: 0,
      suggestions: {},
      loadable: [],
      schemas: [],
    });
    expect(h.contextMemory.appended.filter(
      (message) => message.origin?.kind === 'injection' && message.origin.variant === 'tool_update_pending',
    )).toHaveLength(1);
  });
});

describe('AgentToolSelectService.load', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('settles per name and keeps same-name updates active with one reminder', async () => {
    const h = createHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha, 'inline');
    registerMcp(h, new StubMcpTool(MCP_BETA));
    await h.sut.prepareForRequest();
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));

    const result = h.sut.load([MCP_BETA, MCP_ALPHA, MCP_GONE]);
    expect(result.toLoad).toEqual([MCP_BETA]);
    expect(result.alreadyCallable).toEqual([MCP_ALPHA]);
    expect(result.unknown).toEqual([MCP_GONE]);
    expect(result.schemas.map((tool) => tool.name)).toEqual([MCP_BETA]);
    expect(h.contextMemory.appended).toHaveLength(0);

    alpha.description = `${MCP_ALPHA} updated desc`;
    await h.sut.prepareForRequest();
    const modified = h.sut.load([MCP_ALPHA]);
    expect(modified.toLoad).toEqual([]);
    expect(modified.alreadyCallable).toEqual([MCP_ALPHA]);
    expect(modified.schemas).toEqual([]);
    expect(h.registry.resolve(MCP_ALPHA)).toBe(alpha);
    expect(h.registry.list().find((tool) => tool.name === MCP_ALPHA)?.description)
      .toBe(`${MCP_ALPHA} updated desc`);
    expect(h.sut.defaultTools().find((tool) => tool.name === MCP_ALPHA)?.description)
      .toBe(`${MCP_ALPHA} desc`);

    const updateReminders = () => h.contextMemory.appended.filter(
      (message) => message.origin?.kind === 'injection' && message.origin.variant === 'tool_update_pending',
    );
    expect(updateReminders()).toHaveLength(1);
    expect(announcementText(updateReminders()[0]!)).toContain('not applied in this session');
    await h.sut.prepareForRequest();
    expect(updateReminders()).toHaveLength(1);

    const replacement = new StubMcpTool(MCP_ALPHA);
    replacement.description = `${MCP_ALPHA} updated desc`;
    h.registry.unregister(MCP_ALPHA);
    h.registry.register(replacement, { source: 'mcp', disclosure: 'inline' });
    await h.sut.prepareForRequest();
    expect(h.registry.resolve(MCP_ALPHA)).toBe(replacement);
    expect(h.registry.list().find((tool) => tool.name === MCP_ALPHA)?.description)
      .toBe(`${MCP_ALPHA} updated desc`);
    expect(updateReminders()).toHaveLength(1);
  });

  it('loads the schema of an opted-in user tool', () => {
    const h = createHarness();
    registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');

    expect(h.sut.load([USER_DEFERRED])).toEqual({
      toLoad: [USER_DEFERRED],
      alreadyAvailable: [],
      alreadyCallable: [],
      staleLoaded: [],
      policyDenied: [],
      unknown: [],
      escalated: {},
      consecutiveFailures: 0,
      suggestions: {},
      loadable: [USER_DEFERRED],
      schemas: [
        {
          name: USER_DEFERRED,
          description: 'Echo input text.',
          parameters: { type: 'object', additionalProperties: true },
        },
      ],
    });
  });

  it('sorts the declared schemas by name', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_BETA));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const { schemas } = h.sut.load([MCP_BETA, MCP_ALPHA]);
    expect(schemas.map((tool) => tool.name)).toEqual([MCP_ALPHA, MCP_BETA]);
  });

  it('reports names filtered out by the profile as not available in this session', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    activeToolNames = new Set([MCP_ALPHA]);

    const result = h.sut.load([MCP_ALPHA, MCP_BETA]);
    expect(result.toLoad).toEqual([MCP_ALPHA]);
    expect(result.policyDenied).toEqual([MCP_BETA]);
    expect(result.unknown).toEqual([]);
    expect(result.schemas.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
  });

  it('renders the select_tools tool output per name for mixed load results', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };

    const mixed = selectTools.resolveExecution({ names: [MCP_BETA, MCP_ALPHA, MCP_GONE] });
    if (mixed.isError === true) throw new Error('expected a runnable execution');
    expect(await mixed.execute(ctx)).toEqual({
      output: [
        `Loaded: ${MCP_BETA}`,
        `Already available: ${MCP_ALPHA}`,
        `Unknown tool: ${MCP_GONE}. ${UNKNOWN_SELECTION_REASON}Loadable tools: ${MCP_BETA}.${NO_ALIAS_GUIDANCE}`,
      ].join('\n'),
    });
  });

  it('returns an error when select_tools only receives unknown names', async () => {
    const h = createHarness();
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };
    const unknownOnly = selectTools.resolveExecution({ names: [MCP_GONE] });
    if (unknownOnly.isError === true) throw new Error('expected a runnable execution');
    expect(await unknownOnly.execute(ctx)).toEqual({
      output:
        `Unknown tool: ${MCP_GONE}. ${UNKNOWN_SELECTION_REASON}` +
        'No additional tools can be loaded right now; use the tools you already have.' + NO_ALIAS_GUIDANCE,
      isError: true,
    });
  });

  it('names the loadable tools inline when the list is short', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };
    const unknownOnly = selectTools.resolveExecution({ names: [MCP_GONE] });
    if (unknownOnly.isError === true) throw new Error('expected a runnable execution');
    expect(await unknownOnly.execute(ctx)).toEqual({
      output: `Unknown tool: ${MCP_GONE}. ${UNKNOWN_SELECTION_REASON}Loadable tools: ${MCP_ALPHA}, ${MCP_BETA}.${NO_ALIAS_GUIDANCE}`,
      isError: true,
    });
  });

  it('falls back to the generic hint when the loadable list is long', async () => {
    const h = createHarness();
    const names = [
      'mcp__srv__t1',
      'mcp__srv__t2',
      'mcp__srv__t3',
      'mcp__srv__t4',
      'mcp__srv__t5',
      'mcp__srv__t6',
    ];
    for (const name of names) registerMcp(h, new StubMcpTool(name));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };
    const unknownOnly = selectTools.resolveExecution({ names: [MCP_GONE] });
    if (unknownOnly.isError === true) throw new Error('expected a runnable execution');
    expect(await unknownOnly.execute(ctx)).toEqual({
      output: `Unknown tool: ${MCP_GONE}. ${UNKNOWN_SELECTION_REASON}Select only exact names from the current announcements.${NO_ALIAS_GUIDANCE}`,
      isError: true,
    });
  });

  it('says so explicitly when nothing is loadable in the session', async () => {
    const h = createHarness();
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };
    const unknownOnly = selectTools.resolveExecution({ names: ['some_unavailable_tool'] });
    if (unknownOnly.isError === true) throw new Error('expected a runnable execution');
    expect(await unknownOnly.execute(ctx)).toEqual({
      output:
        `Unknown tool: some_unavailable_tool. ${UNKNOWN_SELECTION_REASON}` +
        'No additional tools can be loaded right now; use the tools you already have.' + NO_ALIAS_GUIDANCE,
      isError: true,
    });
  });

  it('classifies an active static tool as alreadyCallable', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());

    expect(h.sut.load(['Echo'])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      alreadyCallable: ['Echo'],
      staleLoaded: [],
      policyDenied: [],
      unknown: [],
      escalated: {},
      consecutiveFailures: 0,
      suggestions: {},
      loadable: [],
      schemas: [],
    });
    expect(h.contextMemory.appended).toHaveLength(0);
  });

  it('suggests the announced name for a casing-only miss', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    expect(h.sut.load(['MCP__SRV__ALPHA'])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      alreadyCallable: [],
      staleLoaded: [],
      policyDenied: [],
      unknown: ['MCP__SRV__ALPHA'],
      escalated: {},
      consecutiveFailures: 1,
      suggestions: { 'MCP__SRV__ALPHA': [MCP_ALPHA] },
      loadable: [MCP_ALPHA],
      schemas: [],
    });
  });

  it('suggests candidates when the input is a substring of a loadable name', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    expect(h.sut.load(['mcp__alpha'])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      alreadyCallable: [],
      staleLoaded: [],
      policyDenied: [],
      unknown: ['mcp__alpha'],
      escalated: {},
      consecutiveFailures: 1,
      suggestions: { 'mcp__alpha': [MCP_ALPHA] },
      loadable: [MCP_ALPHA],
      schemas: [],
    });
  });

  it('suggests candidates when the input contains a candidate name segment', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    expect(h.sut.load(['alpha_extra'])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      alreadyCallable: [],
      staleLoaded: [],
      policyDenied: [],
      unknown: ['alpha_extra'],
      escalated: {},
      consecutiveFailures: 1,
      suggestions: { 'alpha_extra': [MCP_ALPHA] },
      loadable: [MCP_ALPHA],
      schemas: [],
    });
  });

  it('tells the model to call static tools directly instead of selecting them', async () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };
    const staticOnly = selectTools.resolveExecution({ names: ['Echo'] });
    if (staticOnly.isError === true) throw new Error('expected a runnable execution');
    expect(await staticOnly.execute(ctx)).toEqual({
      output:
        '"Echo" is already available — call it directly; ' +
        'select_tools is only for names in the <tools_added> announcements.',
    });
  });

  it('renders did-you-mean candidates in the select_tools output', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };
    const casingMiss = selectTools.resolveExecution({ names: ['MCP__SRV__ALPHA'] });
    if (casingMiss.isError === true) throw new Error('expected a runnable execution');
    expect(await casingMiss.execute(ctx)).toEqual({
      output: `Unknown tool: MCP__SRV__ALPHA. ${UNKNOWN_SELECTION_REASON}Did you mean: ${MCP_ALPHA}? Use an exact listed name.`,
      isError: true,
    });
  });

  it.each([
    {
      kind: 'policyDenied',
      reason: `"${MCP_GONE}" is disabled by the current tool policy. select_tools cannot enable it. ` +
        'Do not retry unless the policy changes; use an available tool instead.',
    },
    {
      kind: 'staleLoaded',
      reason: `"${MCP_GONE}" was previously selected or loaded but is no longer registered. ` +
        'select_tools cannot restore it. Do not select it again unless a new <tools_added> announcement lists it.',
    },
    {
      kind: 'unknown',
      reason: `Unknown tool: ${MCP_GONE}. ${UNKNOWN_SELECTION_REASON}` +
        'No additional tools can be loaded right now; use the tools you already have.' + NO_ALIAS_GUIDANCE,
    },
  ] as const)('classifies $kind and preserves its reason on repeated failure', async ({ kind, reason }) => {
    const h = createHarness();
    if (kind === 'policyDenied') deniedToolNames = new Set([MCP_GONE]);
    if (kind === 'staleLoaded') {
      const registration = registerMcp(h, new StubMcpTool(MCP_GONE));
      h.contextMemory.messages.push(schemaMessage(MCP_GONE));
      registration.dispose();
    }
    expect(h.sut.load([MCP_GONE])).toEqual({
      toLoad: [],
      alreadyAvailable: [],
      alreadyCallable: [],
      staleLoaded: kind === 'staleLoaded' ? [MCP_GONE] : [],
      policyDenied: kind === 'policyDenied' ? [MCP_GONE] : [],
      unknown: kind === 'unknown' ? [MCP_GONE] : [],
      escalated: {},
      consecutiveFailures: 1,
      suggestions: {},
      loadable: [],
      schemas: [],
    });
    const tool = h.ix.createInstance(SelectToolsTool);
    const execution = tool.resolveExecution({ names: [MCP_GONE] });
    if (execution.isError === true) throw new Error('expected a runnable execution');
    expect(await execution.execute({ turnId: 1, toolCallId: 'call', signal: new AbortController().signal })).toEqual({
      output: `${reason}\n"${MCP_GONE}" has already failed selection 2 times. ` +
        'Stop retrying this name until its availability changes.',
      isError: true,
    });
  });

  it('treats an unregistered MCP name matching the denylist as not available', () => {
    const h = createHarness();
    deniedToolNames = new Set(['mcp__github__get_issue']);

    const result = h.sut.load(['mcp__github__get_issue']);
    expect(result.policyDenied).toEqual(['mcp__github__get_issue']);
    expect(result.unknown).toEqual([]);
  });

  it('classifies a policy-filtered builtin as not available in this session', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool('UpdateGoal'));
    activeToolNames = new Set(['Read']);

    const result = h.sut.load(['UpdateGoal']);
    expect(result.policyDenied).toEqual(['UpdateGoal']);
    expect(result.unknown).toEqual([]);
  });

  it('does not suggest a disconnected loaded name as a did-you-mean candidate', () => {
    const h = createHarness();
    const registration = registerMcp(h, new StubMcpTool(MCP_ALPHA));
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    registration.dispose();

    const result = h.sut.load(['mcp__srv__alph']);
    expect(result.unknown).toEqual(['mcp__srv__alph']);
    expect(result.suggestions).toEqual({});
    expect(result.loadable).toEqual([]);
  });

  it('counts case variants once per call and escalates every variant on the second call', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };

    const variants = selectTools.resolveExecution({
      names: ['mcp__Ghost__tool', 'mcp__ghost__tool'],
    });
    if (variants.isError === true) throw new Error('expected a runnable execution');
    const result = await variants.execute(ctx);
    expect(result.output).not.toContain('has already failed selection 2 times');
    expect(result.output).toContain(`Unknown tool: mcp__Ghost__tool. ${UNKNOWN_SELECTION_REASON}Loadable tools: ${MCP_ALPHA}.${NO_ALIAS_GUIDANCE}`);
    expect(result.output).toContain(`Unknown tool: mcp__ghost__tool. ${UNKNOWN_SELECTION_REASON}Loadable tools: ${MCP_ALPHA}.${NO_ALIAS_GUIDANCE}`);
    const second = h.sut.load(['mcp__Ghost__tool', 'mcp__ghost__tool']);
    expect(second.consecutiveFailures).toBe(2);
    expect(second.escalated).toEqual({ mcp__Ghost__tool: 2, mcp__ghost__tool: 2 });
  });
});

describe('AgentToolSelectService consecutive failures', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('counts failed calls across different names and turns, not names within a batch', () => {
    const h = createHarness();
    expect(h.sut.load(['Automation', 'automations', 'AutomationList']).consecutiveFailures).toBe(1);
    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 99, origin: { kind: 'user' } }));
    expect(h.sut.load(['mcp__example__automation']).consecutiveFailures).toBe(2);
    expect(h.sut.load(['another_name']).consecutiveFailures).toBe(3);
  });

  it('appends one cross-name warning after three failures without replacing the reasons', async () => {
    const h = createHarness();
    h.contextMemory.messages.push(schemaMessage(MCP_GONE));
    deniedToolNames = new Set(['DisabledTool']);
    h.sut.load(['first_guess']);
    h.sut.load(['second_guess']);
    const tool = h.ix.createInstance(SelectToolsTool);
    const execution = tool.resolveExecution({ names: ['DisabledTool', MCP_GONE, 'third_guess'] });
    if (execution.isError === true) throw new Error('expected a runnable execution');
    const result = await execution.execute({ turnId: 1, toolCallId: 'call', signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('disabled by the current tool policy');
    expect(result.output).toContain('no longer registered');
    expect(result.output).toContain('Unknown tool: third_guess.');
    if (typeof result.output !== 'string') throw new Error('expected text output');
    expect(result.output.match(/3 consecutive select_tools calls/g)).toHaveLength(1);
    expect(result.output).toContain('Stop guessing names or retrying unavailable tools.');
    expect(result.output).not.toContain('has already failed selection');
  });

  it.each(['new', 'loaded', 'static', 'mixed'] as const)('resets the call streak but preserves unrelated failures on %s success', (kind) => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerBuiltin(h, new EchoTool());
    if (kind === 'loaded') h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    h.sut.load([MCP_GONE]);
    expect(h.sut.load([MCP_GONE]).escalated[MCP_GONE]).toBe(2);
    const names = kind === 'static' ? ['Echo'] : kind === 'mixed' ? [MCP_ALPHA, MCP_GONE] : [MCP_ALPHA];
    const success = h.sut.load(names);
    expect(success.consecutiveFailures).toBe(0);
    expect(success.escalated).toEqual(kind === 'mixed' ? { [MCP_GONE]: 3 } : {});
    const next = h.sut.load([MCP_GONE]);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.escalated).toEqual({ [MCP_GONE]: kind === 'mixed' ? 4 : 3 });
  });

  it('clears only the successful name from case-insensitive failure history', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    h.sut.load(['echo', MCP_GONE]);
    expect(h.sut.load(['echo']).escalated).toEqual({ echo: 2 });
    h.sut.load(['Echo']);
    const next = h.sut.load(['echo', MCP_GONE]);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.escalated).toEqual({ [MCP_GONE]: 2 });
  });

  it.each(['add', 'remove', 'policy', 'disclosure'] as const)('resets counters for active registration changes: %s', (change) => {
    const h = createHarness();
    const registration = registerMcp(h, new StubMcpTool(MCP_ALPHA));
    h.sut.load([MCP_GONE]);
    h.sut.load([MCP_GONE]);
    if (change === 'add') registerMcp(h, new StubMcpTool(MCP_BETA));
    if (change === 'remove') registration.dispose();
    if (change === 'policy') deniedToolNames = new Set(['UnregisteredTool']);
    if (change === 'disclosure') registerMcp(h, new StubMcpTool(MCP_ALPHA), 'inline');
    const next = h.sut.load([MCP_GONE]);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.escalated).toEqual({});
  });

  it('observes changes at announcement boundaries even if tools later revert', async () => {
    const h = createHarness();
    h.sut.load([MCP_GONE]);
    h.sut.load([MCP_GONE]);
    const registration = registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await h.sut.prepareForRequest();
    h.sut.loadableToolsAnnouncement();
    registration.dispose();
    expect(h.sut.load([MCP_GONE]).consecutiveFailures).toBe(1);
  });

  it('does not reset for registry ordering, repeated announcements or compaction', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    h.sut.load([MCP_GONE]);
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    h.sut.loadableToolsAnnouncement();
    h.contextMemory.replaceHistory([], 'clear');
    h.sut.loadableToolsAnnouncement();
    const next = h.sut.load([MCP_GONE]);
    expect(next.consecutiveFailures).toBe(2);
    expect(next.escalated[MCP_GONE]).toBe(2);
  });

  it('does not share failure counters between agents', () => {
    const first = createHarness();
    const second = createHarness();
    first.sut.load([MCP_GONE]);
    first.sut.load([MCP_GONE]);
    expect(second.sut.load([MCP_GONE]).consecutiveFailures).toBe(1);
  });

  it('prioritizes a policy denial over a missing historical registration', () => {
    const h = createHarness();
    h.contextMemory.messages.push(schemaMessage(MCP_GONE));
    deniedToolNames = new Set([MCP_GONE]);
    const result = h.sut.load([MCP_GONE]);
    expect(result.policyDenied).toEqual([MCP_GONE]);
    expect(result.staleLoaded).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it('allows recovered tools after repeated failures', () => {
    const h = createHarness();
    h.sut.load([MCP_GONE]);
    h.sut.load([MCP_GONE]);
    h.sut.load([MCP_GONE]);
    registerMcp(h, new StubMcpTool(MCP_GONE));
    const result = h.sut.load([MCP_GONE]);
    expect(result.toLoad).toEqual([MCP_GONE]);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.escalated).toEqual({});
  });
});

describe('AgentToolSelectService executor disclosure independence', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('the executor runs a deferred tool without requiring selection', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBeUndefined();
    expect(results[0]!.result.output).toBe('mcp ok');
    expect(alpha.calls).toBe(1);
  });

  it('the executor validates args for a deferred tool before selection', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA, 'mcp ok', REQUIRED_PAYLOAD_PARAMETERS);
    registerMcp(h, alpha);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA, { unexpected: true }));
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual(expect.objectContaining({
      isError: true,
    }));
    expect(results[0]!.result.output).toContain(`Invalid args for tool "${MCP_ALPHA}"`);
    expect(results[0]!.result.output).toContain("must have required property 'payload'");
    expect(alpha.calls).toBe(0);
  });

  it('the executor runs the tool once its schema is loaded', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe('mcp ok');
    expect(alpha.calls).toBe(1);
  });

  it('the executor rejects a loaded MCP tool when the profile disables it', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.messages.push(schemaMessage(MCP_ALPHA));
    activeToolNames = new Set([]);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));

    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual(expect.objectContaining({
      output:
        `Tool "${MCP_ALPHA}" was loaded but is no longer active. Ask the user to enable it before calling it again.`,
      isError: true,
    }));
    expect(alpha.calls).toBe(0);
  });

  it('the executor runs non-MCP tools without loading', async () => {
    const h = createExecutorHarness();
    const echo = new EchoTool();
    registerBuiltin(h, echo);

    const results = await execute(h, toolCall('call-1', 'Echo'));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe('echo ok');
    expect(echo.calls).toBe(1);
  });

  it('runs a deferred user tool both before and after selection', async () => {
    const h = createExecutorHarness();
    const dashboard = new EchoTool(USER_DEFERRED);
    registerUser(h, dashboard, 'deferred');

    const beforeLoad = await execute(h, toolCall('call-1', USER_DEFERRED));
    expect(beforeLoad[0]!.result.output).toBe('echo ok');
    expect(dashboard.calls).toBe(1);

    h.contextMemory.messages.push(schemaMessage(USER_DEFERRED));
    const afterLoad = await execute(h, toolCall('call-2', USER_DEFERRED));
    expect(afterLoad[0]!.result.output).toBe('echo ok');
    expect(dashboard.calls).toBe(2);
  });
});

describe('AgentToolSelectService missing tool wording', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('tells a loaded-but-disconnected MCP tool apart from an unknown name', async () => {
    const h = createExecutorHarness();
    h.contextMemory.messages.push(schemaMessage(MCP_GONE));

    const results = await execute(h, toolCall('call-1', MCP_GONE));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toBe(
      `Tool "${MCP_GONE}" was loaded but its MCP server is currently disconnected. ` +
        'It may become available again when the server reconnects; do not retry immediately.',
    );
  });

  it('keeps the default message for a name that was never loaded', async () => {
    const h = createExecutorHarness();
    const results = await execute(h, toolCall('call-1', MCP_GONE));
    expect(results[0]!.result.output).toBe(`Tool "${MCP_GONE}" not found`);
  });

  it('reports a loaded user tool that is no longer registered', async () => {
    const h = createExecutorHarness();
    const registration = registerUser(h, new EchoTool(USER_DEFERRED), 'deferred');
    h.contextMemory.messages.push(schemaMessage(USER_DEFERRED));
    registration.dispose();

    const results = await execute(h, toolCall('call-1', USER_DEFERRED));

    expect(results[0]!.result.output).toBe(
      `Tool "${USER_DEFERRED}" was loaded but is no longer registered. ` +
        'Do not retry it unless it becomes available again.',
    );
  });
});

describe('AgentToolSelectService loadable-tools announcements', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('tells the model not to select tools without an added announcement', () => {
    const h = createHarness();
    const tool = h.ix.createInstance(SelectToolsTool);
    expect(tool.description).toContain(
      'If you have not seen a <tools_added> announcement in this session, ' +
        'no tools are currently loadable — do not call select_tools.',
    );
  });

  it('announces an initially empty set once, including across turns', async () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    const first = await announce(h);
    expect(first).toContain('No tools are currently available for dynamic loading in this session.');
    expect(first).toContain('use the tools you already have');
    expect(await announce(h, 2)).toBeUndefined();

    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 99, origin: { kind: 'user' } }));
    expect(await announce(h)).toBeUndefined();
  });

  it.each([false, true])('announces emptiness once after legacy removal, with earlier empty announcement: %s', async (earlierEmpty) => {
    const h = createHarness();
    if (earlierEmpty) await announce(h);
    for (const tag of ['tools_added', 'tools_removed']) {
      h.contextMemory.messages.push({
        role: 'user',
        content: [{ type: 'text', text: `<${tag}>\n${MCP_ALPHA}\n</${tag}>` }],
          origin: { kind: 'system_trigger', name: LOADABLE_TOOLS_VARIANT },
      });
    }
    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 99, origin: { kind: 'user' } }));
    expect(await announce(h)).toContain('No tools are currently available for dynamic loading in this session.');
    expect(await announce(h, 2)).toBeUndefined();
  });

  it('announces additions after an empty set and emptiness after the last removal', async () => {
    const h = createHarness();
    await announce(h);

    const registration = registerMcp(h, new StubMcpTool(MCP_ALPHA));
    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 99, origin: { kind: 'user' } }));
    const added = await announce(h);
    expect(added).toContain(`<tools_added>\n${MCP_ALPHA}\n</tools_added>`);
    expect(added).not.toContain('No tools are currently available');

    registration.dispose();
    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 100, origin: { kind: 'user' } }));
    const removed = await announce(h);
    expect(removed).toContain(`<tools_removed>\n${MCP_ALPHA}\n</tools_removed>`);
    expect(removed).toContain('No tools are currently available for dynamic loading in this session.');

    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 101, origin: { kind: 'user' } }));
    expect(await announce(h)).toBeUndefined();
  });

  it('does not call a partial removal an empty set', async () => {
    const h = createHarness();
    const alpha = registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    await announce(h);

    alpha.dispose();
    h.eventBus.publish(new TurnStarted({ agentId: 'main', turnId: 99, origin: { kind: 'user' } }));
    const removed = await announce(h);
    expect(removed).toContain(`<tools_removed>\n${MCP_ALPHA}\n</tools_removed>`);
    expect(removed).not.toContain('No tools are currently available');
  });

  it('announces an empty set when policy excludes every deferred tool', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    activeToolNames = new Set();
    const first = await announce(h);
    expect(first).toContain('No tools are currently available for dynamic loading in this session.');
    expect(first).not.toContain(MCP_ALPHA);
  });

  it('re-announces an empty set after compaction removes its announcement', async () => {
    const h = createHarness();
    await announce(h);
    h.contextMemory.replaceHistory([], 'clear');
    expect(await announceAfterCompaction(h)).toContain(
      'No tools are currently available for dynamic loading in this session.',
    );
  });

  it('produces announcements independently of model capabilities for resolver filtering', async () => {
    capabilities = makeCapabilities({ tool_use: true });
    const h = createHarness();
    expect(await announce(h)).toContain('No tools are currently available for dynamic loading in this session.');
  });

  it('announces the full loadable set on first run, then stays silent while unchanged', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_BETA));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    const first = await announce(h);
    expect(first).toContain(`<tools_added>\n${MCP_ALPHA}\n${MCP_BETA}\n</tools_added>`);
    expect(first).not.toContain('<tools_removed>');

    expect(await announce(h, 2)).toBeUndefined();
  });

  it('announces registry diffs before the next step in the same turn', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await announce(h);

    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    const diff = await announce(h, 2);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
    expect(await announce(h, 3)).toBeUndefined();
  });

  it.each([false, true])('skips inline-only update announcements without blocking later changes (deferred tools: %s)', async (withDeferred) => {
    const h = createHarness();
    const original = h.registry.register(new EchoTool(), { source: 'builtin' });
    disposables.add(original);
    if (withDeferred) registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await announce(h);
    original.dispose();
    registerBuiltin(h, new EchoTool('Echo', 'Updated description.'));
    expect(await announce(h, 2)).toBeUndefined();
    const before = h.contextMemory.history().length;
    const updateReminders = () => h.contextMemory.history().filter(
      (message) => message.origin?.kind === 'injection' && message.origin.variant === 'tool_update_pending',
    );
    expect(updateReminders()).toHaveLength(1);
    expect(h.contextMemory.history()).toHaveLength(before);

    const added = registerMcp(h, new StubMcpTool(MCP_BETA));
    expect(await announce(h, 3)).toContain(`<tools_added>\n${MCP_BETA}\n</tools_added>`);
    added.dispose();
    expect(await announce(h, 4)).toContain(`<tools_removed>\n${MCP_BETA}\n</tools_removed>`);
    expect(await announce(h, 5)).toBeUndefined();
    expect(updateReminders()).toHaveLength(1);
  });

  it('checks policy changes after a skipped inline-only update', async () => {
    const h = createHarness();
    const original = h.registry.register(new EchoTool(), { source: 'builtin' });
    disposables.add(original);
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await announce(h);
    original.dispose();
    registerBuiltin(h, new EchoTool('Echo', 'Updated description.'));
    expect(await announce(h, 2)).toBeUndefined();
    activeToolNames = new Set(['Echo']);
    expect(await announce(h, 3)).toContain(`<tools_removed>\n${MCP_ALPHA}\n</tools_removed>`);
    expect(await announce(h, 4)).toBeUndefined();
  });

  it('diffs registry additions and removals against the folded announcements', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const betaRegistration = h.registry.register(new StubMcpTool(MCP_BETA), {
      source: 'mcp',
      disclosure: 'deferred',
    });
    disposables.add(betaRegistration);

    await announce(h);

    betaRegistration.dispose();
    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    const diff = await announce(h, 2);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
    expect(diff).toContain(`<tools_removed>\n${MCP_BETA}\n</tools_removed>`);
    expect(await announce(h, 3)).toBeUndefined();
  });

  it('announces policy changes before the next step without exposing denied tools', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    activeToolNames = new Set([MCP_ALPHA]);
    deniedToolNames = new Set([MCP_BETA]);
    expect(await announce(h)).toContain(`<tools_added>\n${MCP_ALPHA}\n</tools_added>`);

    activeToolNames = new Set([MCP_BETA]);
    deniedToolNames = new Set([MCP_ALPHA]);
    const diff = await announce(h, 2);
    expect(diff).toContain(`<tools_added>\n${MCP_BETA}\n</tools_added>`);
    expect(diff).toContain(`<tools_removed>\n${MCP_ALPHA}\n</tools_removed>`);
    expect(h.sut.load([MCP_ALPHA])).toMatchObject({ policyDenied: [MCP_ALPHA] });
    expect(await announce(h, 3)).toBeUndefined();
  });

  it('re-announces the full set after compaction discards the history', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));

    await announce(h);
    expect(await announce(h, 2)).toBeUndefined();

    h.contextMemory.replaceHistory([], 'clear');
    const reannounced = await announceAfterCompaction(h);
    expect(reannounced).toContain(`<tools_added>\n${MCP_ALPHA}\n${MCP_BETA}\n</tools_added>`);
  });

  it('announces only profile-active tools', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    activeToolNames = new Set([MCP_BETA]);

    const first = await announce(h);
    expect(first).toContain(`<tools_added>\n${MCP_BETA}\n</tools_added>`);
    expect(first).not.toContain(MCP_ALPHA);
  });

  it('stays silent while the gate is closed', async () => {
    flagEnabled = false;
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    expect(await announce(h)).toBeUndefined();
  });
});
