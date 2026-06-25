import { EventEmitter } from 'node:events';
import { Readable, type Writable } from 'node:stream';

import { createControlledPromise } from '@antfu/utils';
import { type Environment, type Kaos, type KaosProcess } from '@moonshot-ai/kaos';
import type { ContentPart, ModelCapability, ProviderConfig } from '@moonshot-ai/kosong';
import type { generate as kosongGenerate } from '@moonshot-ai/kosong';
import { expect, onTestFinished, vi } from 'vitest';

import type { KimiConfig } from '../../../../src/config';
import {
  InstantiationService,
  ServiceCollection,
  type IDisposable,
  type ServiceIdentifier,
} from '../../../../src/di';
import type { Logger } from '../../../../src/logging';
import type { AgentAPI } from '../../../../src/rpc/core-api';
import {
  IApprovalService,
  ILogService,
  IQuestionService,
  type ApprovalResponse,
  type QuestionResult,
} from '../../../../src/services';
import {
  AgentRuntime,
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentRPCService,
  IBackgroundService,
  IContextMemory,
  IContextProjector,
  IContextSizeService,
  ICronService,
  IEventBus,
  IPermissionModeService,
  IPermissionRulesService,
  IPermissionService,
  IProfileService,
  IToolRegistry,
  IToolStoreService,
  IUsageService,
  IWireRecord,
  InMemoryWireRecordPersistence,
  createAgentRuntime,
  type AgentRuntimeOptions,
  type ContextMessage,
  type PermissionMode,
  type PermissionRule,
  type PersistedWireRecord,
  type ToolOutput,
  type ToolResult,
  type WireRecord,
  type WireRecordPersistence,
} from '../../../../src/services/agent';
import { ProviderManager } from '../../../../src/session/provider-manager';
import type { TelemetryClient } from '../../../../src/telemetry';
import type { PromisifyMethods } from '../../../../src/utils/types';
import { testKaos } from '../../../fixtures/test-kaos';
import { createFakeKaos } from '../../../tools/fixtures/fake-kaos';

import { createScriptedGenerate } from './scripted-generate';
import {
  DEFAULT_TEST_SYSTEM_PROMPT,
  eventSnapshot,
  type EventSnapshotEntry,
  type RpcSnapshotEntry,
  type WireSnapshotEntry,
} from './snapshots';

const TEST_OS_ENV: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

const RPC_RESPONSE = Symbol('rpcResponse');

type RpcPromise<T> = Promise<T> & {
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

type RpcLogEntry = RpcSnapshotEntry & {
  readonly [RPC_RESPONSE]?: RpcPromise<unknown>;
};

type PromiseAgentAPI = PromisifyMethods<AgentAPI>;
type GenerateFn = typeof kosongGenerate;

type TestToolResult = ToolResult & {
  readonly content?: unknown;
};

interface ResumeStateSnapshot {
  readonly background: ReturnType<IBackgroundService['list']>;
  readonly config: {
    readonly cwd: string;
    readonly provider: ProviderConfig | undefined;
    readonly profileName: string | undefined;
    readonly thinkingLevel: string;
    readonly systemPrompt: string;
  };
  readonly context: {
    readonly history: readonly ContextMessage[];
    readonly tokenCount: number;
  };
  readonly permission: ReturnType<IPermissionService['data']>;
  readonly tools: ReturnType<AgentTestContext['toolsData']>;
  readonly toolStore: ReturnType<IToolStoreService['data']>;
  readonly usage: ReturnType<IUsageService['data']>;
}

export interface TestAgentOptions {
  readonly kaos?: Kaos | undefined;
  readonly runtime?: AgentRuntimeOptions['toolServices'] | undefined;
  readonly toolServices?: AgentRuntimeOptions['toolServices'] | undefined;
  readonly microCompaction?: AgentRuntimeOptions['microCompaction'];
  readonly fullCompaction?: AgentRuntimeOptions['fullCompaction'];
  readonly generate?: GenerateFn | undefined;
  readonly hookEngine?: AgentRuntimeOptions['hookEngine'];
  readonly type?: AgentRuntimeOptions['type'];
  readonly permission?: AgentRuntimeOptions['permission'];
  readonly permissionMode?: PermissionMode;
  readonly permissionRules?: readonly PermissionRule[];
  readonly goal?: AgentRuntimeOptions['goal'];
  readonly pluginSessionStarts?: AgentRuntimeOptions['pluginSessionStarts'];
  readonly providerManager?: ProviderManager;
  readonly initialConfig?: KimiConfig;
  readonly providerManagerOverrides?: Omit<ConstructorParameters<typeof ProviderManager>[0], 'config'>;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly subagentHost?: AgentRuntimeOptions['subagentHost'];
  readonly onEvent?: ((event: PersistedWireRecord) => PersistedWireRecord | undefined) | undefined;
  readonly persistence?: WireRecordPersistence | undefined;
  readonly homedir?: AgentRuntimeOptions['homedir'];
  readonly telemetry?: TelemetryClient | undefined;
  readonly log?: Logger;
  readonly questionService?: IQuestionService;
  readonly experimentalFlags?: AgentRuntimeOptions['experimentalFlags'];
  readonly background?: AgentRuntimeOptions['background'];
  readonly cron?: AgentRuntimeOptions['cron'];
  readonly mcp?: AgentRuntimeOptions['mcp'];
  readonly skills?: AgentRuntimeOptions['skills'];
  readonly additionalDirs?: AgentRuntimeOptions['additionalDirs'];
  readonly userTool?: AgentRuntimeOptions['userTool'];
  readonly initializeTools?: AgentRuntimeOptions['initializeTools'];
  readonly replay?: AgentRuntimeOptions['replay'];
}

interface ConfigureOptions {
  readonly tools?: readonly string[] | undefined;
  readonly provider?: ProviderConfig | undefined;
  readonly modelCapabilities?: ModelCapability | undefined;
}

export type TestAgentContext = AgentTestContext;

export function createCommandKaos(stdout: string): Kaos {
  function createProcess(): KaosProcess {
    return {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 0,
      wait: vi.fn().mockResolvedValue(0),
      kill: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
  }

  return createFakeKaos({
    execWithEnv: vi.fn().mockImplementation(async () => createProcess()),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeText: vi.fn(async (_path: string, content: string) => content.length),
  });
}

export function testAgent(options: TestAgentOptions = {}): AgentTestContext {
  return new AgentTestContext(options);
}

export class AgentTestContext {
  private readonly options: TestAgentOptions;
  private readonly scriptedGenerate = createScriptedGenerate();
  private readonly recordHistory: PersistedWireRecord[] = [];
  private readonly root: InstantiationService;
  private readonly disposables: IDisposable[] = [];
  private suppressWireSnapshot = false;
  private lastEventCount = 0;
  private readonly uuidLabels = new Map<string, string>();
  private kimiConfig: KimiConfig;
  private cwd = process.cwd();
  private closed = false;

  readonly emitter = new EventEmitter();
  readonly allEvents: EventSnapshotEntry[] = [];
  readonly runtime: AgentRuntime;
  readonly rpc: PromiseAgentAPI;
  readonly llmCalls = this.scriptedGenerate.calls;
  readonly lastLlmInput = this.scriptedGenerate.lastInput;
  readonly llmInputs = this.scriptedGenerate.inputs;
  readonly mockNextResponse = this.scriptedGenerate.mockNextResponse;
  readonly mockNextProviderResponse = this.scriptedGenerate.mockNextProviderResponse;

  readonly profile: IProfileService;
  readonly context: IContextMemory;
  readonly contextSize: IContextSizeService;
  readonly projector: IContextProjector;
  readonly wireRecord: IWireRecord;
  readonly events: IEventBus;
  readonly rpcMethods: IAgentRPCService;
  readonly permission: IPermissionService;
  readonly permissionMode: IPermissionModeService;
  readonly permissionRules: IPermissionRulesService;
  readonly tools: IToolRegistry;
  readonly toolStore: IToolStoreService;
  readonly background: IBackgroundService;
  readonly cron: ICronService;
  readonly usage: IUsageService;

  constructor(options: TestAgentOptions = {}) {
    this.options = options;
    this.emitter.on('error', () => {});
    this.kimiConfig = options.initialConfig ?? emptyConfig();

    const kaos = options.kaos ?? testKaos;
    const toolServices = options.toolServices ?? options.runtime;
    const providerManager = options.providerManager ?? new ProviderManager({
      config: () => this.kimiConfig,
      promptCacheKey: options.sessionId,
      ...options.providerManagerOverrides,
    });
    const persistence = this.wrapPersistence(
      options.persistence ?? new InMemoryWireRecordPersistence(),
    );

    const rootServices = new ServiceCollection();
    rootServices.set(IApprovalService, this.createApprovalService());
    rootServices.set(IQuestionService, options.questionService ?? this.createQuestionService());
    rootServices.set(ILogService, createLogService(options.log));
    this.root = new InstantiationService(rootServices);

    this.runtime = createAgentRuntime(this.root, {
      sessionId: options.sessionId,
      agentId: options.agentId,
      type: options.type,
      homedir: options.homedir,
      cwd: () => this.cwd,
      chdir: async (nextCwd) => {
        this.cwd = nextCwd;
        await kaos.chdir(nextCwd);
      },
      kaos,
      config: () => this.kimiConfig,
      modelProvider: providerManager,
      generate: options.generate ?? this.scriptedGenerate.generate,
      toolServices,
      mcp: options.mcp,
      subagentHost: options.subagentHost,
      telemetry: options.telemetry,
      hookEngine: options.hookEngine,
      experimentalFlags: options.experimentalFlags,
      microCompaction: options.microCompaction,
      fullCompaction: options.fullCompaction,
      permission: options.permission,
      permissionRules: options.permissionRules,
      permissionMode: options.permissionMode,
      skills: options.skills,
      pluginSessionStarts: options.pluginSessionStarts,
      additionalDirs: options.additionalDirs,
      wireRecord: { persistence },
      replay: options.replay,
      background: options.background,
      cron:
        options.cron === undefined
          ? options.type === 'sub'
            ? { autoStart: false }
            : { autoStart: true }
          : options.cron,
      goal: options.goal,
      userTool: {
        executeUserTool:
          options.userTool?.executeUserTool ??
          ((input, callOptions) => this.requestUserTool(input, callOptions)),
      },
      initializeTools: options.initializeTools,
    });

    this.profile = this.get(IProfileService);
    this.context = this.get(IContextMemory);
    this.contextSize = this.get(IContextSizeService);
    this.projector = this.get(IContextProjector);
    this.wireRecord = this.get(IWireRecord);
    this.events = this.get(IEventBus);
    this.rpcMethods = this.get(IAgentRPCService);
    this.permission = this.get(IPermissionService);
    this.permissionMode = this.get(IPermissionModeService);
    this.permissionRules = this.get(IPermissionRulesService);
    this.tools = this.get(IToolRegistry);
    this.toolStore = this.get(IToolStoreService);
    this.background = this.get(IBackgroundService);
    this.cron = this.get(ICronService);
    this.usage = this.get(IUsageService);

    this.disposables.push(
      this.events.on((event) => {
        const { type, ...args } = event;
        this.recordRpc(type, args);
      }),
    );

    this.rpc = this.createPromiseAgentApi(this.rpcMethods);

    onTestFinished(async () => {
      await this.close();
    });
  }

  get<T>(id: ServiceIdentifier<T>): T {
    return this.runtime.get(id);
  }

  service<T>(id: ServiceIdentifier<T>): T {
    return this.get(id);
  }

  configure({
    tools = [],
    provider = MOCK_PROVIDER,
    modelCapabilities,
  }: ConfigureOptions = {}): void {
    this.configureRuntimeModel(provider, modelCapabilities);
    this.profile.update({
      cwd: process.cwd(),
      modelAlias: provider.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
    });

    if (tools.length > 0) {
      this.profile.update({ activeToolNames: [...tools] });
    }

    this.lastEventCount = this.allEvents.length;
  }

  configureRuntimeModel(
    provider: ProviderConfig,
    modelCapabilities?: ModelCapability | undefined,
  ): void {
    if (this.options.providerManager === undefined) {
      this.kimiConfig = configWithProvider(this.kimiConfig, provider, modelCapabilities);
    }
    this.profile.update({ modelAlias: provider.model });
  }

  contextData(): { readonly history: readonly ContextMessage[]; readonly tokenCount: number } {
    return {
      history: this.context.getHistory(),
      tokenCount: this.contextSize.getStatus().contextTokens,
    };
  }

  project(messages: readonly ContextMessage[] = this.context.getHistory()) {
    return this.projector.project(messages);
  }

  toolsData(): Array<ReturnType<IToolRegistry['list']>[number] & { readonly active: boolean }> {
    return this.tools.list().map((tool) => ({
      ...tool,
      active: this.profile.isToolActive(tool.name, tool.source),
    }));
  }

  toolStoreData(): ReturnType<IToolStoreService['data']> {
    return this.toolStore.data();
  }

  appendUserMessage(content: readonly ContentPart[]): void {
    this.appendMessage({
      role: 'user',
      content: [...content],
      toolCalls: [],
      origin: { kind: 'user' },
    });
  }

  appendSystemReminder(
    content: string,
    origin: ContextMessage['origin'] = { kind: 'injection', variant: 'system-reminder' },
  ): void {
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>\n${content.trim()}\n</system-reminder>` }],
      toolCalls: [],
      origin,
    });
  }

  appendLocalCommandStdout(content: string): void {
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: `<local-command-stdout>\n${content.trim()}\n</local-command-stdout>` }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'local-command-stdout' },
    });
  }

  clearContext(): void {
    void this.rpcMethods.clearContext({});
  }

  undoHistory(count: number): number {
    return this.rpcMethods.undoHistory({ count }) as unknown as number;
  }

  newEvents(): ReturnType<typeof eventSnapshot> {
    const events = this.allEvents.slice(this.lastEventCount);
    this.lastEventCount = this.allEvents.length;
    return eventSnapshot(events, this.uuidLabels);
  }

  untilTurnEnd(): Promise<ReturnType<typeof eventSnapshot>> {
    return this.takeUntilRpc('turn.ended').then(({ events }) => events);
  }

  untilApprovalRequest(): Promise<ReturnType<typeof eventSnapshot>> {
    return this.takeUntilRpc('requestApproval').then(({ events }) => events);
  }

  async takeApprovalRequest(): Promise<{
    events: ReturnType<typeof eventSnapshot>;
    respond(response: ApprovalResponse): void;
  }> {
    const { event, events } = await this.takeUntilRpc('requestApproval');
    return {
      events,
      respond: (response) => {
        this.resolveRpcRequest(event, response);
      },
    };
  }

  async untilApproval(approved: boolean): Promise<ReturnType<typeof eventSnapshot>> {
    const { event, events } = await this.takeUntilRpc('requestApproval');
    this.resolveRpcRequest(event, {
      decision: approved ? 'approved' : 'rejected',
      selectedLabel: approved ? 'approve' : 'reject',
    } satisfies ApprovalResponse);
    return events;
  }

  untilQuestionRequest(): Promise<ReturnType<typeof eventSnapshot>> {
    return this.takeUntilRpc('requestQuestion').then(({ events }) => events);
  }

  async untilQuestion(result: QuestionResult): Promise<ReturnType<typeof eventSnapshot>> {
    const { event, events } = await this.takeUntilRpc('requestQuestion');
    this.resolveRpcRequest(event, result);
    return events;
  }

  async untilToolCall(result: TestToolResult): Promise<ReturnType<typeof eventSnapshot>> {
    const { event, events } = await this.takeUntilRpc('toolCall');
    this.resolveRpcRequest(event, result);
    return events;
  }

  async dispatch(event: PersistedWireRecord): Promise<void> {
    this.suppressWireSnapshot = true;
    try {
      await this.runtime.restore([event]);
      this.captureRecord(event);
    } finally {
      this.suppressWireSnapshot = false;
    }
  }

  once(type: string): Promise<void> {
    return new Promise((resolve) => {
      this.emitter.once(type, () => {
        resolve();
      });
    });
  }

  onceAny(types: readonly string[]): Promise<string> {
    return new Promise((resolve) => {
      for (const type of types) {
        this.emitter.once(type, () => {
          resolve(type);
        });
      }
    });
  }

  appendExchange(
    _step: number,
    userText: string,
    assistantText: string,
    tokenTotal: number,
  ): void {
    this.appendUserText(userText);
    this.appendAssistantMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      toolCalls: [],
    });
    this.coverUsage(tokenTotal);
  }

  appendAssistantText(step: number, text: string): void {
    this.appendAssistantTextWithUsage(step, text);
  }

  appendAssistantTextWithUsage(step: number, text: string, tokenTotal?: number): void {
    this.appendUserText(`user before step ${String(step)}`);
    this.appendAssistantMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
    this.coverUsage(tokenTotal);
  }

  appendAssistantTurn(_step: number, text: string): void {
    this.appendAssistantMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
  }

  appendToolExchange(): void {
    this.appendUserText('lookup something');
    this.appendAssistantMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will call Lookup.' }],
      toolCalls: [toolCall('call_lookup', 'Lookup', { query: 'moon' })],
    });
    this.appendToolResult('call_lookup', 'lookup result');
  }

  appendUnresolvedToolExchange(resolvedToolResults: 0 | 1): void {
    this.appendUserText('run unresolved tools');
    this.appendAssistantMessage({
      role: 'assistant',
      content: [],
      toolCalls: [
        toolCall('call_unresolved_one', 'LookupOne', {}),
        toolCall('call_unresolved_two', 'LookupTwo', {}),
      ],
    });
    if (resolvedToolResults === 1) {
      this.appendToolResult('call_unresolved_one', 'one result');
    }
  }

  appendRichToolExchange(): void {
    this.appendMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this image' },
        { type: 'image_url', imageUrl: { url: 'ms://image-1', id: 'image-1' } },
      ],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    this.appendAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'think', think: 'checking metadata' },
        { type: 'text', text: 'I will call Lookup.' },
      ],
      toolCalls: [toolCall('call_lookup', 'Lookup', { query: 'moon', limit: 2 })],
    });
    this.coverUsage(60);
    this.appendToolResult('call_lookup', [
      { type: 'text', text: 'lookup result' },
      { type: 'video_url', videoUrl: { url: 'ms://video-1', id: 'video-1' } },
    ]);
  }

  appendContextPartiallyResolvedParallelToolExchange(): void {
    this.appendUserText('run both tools');
    this.appendAssistantMessage({
      role: 'assistant',
      content: [],
      toolCalls: [
        toolCall('call_open_one', 'LookupOne', {}),
        toolCall('call_open_two', 'LookupTwo', {}),
      ],
    });
    this.appendToolResult('call_open_one', 'one result');
  }

  appendPartiallyResolvedParallelToolExchange(): void {
    this.appendUserText('run both tools');
    this.appendAssistantMessage({
      role: 'assistant',
      content: [],
      toolCalls: [
        toolCall('call_open_one', 'LookupOne', { query: 'one' }),
        toolCall('call_open_two', 'LookupTwo', { query: 'two' }),
      ],
    });
    this.appendToolResult('call_open_one', 'one result');
  }

  compactHistory(): Array<{ readonly role: string; readonly text: string }> {
    return this.context.getHistory().map((message) => ({
      role: message.role,
      text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    }));
  }

  async expectResumeMatches(): Promise<void> {
    const resumed = testAgent({
      kaos: createResumeNoSideEffectKaos(this.profile.data().cwd),
      runtime: this.options.runtime,
      toolServices: this.options.toolServices,
      providerManager: this.options.providerManager,
      initialConfig: this.kimiConfig,
      providerManagerOverrides: this.options.providerManagerOverrides,
      generate: failOnResumeGenerate,
      microCompaction: this.options.microCompaction,
      fullCompaction: this.options.fullCompaction,
      subagentHost: this.options.subagentHost,
      experimentalFlags: this.options.experimentalFlags,
      pluginSessionStarts: this.options.pluginSessionStarts,
      persistence: new InMemoryWireRecordPersistence(
        withMetadata(this.recordHistory.map(cloneRecord)),
      ),
    });

    await resumed.runtime.restore();

    // oxlint-disable-next-line jest/no-standalone-expect
    expect(resumeStateSnapshot(resumed)).toEqual(resumeStateSnapshot(this));
  }

  async close(reason = 'Agent runtime test closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    await this.runtime.close(reason);
    this.root.dispose();
  }

  private takeUntilRpc(method: string): Promise<{
    event: RpcLogEntry;
    events: ReturnType<typeof eventSnapshot>;
  }> {
    const ready = this.findRpcFromCursor(method);
    if (ready !== undefined) return Promise.resolve(this.takeThrough(ready));

    const promise = createControlledPromise<{
      event: RpcLogEntry;
      events: ReturnType<typeof eventSnapshot>;
    }>();

    const onEvent = () => {
      const event = this.findRpcFromCursor(method);
      if (event === undefined) return;
      this.emitter.off('event', onEvent);
      promise.resolve(this.takeThrough(event));
    };
    this.emitter.on('event', onEvent);

    return promise;
  }

  private takeThrough(match: { event: RpcLogEntry; index: number }): {
    event: RpcLogEntry;
    events: ReturnType<typeof eventSnapshot>;
  } {
    const events = this.allEvents.slice(this.lastEventCount, match.index + 1);
    this.lastEventCount = match.index + 1;
    return {
      event: match.event,
      events: eventSnapshot(events, this.uuidLabels),
    };
  }

  private findRpcFromCursor(method: string): { event: RpcLogEntry; index: number } | undefined {
    const index = this.allEvents.findIndex((entry, eventIndex) => {
      return eventIndex >= this.lastEventCount && entry.type === '[rpc]' && entry.event === method;
    });
    if (index === -1) return undefined;

    const event = this.allEvents[index]!;
    return { event: event as RpcLogEntry, index };
  }

  private recordWire(event: PersistedWireRecord): WireSnapshotEntry {
    const { type, ...args } = event;
    const entry: WireSnapshotEntry = {
      type: '[wire]',
      event: type,
      args,
    };
    this.allEvents.push(entry);
    this.emitter.emit(type, entry);
    this.emitter.emit('event', entry);
    return entry;
  }

  private recordRpc(method: string, args: unknown, response?: RpcPromise<unknown>): RpcLogEntry {
    const event: RpcLogEntry = {
      type: '[rpc]',
      event: method,
      args,
      ...(response !== undefined ? { [RPC_RESPONSE]: response } : {}),
    };
    this.allEvents.push(event);
    this.emitter.emit(method, event);
    this.emitter.emit('event', event);
    return event;
  }

  private createRpcPromise<T>(signal?: AbortSignal): RpcPromise<T> {
    const promise = createControlledPromise<T>() as RpcPromise<T>;
    const abort = () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      promise.reject(error);
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }
    return promise;
  }

  private resolveRpcRequest(event: RpcLogEntry, result: unknown): void {
    const response = event[RPC_RESPONSE];
    if (response === undefined) {
      throw new Error(`RPC ${event.event} does not have a pending response`);
    }
    response.resolve(result);
  }

  private resolvePendingRpc(method: string, id: string, result: unknown): void {
    const event = this.allEvents.find((entry) => {
      if (entry.type !== '[rpc]' || entry.event !== method) return false;
      if ((entry as RpcLogEntry)[RPC_RESPONSE] === undefined) return false;
      return rpcCorrelationId(entry.args) === id;
    });
    if (event === undefined) {
      throw new Error(`No pending ${method} RPC with id ${id}`);
    }
    this.resolveRpcRequest(event as RpcLogEntry, result);
  }

  private createApprovalService(): IApprovalService {
    return {
      _serviceBrand: undefined,
      request: (request) => {
        const { sessionId: _sessionId, agentId: _agentId, ...payload } = request;
        const promise = this.createRpcPromise<ApprovalResponse>();
        this.recordRpc('requestApproval', payload, promise);
        return promise;
      },
      resolve: (id, response) => {
        this.resolvePendingRpc('requestApproval', id, response);
      },
      listPending: () => [],
    };
  }

  private createQuestionService(): IQuestionService {
    return {
      _serviceBrand: undefined,
      request: (request) => {
        const { sessionId: _sessionId, agentId: _agentId, ...payload } = request;
        const promise = this.createRpcPromise<QuestionResult>();
        this.recordRpc('requestQuestion', payload, promise);
        return promise;
      },
      resolve: (id, response) => {
        this.resolvePendingRpc('requestQuestion', id, response);
      },
      dismiss: (id) => {
        this.resolvePendingRpc('requestQuestion', id, null);
      },
      listPending: () => [],
    };
  }

  private requestUserTool(
    input: {
      readonly turnId: number;
      readonly toolCallId: string;
      readonly args: unknown;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<ToolResult> {
    const promise = this.createRpcPromise<ToolResult>(options?.signal);
    this.recordRpc('toolCall', input, promise);
    options?.signal?.throwIfAborted();
    return promise;
  }

  private wrapPersistence(persistence: WireRecordPersistence): WireRecordPersistence {
    return {
      read: () => this.readAndCapturePersistence(persistence),
      append: (event) => {
        this.captureRecord(event);
        persistence.append(event);
      },
      rewrite: (records) => {
        persistence.rewrite(records);
      },
      flush: () => persistence.flush(),
      close: () => persistence.close(),
    };
  }

  private async *readAndCapturePersistence(
    persistence: WireRecordPersistence,
  ): AsyncIterable<PersistedWireRecord> {
    for await (const event of persistence.read()) {
      this.recordHistory.push(cloneRecord(event));
      yield event;
    }
  }

  private captureRecord(event: PersistedWireRecord): void {
    const cloned = cloneRecord(event);
    this.recordHistory.push(cloned);
    if (this.suppressWireSnapshot) return;

    this.recordWire(cloned);
    const response = this.options.onEvent?.(cloned);
    if (response !== undefined && response.type !== 'metadata') {
      void this.dispatch(response);
    }
  }

  private createPromiseAgentApi(agent: IAgentRPCService): PromiseAgentAPI {
    return new Proxy(agent, {
      get(proxyTarget, property, receiver) {
        const value = Reflect.get(proxyTarget, property, receiver);
        if (typeof value !== 'function') return value;
        return (payload: unknown) => {
          try {
            return Promise.resolve(value.call(proxyTarget, payload));
          } catch (error) {
            return Promise.reject(error);
          }
        };
      },
    }) as unknown as PromiseAgentAPI;
  }

  private appendUserText(text: string): void {
    this.appendMessage({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
  }

  private appendAssistantMessage(message: ContextMessage): void {
    this.appendMessage(message);
  }

  private appendToolResult(toolCallId: string, output: ToolOutput, isError?: boolean): void {
    this.appendMessage({
      role: 'tool',
      content: contentPartsFromToolOutput(output),
      toolCalls: [],
      toolCallId,
      isError,
    });
  }

  private appendMessage(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.context.spliceHistory(this.context.getHistory().length, 0, messages);
  }

  private coverUsage(tokenTotal: number | undefined): void {
    if (tokenTotal === undefined) return;
    const usage = {
      inputOther: tokenTotal - 1,
      output: 1,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    // Persist both the context-size measurement and turn-scoped usage so resume
    // rebuilds size and usage the same way the real loop does.
    this.contextSize.measure(this.context.getHistory().length, tokenTotal);
    this.usage.record(this.profile.data().modelAlias ?? 'mock-model', usage, 'turn');
    this.usage.endTurn();
  }
}

const failOnResumeGenerate: GenerateFn = async () => {
  throw new Error('Resume replay unexpectedly called the LLM');
};

function createResumeNoSideEffectKaos(initialCwd: string): Kaos {
  const fail = (method: string): never => {
    throw new Error(`Resume replay unexpectedly called kaos.${method}`);
  };

  let cwd = initialCwd;
  return {
    name: 'resume-no-side-effects',
    osEnv: TEST_OS_ENV,
    pathClass: () => 'posix',
    normpath: (p: string) => p,
    gethome: () => '/home/test',
    getcwd: () => cwd,
    withCwd: (next: string) => createResumeNoSideEffectKaos(next),
    withEnv: () => createResumeNoSideEffectKaos(cwd),
    chdir: async (next: string) => {
      cwd = next;
    },
    stat: () => fail('stat'),
    iterdir: () => fail('iterdir'),
    glob: () => fail('glob'),
    readBytes: () => fail('readBytes'),
    readText: () => fail('readText'),
    readLines: () => fail('readLines'),
    writeBytes: () => fail('writeBytes'),
    writeText: () => fail('writeText'),
    mkdir: () => fail('mkdir'),
    exec: () => fail('exec'),
    execWithEnv: () => fail('execWithEnv'),
  };
}

function resumeStateSnapshot(ctx: AgentTestContext): ResumeStateSnapshot {
  return {
    background: ctx.background.list(false),
    config: configStateSnapshot(ctx),
    context: resumeContextSnapshot(ctx),
    permission: ctx.permission.data(),
    tools: ctx.toolsData(),
    toolStore: ctx.toolStore.data(),
    usage: ctx.usage.data(),
  };
}

function resumeContextSnapshot(ctx: AgentTestContext) {
  const context = ctx.contextData();
  return {
    ...context,
    history: context.history.filter((message) => !isSystemReminderMessage(message)),
  };
}

function isSystemReminderMessage(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const text = message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trimStart();
  return text.startsWith('<system-reminder>');
}

function configStateSnapshot(ctx: AgentTestContext): ResumeStateSnapshot['config'] {
  const data = ctx.profile.data();
  return {
    cwd: data.cwd,
    provider: data.provider,
    profileName: data.profileName,
    thinkingLevel: data.thinkingLevel,
    systemPrompt: data.systemPrompt,
  };
}

function emptyConfig(): KimiConfig {
  return configWithProvider({ providers: {} }, MOCK_PROVIDER, undefined);
}

function configWithProvider(
  config: KimiConfig,
  provider: ProviderConfig,
  modelCapabilities: ModelCapability | undefined,
): KimiConfig {
  const providerName = 'test-provider';
  const maxContextSize = modelCapabilities?.max_context_tokens;
  return {
    ...config,
    providers: {
      ...config.providers,
      [providerName]: providerConfigForAlias(provider),
    },
    models: {
      ...config.models,
      [provider.model]: {
        provider: providerName,
        model: provider.model,
        maxContextSize:
          maxContextSize === undefined || maxContextSize <= 0 ? 1_000_000 : maxContextSize,
        capabilities: capabilityNames(modelCapabilities),
      },
    },
  };
}

function providerConfigForAlias(provider: ProviderConfig): KimiConfig['providers'][string] {
  return {
    type: provider.type,
    apiKey: 'apiKey' in provider ? provider.apiKey : undefined,
    baseUrl: 'baseUrl' in provider ? provider.baseUrl : undefined,
  };
}

function capabilityNames(capabilities: ModelCapability | undefined): string[] {
  if (capabilities === undefined) return [];
  return [
    capabilities.image_in ? 'image_in' : undefined,
    capabilities.video_in ? 'video_in' : undefined,
    capabilities.audio_in ? 'audio_in' : undefined,
    capabilities.thinking ? 'thinking' : undefined,
    capabilities.tool_use ? 'tool_use' : undefined,
  ].filter((capability): capability is string => capability !== undefined);
}

function toolCall(
  id: string,
  name: string,
  args: unknown,
): ContextMessage['toolCalls'][number] {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function contentPartsFromToolOutput(output: ToolOutput): ContentPart[] {
  if (typeof output !== 'string') return [...output];
  return [{ type: 'text', text: output }];
}

function createLogService(logger: Logger | undefined): ILogService {
  return {
    _serviceBrand: undefined,
    info: (obj, msg) => {
      writeLog(logger, 'info', obj, msg);
    },
    warn: (obj, msg) => {
      writeLog(logger, 'warn', obj, msg);
    },
    error: (obj, msg) => {
      writeLog(logger, 'error', obj, msg);
    },
    debug: (obj, msg) => {
      writeLog(logger, 'debug', obj, msg);
    },
    child: (bindings: any) => createLogService(logger?.createChild(bindings)),
  };
}

function writeLog(
  logger: Logger | undefined,
  level: 'info' | 'warn' | 'error' | 'debug',
  obj: object | string,
  msg: string | undefined,
): void {
  if (logger === undefined) return;
  if (typeof obj === 'string') {
    logger[level](msg === undefined ? obj : `${msg}: ${obj}`);
    return;
  }
  logger[level](msg ?? 'agent runtime log', obj);
}

function rpcCorrelationId(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const record = args as { readonly toolCallId?: unknown; readonly turnId?: unknown };
  if (typeof record.toolCallId === 'string') return record.toolCallId;
  if (typeof record.turnId === 'string' || typeof record.turnId === 'number') {
    return String(record.turnId);
  }
  return undefined;
}

function cloneRecord<T extends PersistedWireRecord>(event: T): T {
  return structuredClone(event);
}

function withMetadata(events: readonly PersistedWireRecord[]): readonly PersistedWireRecord[] {
  if (events.length === 0 || events[0]?.type === 'metadata') return events;
  return [
    {
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
      created_at: 1,
    },
    ...events,
  ];
}
