/**
 * Scenario: progressive tool disclosure shapes the provider-visible tool view,
 * dynamic history, selection results, executor interception, and announcements.
 *
 * Responsibilities: assert the gate contract, profile-active filtering,
 * loadable/loaded MCP settlement, and the select_tools built-in behavior.
 * Wiring: real toolSelect, registry, announcement sidecar, system reminder,
 * and hook slots with fake loop/context memory/profile/flag/event services;
 * executor tests use the real executor with telemetry and truncation stubs.
 * Run: ../../node_modules/.bin/vitest run test/toolSelect/toolSelectService.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { createServices, type ServiceRegistration, type TestInstantiationService } from '#/_base/di/test';
import { OrderedHookSlot } from '#/hooks';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { ToolCall } from '#/app/llmProtocol/message';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { UndoCut } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type EnqueueReceipt,
  type LoopRunResult,
  type StepEnqueueOptions,
  type Turn,
} from '#/agent/loop/loop';
import type { StepRequest } from '#/agent/loop/stepRequest';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { IAgentToolExecutorService, type ToolExecutionResult } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { DYNAMIC_TOOL_SCHEMA_VARIANT, LOADABLE_TOOLS_TRIGGER } from '#/agent/toolSelect/dynamicTools';
import { TOOL_SELECT_FLAG_ID } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { AgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncementsService';
import { AgentToolSelectService } from '#/agent/toolSelect/toolSelectService';
import { SelectToolsTool } from '#/agent/toolSelect/tools/select-tools';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { registerLogServices } from '../../_base/log/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';
import { stubToolExecutor } from '../loop/stubs';
import { registerToolResultTruncationServices } from '../toolResultTruncation/stubs';

const MCP_ALPHA = 'mcp__srv__alpha';
const MCP_BETA = 'mcp__srv__beta';
const MCP_GAMMA = 'mcp__srv__gamma';
const MCP_GONE = 'mcp__srv__gone';
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

beforeEach(() => {
  disposables = new DisposableStore();
  capabilities = makeCapabilities({ tool_use: true, select_tools: true });
  flagEnabled = false;
  activeToolNames = undefined;
});

afterEach(() => disposables.dispose());

function makeCapabilities(overrides: {
  readonly tool_use?: boolean;
  readonly select_tools?: boolean;
} = {}): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: overrides.tool_use ?? false,
    max_context_tokens: 128_000,
    select_tools: overrides.select_tools,
  };
}

function toolCall(id: string, name: string, args: unknown = {}): ToolCall {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function schemaMessage(...names: string[]): ContextMessage {
  return {
    role: 'system',
    content: [],
    toolCalls: [],
    tools: names.map((name) => ({ name, description: `${name} desc`, parameters: {} })),
    origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
  };
}

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  readonly description: string;
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
  readonly description = 'Echo input text.';
  readonly parameters: Record<string, unknown> = { type: 'object', additionalProperties: true };
  calls = 0;

  constructor(readonly name = 'Echo') {}

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
  private readonly typedHandlers = new Map<string, Array<(event: DomainEvent) => void>>();
  private readonly allHandlers: Array<(event: DomainEvent) => void> = [];
  readonly published: DomainEvent[] = [];

  publish(event: DomainEvent): void {
    this.published.push(event);
    for (const handler of this.allHandlers) handler(event);
    for (const handler of this.typedHandlers.get(event.type) ?? []) handler(event);
  }

  subscribe(
    typeOrHandler: string | ((event: DomainEvent) => void),
    maybeHandler?: (event: DomainEvent) => void,
  ) {
    if (typeof typeOrHandler === 'function') {
      this.allHandlers.push(typeOrHandler);
      return toDisposable(() => {
        const index = this.allHandlers.indexOf(typeOrHandler);
        if (index >= 0) this.allHandlers.splice(index, 1);
      });
    }
    const list = this.typedHandlers.get(typeOrHandler) ?? [];
    const handler = maybeHandler!;
    list.push(handler);
    this.typedHandlers.set(typeOrHandler, list);
    return toDisposable(() => {
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    });
  }

  emit(type: string, payload: Record<string, unknown> = {}): void {
    this.publish({ type, ...payload } as DomainEvent);
  }
}

class FakeLoopService implements IAgentLoopService {
  readonly _serviceBrand = undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot<BeforeStepContext>(),
    onDidFinishStep: new OrderedHookSlot<AfterStepContext>(),
  };

  enqueue(_request: StepRequest, _options?: StepEnqueueOptions): EnqueueReceipt {
    throw new Error('unused in this suite');
  }

  async run(): Promise<LoopRunResult> {
    throw new Error('unused in this suite');
  }

  status() {
    return { state: 'idle' as const, pendingTurnIds: [], hasPendingRequests: false };
  }

  cancel(_turnId?: number, _reason?: unknown): boolean {
    throw new Error('unused in this suite');
  }

  hasPendingRequests(): boolean {
    return false;
  }

  registerLoopErrorHandler(): IDisposable {
    throw new Error('unused in this suite');
  }
}

class FakeContextMemory implements IAgentContextMemoryService {
  readonly _serviceBrand = undefined;
  readonly history: ContextMessage[] = [];
  readonly appended: ContextMessage[] = [];

  get(): readonly ContextMessage[] {
    return this.history;
  }

  append(...messages: readonly ContextMessage[]): void {
    this.appended.push(...messages);
  }

  appendLoopEvent(_event: LoopRecordedEvent): void {
    throw new Error('unused in this suite');
  }

  clear(): void {
    this.history.length = 0;
    this.appended.length = 0;
  }

  undo(): UndoCut {
    throw new Error('unused in this suite');
  }

  applyCompaction(): never {
    throw new Error('unused in this suite');
  }

  landAppended(): void {
    this.history.push(...this.appended);
    this.appended.length = 0;
  }

  landAnnouncement(content: string): void {
    this.history.push({
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>\n${content.trim()}\n</system-reminder>` }],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: LOADABLE_TOOLS_TRIGGER },
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
  reg.defineInstance(IEventBus, eventBus);
  reg.defineInstance(IAgentLoopService, loop);
  reg.defineInstance(IAgentContextMemoryService, contextMemory);
  reg.definePartialInstance(IAgentProfileService, {
    getModelCapabilities: () => capabilities,
    isToolActive: (name: string) => activeToolNames === undefined || activeToolNames.has(name),
  });
  reg.definePartialInstance(IFlagService, {
    enabled: (id: string) => (id === TOOL_SELECT_FLAG_ID ? flagEnabled : false),
  });
  reg.define(IAgentToolRegistryService, AgentToolRegistryService);
  reg.define(IAgentToolSelectService, AgentToolSelectService);
  reg.define(IAgentToolSelectAnnouncementsService, AgentToolSelectAnnouncementsService);
  reg.define(IAgentSystemReminderService, AgentSystemReminderService);
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
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
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

function registerMcp(h: Harness, tool: StubMcpTool): void {
  disposables.add(h.registry.register(tool, { source: 'mcp' }));
}

function registerBuiltin(h: Harness, tool: EchoTool): void {
  disposables.add(h.registry.register(tool, { source: 'builtin' }));
}

async function announce(h: Harness, step = 1): Promise<string | undefined> {
  const before = h.contextMemory.appended.length;
  await h.loop.hooks.onWillBeginStep.run({
    turnId: 1,
    step,
    signal: new AbortController().signal,
  });
  const announcement = h.contextMemory.appended
    .slice(before)
    .find(
      (message) =>
        message.origin?.kind === 'system_trigger' &&
        message.origin.name === LOADABLE_TOOLS_TRIGGER,
    );
  h.contextMemory.landAppended();
  if (announcement === undefined) return undefined;
  return announcement.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

async function execute(
  h: ExecutorHarness,
  call: ToolCall,
): Promise<readonly ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for await (const result of h.executor.execute([call], {
    signal: new AbortController().signal,
    turnId: 1,
  })) {
    results.push(result);
  }
  return results;
}

describe('AgentToolSelectService gate', () => {
  it('opens only when select_tools capability, tool_use capability and flag are all on', () => {
    flagEnabled = true;
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(true);
  });

  it('stays closed without the select_tools capability', () => {
    flagEnabled = true;
    capabilities = makeCapabilities({ tool_use: true, select_tools: false });
    const { sut } = createHarness();
    expect(sut.enabled()).toBe(false);
  });

  it('stays closed without tool_use capability', () => {
    flagEnabled = true;
    capabilities = makeCapabilities({ tool_use: false, select_tools: true });
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
  it('shapeTools returns the identical array when select_tools is absent', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const entries = h.registry.list();
    expect(h.sut.shapeTools(entries)).toBe(entries);
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

  it('select_tools execution self-guards while the gate is closed', async () => {
    const h = createHarness();
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const execution = selectTools.resolveExecution({ names: [MCP_ALPHA] });
    expect(execution.isError).toBeUndefined();
    if (execution.isError === true) throw new Error('expected a runnable execution');
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'call-1',
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      output: 'select_tools is not available for the current model.',
      isError: true,
    });
  });

  it('shapeHistory strips dynamic-tool protocol context without touching the canonical history', () => {
    const h = createHarness();
    h.contextMemory.landAnnouncement('<tools_added>\nt\n</tools_added>');
    h.contextMemory.history.push(schemaMessage('t'), userMessage('keep'));
    const shaped = h.sut.shapeHistory(h.contextMemory.get());
    expect(shaped.map((message) => message.role)).toEqual(['user']);
    expect(h.contextMemory.get()).toHaveLength(3);
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

  it('hides unloaded MCP tools, marks loaded MCP tools deferred, keeps builtins and select_tools', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual(['Echo', MCP_ALPHA, SELECT_TOOLS_TOOL_NAME]);
    const byName = new Map(shaped.map((entry) => [entry.name, entry]));
    expect(byName.get(MCP_ALPHA)?.deferred).toBe(true);
    expect(byName.get('Echo')?.deferred).toBeUndefined();
    expect(byName.get(SELECT_TOOLS_TOOL_NAME)?.deferred).toBeUndefined();
  });

  it('keeps select_tools visible when the profile omits it while hiding inactive tools', () => {
    const h = createHarness();
    registerBuiltin(h, new EchoTool());
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    disposables.add(h.registry.register(selectTools, { source: 'builtin' }));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));
    activeToolNames = new Set([MCP_ALPHA]);

    const shaped = h.sut.shapeTools(h.registry.list());
    expect(shaped.map((entry) => entry.name)).toEqual([
      MCP_ALPHA,
      SELECT_TOOLS_TOOL_NAME,
    ]);
  });

  it('shapeHistory returns the identical array', () => {
    const h = createHarness();
    h.contextMemory.history.push(userMessage('a'), schemaMessage(MCP_ALPHA));
    const messages = h.contextMemory.get();
    expect(h.sut.shapeHistory(messages)).toBe(messages);
  });

  it('shapeHistory removes loaded schemas when the profile disables them', () => {
    const h = createHarness();
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA, MCP_BETA), userMessage('keep'));
    activeToolNames = new Set([MCP_BETA]);

    const shaped = h.sut.shapeHistory(h.contextMemory.get());

    expect(shaped).toHaveLength(2);
    expect(shaped[0]!.tools?.map((tool) => tool.name)).toEqual([MCP_BETA]);
    expect(h.contextMemory.get()[0]!.tools?.map((tool) => tool.name)).toEqual([
      MCP_ALPHA,
      MCP_BETA,
    ]);
  });
});

describe('AgentToolSelectService.load', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('settles per name: toLoad, alreadyAvailable, unknown', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));

    const result = h.sut.load([MCP_BETA, MCP_ALPHA, MCP_GONE]);
    expect(result.toLoad).toEqual([MCP_BETA]);
    expect(result.alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(result.unknown).toEqual([MCP_GONE]);

    expect(h.contextMemory.appended).toHaveLength(1);
    const appended = h.contextMemory.appended[0]!;
    expect(appended.role).toBe('system');
    expect(appended.tools?.map((tool) => tool.name)).toEqual([MCP_BETA]);
    expect(appended.origin).toEqual({ kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT });
  });

  it('sorts the injected schemas by name', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_BETA));
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_BETA, MCP_ALPHA]);
    expect(h.contextMemory.appended[0]!.tools?.map((tool) => tool.name)).toEqual([
      MCP_ALPHA,
      MCP_BETA,
    ]);
  });

  it('reports names filtered out by the profile as unknown', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    activeToolNames = new Set([MCP_ALPHA]);

    const result = h.sut.load([MCP_ALPHA, MCP_BETA]);
    expect(result.toLoad).toEqual([MCP_ALPHA]);
    expect(result.unknown).toEqual([MCP_BETA]);
  });

  it('pending ledger leads the history inside the defer window', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    expect(h.contextMemory.get().some((message) => message.tools !== undefined)).toBe(false);
    const reselect = h.sut.load([MCP_ALPHA]);
    expect(reselect.alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(reselect.toLoad).toEqual([]);

    h.contextMemory.landAppended();
    const afterLanding = h.sut.load([MCP_ALPHA]);
    expect(afterLanding.alreadyAvailable).toEqual([MCP_ALPHA]);
  });

  it('clears the pending ledger after compaction completes', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    h.contextMemory.appended.length = 0;
    h.eventBus.emit('compaction.completed');
    expect(h.sut.load([MCP_ALPHA]).toLoad).toEqual([MCP_ALPHA]);
  });

  it('clears the pending ledger after a full-prefix context splice', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    h.contextMemory.appended.length = 0;
    h.eventBus.emit('context.spliced', { start: 0, deleteCount: 2, messages: [] });
    expect(h.sut.load([MCP_ALPHA]).toLoad).toEqual([MCP_ALPHA]);
  });

  it('reconciles the pending ledger with history when a mid-history splice removes schema messages', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));

    h.sut.load([MCP_ALPHA]);
    h.contextMemory.landAppended();
    h.sut.load([MCP_BETA]);
    h.contextMemory.landAppended();
    expect(h.sut.load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(h.sut.load([MCP_BETA]).alreadyAvailable).toEqual([MCP_BETA]);

    h.contextMemory.history.splice(1, 1);
    h.eventBus.emit('context.spliced', { start: 1, deleteCount: 2, messages: [] });

    expect(h.sut.load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);
    expect(h.sut.load([MCP_BETA]).toLoad).toEqual([MCP_BETA]);
  });

  it('keeps the pending ledger across tail appends', () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));

    h.sut.load([MCP_ALPHA]);
    h.eventBus.emit('context.spliced', { start: 3, deleteCount: 0, messages: [userMessage('x')] });
    expect(h.sut.load([MCP_ALPHA]).alreadyAvailable).toEqual([MCP_ALPHA]);
  });

  it('renders the select_tools tool output per name for mixed load results', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));
    const selectTools = h.ix.createInstance(SelectToolsTool);
    const ctx = { turnId: 1, toolCallId: 'call-1', signal: new AbortController().signal };

    const mixed = selectTools.resolveExecution({ names: [MCP_BETA, MCP_ALPHA, MCP_GONE] });
    if (mixed.isError === true) throw new Error('expected a runnable execution');
    expect(await mixed.execute(ctx)).toEqual({
      output: [
        `Loaded: ${MCP_BETA}`,
        `Already available: ${MCP_ALPHA}`,
        `Unknown tool: ${MCP_GONE}. Pick from the latest announced tools list.`,
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
      output: `Unknown tool: ${MCP_GONE}. Pick from the latest announced tools list.`,
      isError: true,
    });
  });
});

describe('AgentToolSelectService executor interception', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('the executor settles the intercepted call without running the tool', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.isError).toBe(true);
    expect(results[0]!.result.output).toContain('is available but not loaded');
    expect(alpha.calls).toBe(0);
  });

  it('the executor returns loading guidance before validating args for an unloaded MCP tool', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA, 'mcp ok', REQUIRED_PAYLOAD_PARAMETERS);
    registerMcp(h, alpha);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA, { unexpected: true }));
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({
      output:
        `Tool "${MCP_ALPHA}" is available but not loaded. ` +
        `Call select_tools with ["${MCP_ALPHA}"] first, then call the tool.`,
      isError: true,
    });
    expect(alpha.calls).toBe(0);
  });

  it('the executor runs the tool once its schema is loaded', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));
    expect(results).toHaveLength(1);
    expect(results[0]!.result.output).toBe('mcp ok');
    expect(alpha.calls).toBe(1);
  });

  it('the executor rejects a loaded MCP tool when the profile disables it', async () => {
    const h = createExecutorHarness();
    const alpha = new StubMcpTool(MCP_ALPHA);
    registerMcp(h, alpha);
    h.contextMemory.history.push(schemaMessage(MCP_ALPHA));
    activeToolNames = new Set([]);

    const results = await execute(h, toolCall('call-1', MCP_ALPHA));

    expect(results).toHaveLength(1);
    expect(results[0]!.result).toEqual({
      output:
        `Tool "${MCP_ALPHA}" was loaded but is no longer active. Ask the user to enable it before calling it again.`,
      isError: true,
    });
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
});

describe('AgentToolSelectService missing tool wording', () => {
  beforeEach(() => {
    flagEnabled = true;
  });

  it('tells a loaded-but-disconnected MCP tool apart from an unknown name', async () => {
    const h = createExecutorHarness();
    h.contextMemory.history.push(schemaMessage(MCP_GONE));

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
});

describe('AgentToolSelectService loadable-tools announcements', () => {
  beforeEach(() => {
    flagEnabled = true;
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

  it('waits until the next boundary before announcing registry diffs', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    await announce(h);

    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    expect(await announce(h, 2)).toBeUndefined();

    h.eventBus.emit('turn.started');
    const diff = await announce(h);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
  });

  it('diffs registry additions and removals against the folded announcements', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    const betaRegistration = h.registry.register(new StubMcpTool(MCP_BETA), { source: 'mcp' });
    disposables.add(betaRegistration);

    await announce(h);

    betaRegistration.dispose();
    registerMcp(h, new StubMcpTool(MCP_GAMMA));
    h.eventBus.emit('turn.started');

    const diff = await announce(h);
    expect(diff).toContain(`<tools_added>\n${MCP_GAMMA}\n</tools_added>`);
    expect(diff).toContain(`<tools_removed>\n${MCP_BETA}\n</tools_removed>`);
  });

  it('re-announces the full set after compaction discards the history', async () => {
    const h = createHarness();
    registerMcp(h, new StubMcpTool(MCP_ALPHA));
    registerMcp(h, new StubMcpTool(MCP_BETA));

    await announce(h);
    expect(await announce(h, 2)).toBeUndefined();

    h.contextMemory.clear();
    h.eventBus.emit('compaction.completed');

    const reannounced = await announce(h, 2);
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
