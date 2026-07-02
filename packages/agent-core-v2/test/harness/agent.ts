import { EventEmitter } from 'node:events';
import { isAbsolute, relative, resolve } from 'node:path';
import { Readable, type Writable } from 'node:stream';

import { createControlledPromise } from '@antfu/utils';
import {
  isToolCall,
  isToolCallPart,
  type ChatProvider,
  type ContentPart,
  type GenerateOptions,
  KimiChatProvider,
  type Message as KosongMessage,
  type ModelCapability,
  type ProviderConfig,
  type StreamedMessage,
  type StreamedMessagePart,
  type ThinkingEffort,
  type Tool as KosongTool,
  type generate as kosongGenerate,
} from '@moonshot-ai/kosong';
import { expect, vi } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  AgentBackgroundService,
  AgentExternalHooksService,
  FileStorageService,
  InMemoryStorageService,
  AgentFullCompactionService,
  IAgentRPCService,
  IAppendLogStore,
  IAppendLogStorage,
  ISessionApprovalService,
  ISessionMetadata,
  IAtomicDocumentStorage,
  IAgentBackgroundService,
  IBlobStorage,
  IBootstrapOptions,
  IBootstrapService,
  IConfigService,
  IAgentContextMemoryService,
  IAgentContextProjectorService,
  IAgentContextSizeService,
  IAgentEventSinkService,
  IAgentExternalHooksService,
  IAgentFileToolsService,
  IAgentFullCompactionService,
  IAgentLLMRequesterService,
  ILogService,
  IAgentMcpService,
  IAgentMicroCompactionService,
  IAgentPermissionGate,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  ISessionAgentFileSystem,
  ISessionContext,
  IAgentShellToolsService,
  ISessionProcessRunner,
  IStorageService,
  IAgentScopeContext,
  IAgentSwarmService,
  AgentSwarmService,
  ITelemetryService,
  ISessionTerminalBackend,
  IAgentToolService,
  AgentToolService,
  IAgentToolRegistryService,
  IAgentToolStoreService,
  IAgentUserToolService,
  IAgentUsageService,
  IAgentWireRecordService,
  ISessionWorkspaceContext,
  AgentLLMRequesterService,
  LifecycleScope,
  AgentMcpService,
  AgentMicroCompactionService,
  AgentPermissionGate,
  AgentPermissionRulesService,
  AgentProfileService,
  SyncDescriptor,
  AgentUserToolService,
  AgentWireRecordService,
  SessionWorkspaceContextService,
  bootstrapSeed,
  createAppScope,
  resolveBootstrapOptions,
  type IDisposable,
  type Scope,
  type ScopeSeed,
  type ServiceIdentifier,
  type AgentToolRunOverride,
} from '#/index';
import type { IProcess } from '#/session/process';
import { IExecContext, createExecContext } from '#/session/execContext';
import { ISessionSwarmService } from '#/session/swarm';
import { Event } from '#/_base/event';
import { toDisposable } from '#/_base/di';
import type { PromisifyMethods } from '#/_base/utils/types';
import type { ApprovalResponse } from '#/session/approval';
import type { BackgroundTaskInfo } from '#/agent/background';
import { IAgentBlobStoreService, type IAgentBlobStoreService as AgentBlobStoreService } from '#/agent/blobStore';
import { IOAuthService } from '#/app/auth/auth';
import { IChatProviderFactory } from '#/app/chatProvider';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import { IAgentCronService } from '#/agent/cron/cron';
import { AgentCronService } from '#/agent/cron/cronService';
import type { HookEngine } from '#/agent/externalHooks/engine';
import type { FullCompactionServiceOptions } from '#/agent/fullCompaction';
import type { ILogger, LogContext, LogLevel } from '#/app/log';
import type { McpServiceOptions } from '#/agent/mcp';
import { MICRO_COMPACTION_SECTION, type MicroCompactionConfig } from '#/agent/microCompaction';
import { ISessionModelResolver, SessionModelResolver, type ResolvedModel } from '#/session/modelRuntime';
import type { PermissionGateOptions } from '#/agent/permissionGate';
import type { PermissionMode } from '#/agent/permissionPolicy';
import type { PermissionRule } from '#/agent/permissionRules';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AgentGoalService, IAgentGoalService, type GoalServiceOptions } from '#/agent/goal';
import { IAgentPlanService } from '#/agent/plan';
import { ISessionQuestionService, type QuestionResult } from '#/session/question/question';
import {
  ISessionInteractionService,
  type Interaction,
  type InteractionRequest,
  type InteractionPendingChangedEvent,
  type InteractionResolution,
} from '#/session/interaction';
import {
  IAgentReplayBuilderService,
  AgentReplayBuilderService,
  type ReplayBuilderServiceOptions,
} from '#/agent/replayBuilder';
import type { AgentAPI } from '#/agent/rpc/core-api';
import { IAgentSkillService } from '#/agent/skill/skill';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { AgentSkillService } from '#/agent/skill/skillService';
import { ModelSkillTool } from '#/agent/skill/tools/modelSkill';
import type { SkillCatalog } from '#/app/globalSkillCatalog/types';
import type { ExecutableToolOutput as ToolOutput, ToolResult } from '#/agent/tool';
import type {
  PersistedWireRecord,
  WireRecord,
  WireRecordRestoreOptions,
  WireRecordRestoreResult,
} from '#/agent/wireRecord';
import { IAgentRecordService } from '#/agent/record';
import type { PathAccessOperation } from '#/session/workspaceContext';
import { createFakeAgentFs, createFakeProcessRunner } from '../tools/fixtures/fake-exec';

import { createScriptedGenerate } from './scripted-generate';
import {
  DEFAULT_TEST_SYSTEM_PROMPT,
  type EventSnapshot,
  type EventSnapshotEntry,
  type WireSnapshotEntry,
} from './snapshots';
import { recordAgentEvents, type RecordedEventEntry } from '../snapshot/events';

const TEST_HOME_DIR = '/home/test';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const;

interface TestModelProviderOptions {
  readonly promptCacheKey?: string;
  readonly kimiRequestHeaders?: Record<string, string>;
}

interface KimiConfig {
  readonly providers: Record<string, ProviderConfigForConfig>;
  readonly models?: Record<string, ModelConfigForConfig>;
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly [domain: string]: unknown;
}

interface ModelConfigForConfig {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: readonly string[];
}

interface ProviderConfigForConfig {
  readonly type: ProviderConfig['type'];
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly oauth?: {
    readonly storage: 'file' | 'keyring';
    readonly key: string;
    readonly oauthHost?: string;
  };
}

interface Logger {
  info(message: string, payload?: unknown): void;
  warn(message: string, payload?: unknown): void;
  error(message: string, payload?: unknown): void;
  debug(message: string, payload?: unknown): void;
  createChild?(bindings: LogContext): Logger;
  child?(bindings: LogContext): Logger;
}

class TestAgentSkillService extends AgentSkillService {
  constructor(
    @ISessionSkillCatalog skillCatalog: ISessionSkillCatalog,
    @IAgentPromptService prompt: IAgentPromptService,
    @IAgentRecordService records: IAgentRecordService,
    @ITelemetryService telemetry: ITelemetryService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super(skillCatalog, prompt, records, telemetry, toolRegistry);
    if (skillCatalog.catalog.listInvocableSkills().length > 0) {
      this._register(toolRegistry.register(new ModelSkillTool(this)));
    }
  }
}

export interface WireRecordPersistence {
  readonly records: readonly PersistedWireRecord[];
  read(): AsyncIterable<PersistedWireRecord>;
  append(event: PersistedWireRecord): void;
  rewrite(records: readonly PersistedWireRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryWireRecordPersistence implements WireRecordPersistence {
  readonly records: PersistedWireRecord[];

  constructor(records: readonly PersistedWireRecord[] = []) {
    this.records = records.map(cloneRecord);
  }

  async *read(): AsyncIterable<PersistedWireRecord> {
    for (const record of this.records) {
      yield cloneRecord(record);
    }
  }

  append(event: PersistedWireRecord): void {
    this.records.push(cloneRecord(event));
  }

  rewrite(records: readonly PersistedWireRecord[]): void {
    this.records.splice(0, this.records.length, ...records.map(cloneRecord));
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

type RpcPromise<T> = Promise<T> & {
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

type PromiseAgentAPI = PromisifyMethods<AgentAPI>;
type GenerateFn = typeof kosongGenerate;

type TestToolResult = ToolResult & {
  readonly content?: unknown;
};

interface UserToolInteractionPayload {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly args: unknown;
}

interface ResumeStateSnapshot {
  readonly background: ReturnType<IAgentBackgroundService['list']>;
  readonly config: {
    readonly cwd: string;
    readonly activeToolNames: readonly string[] | undefined;
    readonly provider: ProviderConfig | undefined;
    readonly profileName: string | undefined;
    readonly thinkingLevel: string;
    readonly systemPrompt: string;
  };
  readonly context: {
    readonly history: readonly ContextMessage[];
    readonly tokenCount: number;
  };
  readonly permission: ReturnType<IAgentPermissionGate['data']>;
  readonly toolStore: ReturnType<IAgentToolStoreService['data']>;
  readonly usage: ReturnType<IAgentUsageService['status']>;
}

interface ConfigureOptions {
  readonly tools?: readonly string[] | undefined;
  readonly provider?: ProviderConfig | undefined;
  readonly modelCapabilities?: ModelCapability | undefined;
}

export type TestAgentContext = AgentTestContext;

export interface TestAgentOptions {
  readonly generate?: GenerateFn | undefined;
  readonly telemetry?: ITelemetryService | undefined;
  readonly persistence?: WireRecordPersistence | undefined;
  readonly microCompaction?: {
    readonly config?: Partial<MicroCompactionConfig> | undefined;
  } | undefined;
  readonly fullCompaction?: FullCompactionServiceOptions | undefined;
  readonly hookEngine?: Pick<HookEngine, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'> | undefined;
  readonly initialConfig?: Partial<KimiConfig> | undefined;
  readonly autoConfigure?: boolean | undefined;
  readonly [key: string]: unknown;
}

type MutableScopeSeed = Array<readonly [ServiceIdentifier<unknown>, unknown]>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtor<T> = new (...args: any[]) => T;
type TestAgentServiceScope = 'app' | 'session' | 'agent';

export interface TestAgentServiceRegistration {
  define<T>(id: ServiceIdentifier<T>, ctor: AnyCtor<T>): void;
  defineDescriptor<T>(id: ServiceIdentifier<T>, descriptor: SyncDescriptor<T>): void;
  defineInstance<T>(id: ServiceIdentifier<T>, instance: T): void;
  definePartialInstance<T>(id: ServiceIdentifier<T>, instance: Partial<T>): void;
}

export type TestAgentServiceGroup = (reg: TestAgentServiceRegistration) => void;

interface TestAgentScopedServiceOverride {
  readonly scope: TestAgentServiceScope;
  register(reg: TestAgentServiceRegistration): void;
}

export type TestAgentServiceOverride =
  | TestAgentScopedServiceOverride
  | readonly TestAgentServiceOverride[];

type TestAgentInput = TestAgentServiceOverride | TestAgentOptions;

export function appServices(group: TestAgentServiceGroup): TestAgentServiceOverride {
  return scopedServices('app', group);
}

export function sessionServices(group: TestAgentServiceGroup): TestAgentServiceOverride {
  return scopedServices('session', group);
}

export function agentServices(group: TestAgentServiceGroup): TestAgentServiceOverride {
  return scopedServices('agent', group);
}

export function appService<T>(
  id: ServiceIdentifier<T>,
  value: T | SyncDescriptor<T>,
): TestAgentServiceOverride {
  return appServices((reg) => defineServiceValue(reg, id, value));
}

export function sessionService<T>(
  id: ServiceIdentifier<T>,
  value: T | SyncDescriptor<T>,
): TestAgentServiceOverride {
  return sessionServices((reg) => defineServiceValue(reg, id, value));
}

export function agentService<T>(
  id: ServiceIdentifier<T>,
  value: T | SyncDescriptor<T>,
): TestAgentServiceOverride {
  return agentServices((reg) => defineServiceValue(reg, id, value));
}

function scopedServices(
  scope: TestAgentServiceScope,
  register: TestAgentServiceGroup,
): TestAgentScopedServiceOverride {
  return { scope, register };
}

function defineServiceValue<T>(
  reg: TestAgentServiceRegistration,
  id: ServiceIdentifier<T>,
  value: T | SyncDescriptor<T>,
): void {
  if (value instanceof SyncDescriptor) {
    reg.defineDescriptor(id, value);
  } else {
    reg.defineInstance(id, value);
  }
}

type ExecContextOverride = {
  readonly cwd?: string;
  readonly envLayers?: readonly Record<string, string>[];
};

/**
 * Session-scope override for the execution environment and derived atoms.
 */
export interface ExecEnvOverride {
  readonly execContext?: ExecContextOverride;
  readonly agentFs?: ISessionAgentFileSystem | Partial<ISessionAgentFileSystem>;
  readonly processRunner?: ISessionProcessRunner | Partial<ISessionProcessRunner>;
}

/**
 * Register a fake execution-environment set for a test session. Any
 * unspecified atom keeps the harness default `IExecContext` and the real
 * services backed by it.
 */
export function execEnvServices(override: ExecEnvOverride = {}): TestAgentServiceOverride {
  return sessionServices((reg) => {
    if (override.execContext !== undefined) {
      reg.defineInstance(
        IExecContext,
        createExecContext(override.execContext.cwd ?? '/workspace', override.execContext.envLayers),
      );
    }
    if (override.agentFs !== undefined) {
      reg.defineInstance(ISessionAgentFileSystem, resolveAgentFsOverride(override.agentFs));
    }
    if (override.processRunner !== undefined) {
      reg.defineInstance(ISessionProcessRunner, resolveProcessRunnerOverride(override.processRunner));
    }
    reg.defineDescriptor(ISessionWorkspaceContext, new SyncDescriptor(SessionWorkspaceContextService));
  });
}

function resolveAgentFsOverride(
  input: ISessionAgentFileSystem | Partial<ISessionAgentFileSystem>,
): ISessionAgentFileSystem {
  // A full impl (class instance or `Proxy` over one) exposes every core
  // method. A partial override typically covers only a few of them. If every
  // core method is a function, pass the input through unchanged; otherwise
  // treat it as a partial override and spread it over the fake defaults.
  if (isFullAgentFs(input)) return input as ISessionAgentFileSystem;
  return createFakeAgentFs(input as Partial<ISessionAgentFileSystem>);
}

function isFullAgentFs(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const keys: readonly (keyof ISessionAgentFileSystem)[] = [
    'readText',
    'writeText',
    'readBytes',
    'readLines',
    'writeBytes',
    'stat',
    'readdir',
    'glob',
    'mkdir',
    'withCwd',
  ];
  return keys.every((k) => typeof (input as Record<string, unknown>)[k] === 'function');
}

function resolveProcessRunnerOverride(
  input: ISessionProcessRunner | Partial<ISessionProcessRunner>,
): ISessionProcessRunner {
  // `ISessionProcessRunner` has only one method (`exec`), so a full impl is
  // any object with `exec` as a function. Both `SessionProcessRunner`
  // instances and `createFakeProcessRunner()` results satisfy this.
  if (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as ISessionProcessRunner).exec === 'function'
  ) {
    return input as ISessionProcessRunner;
  }
  return createFakeProcessRunner(input as Partial<ISessionProcessRunner>);
}

export function homeDirServices(homeDir: string | undefined): TestAgentServiceOverride {
  return appServices((reg) => {
    if (homeDir !== undefined) {
      reg.defineInstance(
        IBootstrapOptions,
        resolveBootstrapOptions({ homeDir, cwd: process.cwd(), env: process.env }),
      );
      const file = (): SyncDescriptor<IStorageService> =>
        new SyncDescriptor(FileStorageService, [homeDir], true);
      reg.defineDescriptor(IStorageService, file());
      reg.defineDescriptor(IAppendLogStorage, file());
      reg.defineDescriptor(IAtomicDocumentStorage, file());
      reg.defineDescriptor(IBlobStorage, file());
    }
  });
}

export function additionalDirServices(additionalDirs: readonly string[]): TestAgentServiceOverride {
  return sessionServices((reg) => {
    reg.defineInstance(ISessionWorkspaceContext, createWorkspaceContextStub(process.cwd(), additionalDirs));
  });
}

export function modelProviderServices(modelResolver: ISessionModelResolver): TestAgentServiceOverride {
  return sessionService(ISessionModelResolver, modelResolver);
}

export function modelProviderOptionServices(
  options: TestModelProviderOptions,
): TestAgentServiceOverride {
  return sessionService(ISessionModelResolver, new SyncDescriptor(ConfigBackedModelResolver, [options]));
}

export function configServices(readConfig: () => KimiConfig): TestAgentServiceOverride {
  return appService(IConfigService, configService(readConfig));
}

export function wireRecordPersistenceServices(
  persistence: WireRecordPersistence,
  onRead: (event: PersistedWireRecord) => void = () => {},
): TestAgentServiceOverride {
  return appService(
    IAppendLogStore,
    new PersistenceAppendLogStore(persistence, () => {}, onRead),
  );
}

export function logServices(logger: Logger): TestAgentServiceOverride {
  return appService(ILogService, createLogService(logger));
}

export function llmGenerateServices(generate: GenerateFn): TestAgentServiceOverride {
  return appService(IChatProviderFactory, createGenerateBackedChatProviderFactory(generate));
}

export function telemetryServices(telemetry: ITelemetryService): TestAgentServiceOverride {
  return appService(ITelemetryService, telemetry);
}

export function questionServices(service: ISessionQuestionService): TestAgentServiceOverride {
  return sessionService(ISessionQuestionService, service);
}

export function externalHookServices(
  hookEngine: Pick<HookEngine, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'> | undefined,
): TestAgentServiceOverride {
  return agentService(
    IAgentExternalHooksService,
    new SyncDescriptor(AgentExternalHooksService, [hookEngine === undefined ? {} : { hookEngine }]),
  );
}

export function microCompactionServices(
  options: { readonly config?: Partial<MicroCompactionConfig> },
): TestAgentServiceOverride {
  return configServices(() => ({
    ...emptyConfig(),
    [MICRO_COMPACTION_SECTION]: options.config,
  }));
}

export function fullCompactionServices(
  options: FullCompactionServiceOptions,
): TestAgentServiceOverride {
  return agentService(IAgentFullCompactionService, new SyncDescriptor(AgentFullCompactionService, [options]));
}

export function permissionModeServices(mode: PermissionMode): TestAgentServiceOverride {
  return agentService(
    IAgentPermissionModeService,
    createPermissionModeService(mode),
  );
}

export function permissionRulesServices(rules: readonly PermissionRule[]): TestAgentServiceOverride {
  return agentService(IAgentPermissionRulesService, createPermissionRulesStub(rules));
}

export function backgroundServices(): TestAgentServiceOverride {
  return agentService(IAgentBackgroundService, new SyncDescriptor(AgentBackgroundService));
}

export function cronServices(
  options: ConstructorParameters<typeof AgentCronService>[0],
): TestAgentServiceOverride {
  return agentService(IAgentCronService, new SyncDescriptor(AgentCronService, [options]));
}

export function mcpServices(options: McpServiceOptions): TestAgentServiceOverride {
  return agentService(IAgentMcpService, new SyncDescriptor(AgentMcpService, [options]));
}

export function skillServices(input: ISessionSkillCatalog | SkillCatalog): TestAgentServiceOverride {
  const catalogService = isSessionSkillCatalog(input)
    ? input
    : createSessionSkillCatalog(input);
  return [
    sessionService(ISessionSkillCatalog, catalogService),
    agentService(IAgentSkillService, new SyncDescriptor(TestAgentSkillService)),
  ];
}

function isSessionSkillCatalog(input: ISessionSkillCatalog | SkillCatalog): input is ISessionSkillCatalog {
  return 'catalog' in input;
}

function createSessionSkillCatalog(catalog: SkillCatalog): ISessionSkillCatalog {
  return {
    _serviceBrand: undefined,
    catalog,
    ready: Promise.resolve(),
    load: async () => {},
    reload: async () => {},
  };
}

export function agentToolServices(runOverride: AgentToolRunOverride): TestAgentServiceOverride {
  return agentService(
    IAgentToolService,
    new SyncDescriptor(AgentToolService, [runOverride]),
  );
}

export function swarmServices(
  swarmService: ISessionSwarmService,
): TestAgentServiceOverride {
  return [
    sessionService(ISessionSwarmService, swarmService),
    agentService(IAgentSwarmService, new SyncDescriptor(AgentSwarmService)),
  ];
}

export function goalServices(options: GoalServiceOptions): TestAgentServiceOverride {
  return agentService(IAgentGoalService, new SyncDescriptor(AgentGoalService, [options]));
}

export function replayServices(options: ReplayBuilderServiceOptions = {}): TestAgentServiceOverride {
  return agentService(IAgentReplayBuilderService, new SyncDescriptor(AgentReplayBuilderService, [options]));
}

/**
 * Build a fake `ISessionProcessRunner` whose `exec` returns a scripted
 * `IProcess` emitting `stdout` on stdout and exiting with `exitCode`.
 */
export function createCommandRunner(stdout: string, exitCode = 0): ISessionProcessRunner {
  function createProcess(): IProcess {
    return {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode,
      wait: vi.fn().mockResolvedValue(exitCode) as IProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
    };
  }
  return createFakeProcessRunner({
    exec: vi.fn().mockImplementation(async () => createProcess()),
  });
}

export function testAgent(...inputs: readonly TestAgentInput[]): AgentTestContext {
  return createTestAgent(...inputs);
}

export function createTestAgent(...inputs: readonly TestAgentInput[]): AgentTestContext {
  const { options, overrides } = normalizeTestAgentInputs(inputs);
  return new AgentTestContext(overrides, options);
}

function normalizeTestAgentInputs(
  inputs: readonly TestAgentInput[],
): { readonly options: TestAgentOptions; readonly overrides: readonly TestAgentServiceOverride[] } {
  let options: TestAgentOptions = {};
  const overrides: TestAgentServiceOverride[] = [];
  for (const input of inputs) {
    if (isTestAgentOptions(input)) {
      options = mergeTestAgentOptions(options, input);
    } else {
      overrides.push(input);
    }
  }
  return { options, overrides };
}

function isTestAgentOptions(input: TestAgentInput): input is TestAgentOptions {
  return !Array.isArray(input) && !('scope' in input);
}

function mergeTestAgentOptions(
  base: TestAgentOptions,
  next: TestAgentOptions,
): TestAgentOptions {
  return {
    ...base,
    ...next,
    microCompaction:
      base.microCompaction === undefined && next.microCompaction === undefined
        ? undefined
        : {
          ...base.microCompaction,
          ...next.microCompaction,
          config: {
            ...base.microCompaction?.config,
            ...next.microCompaction?.config,
          },
        },
    initialConfig: {
      ...base.initialConfig,
      ...next.initialConfig,
    },
  };
}

function flattenServiceOverrides(
  overrides: readonly TestAgentServiceOverride[],
): TestAgentScopedServiceOverride[] {
  const flattened: TestAgentScopedServiceOverride[] = [];
  for (const override of overrides) {
    if (Array.isArray(override)) {
      flattened.push(...flattenServiceOverrides(override));
    } else {
      flattened.push(override as TestAgentScopedServiceOverride);
    }
  }
  return flattened;
}

function collectScopeSeed(
  baseGroups: readonly TestAgentServiceGroup[],
  overrides: readonly TestAgentScopedServiceOverride[],
  scope: TestAgentServiceScope,
): ScopeSeed {
  const seed: MutableScopeSeed = [];
  const indexes = new Map<ServiceIdentifier<unknown>, number>();

  const register = <T>(
    id: ServiceIdentifier<T>,
    value: T | Partial<T> | SyncDescriptor<T>,
    overwrite: boolean,
  ): void => {
    const key = id as ServiceIdentifier<unknown>;
    const entry = [key, value] as const;
    const existing = indexes.get(key);
    if (existing !== undefined) {
      if (overwrite) {
        seed[existing] = entry;
      }
      return;
    }
    indexes.set(key, seed.length);
    seed.push(entry);
  };

  const baseReg: TestAgentServiceRegistration = {
    define: (id, ctor) => register(id, new SyncDescriptor(ctor), false),
    defineDescriptor: (id, descriptor) => register(id, descriptor, false),
    defineInstance: (id, instance) => register(id, instance, false),
    definePartialInstance: (id, instance) => register(id, instance, false),
  };
  for (const group of baseGroups) {
    group(baseReg);
  }

  const additionalReg: TestAgentServiceRegistration = {
    define: (id, ctor) => register(id, new SyncDescriptor(ctor), true),
    defineDescriptor: (id, descriptor) => register(id, descriptor, true),
    defineInstance: (id, instance) => register(id, instance, true),
    definePartialInstance: (id, instance) => register(id, instance, true),
  };
  for (const override of overrides) {
    if (override.scope === scope) {
      override.register(additionalReg);
    }
  }

  return seed;
}

class PersistenceAppendLogStore implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly persistence: WireRecordPersistence,
    private readonly onAppend: (event: PersistedWireRecord) => void,
    private readonly onRead: (event: PersistedWireRecord) => void,
  ) {}

  append<R>(_scope: string, _key: string, record: R): void {
    const event = record as PersistedWireRecord;
    this.onAppend(event);
    this.persistence.append(event);
  }

  async *read<R>(_scope: string, _key: string): AsyncIterable<R> {
    for await (const event of this.persistence.read()) {
      this.onRead(event);
      yield event as R;
    }
  }

  rewrite<R>(_scope: string, _key: string, records: readonly R[]): Promise<void> {
    this.persistence.rewrite(records as readonly PersistedWireRecord[]);
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return this.persistence.flush();
  }

  close(): Promise<void> {
    return this.persistence.close();
  }

  acquire(_scope: string, _key: string): IDisposable {
    return toDisposable(() => {});
  }
}

class ConfigBackedModelResolver extends SessionModelResolver {
  constructor(
    private readonly options: TestModelProviderOptions = {},
    @IConfigService config: IConfigService,
    @IOAuthService oauth: IOAuthService,
  ) {
    super(config, oauth);
  }

  override resolve(model: string): ResolvedModel {
    const resolved = super.resolve(model);
    if (resolved.provider.type !== 'kimi') return resolved;
    return {
      ...resolved,
      provider: {
        ...resolved.provider,
        generationKwargs: {
          ...resolved.provider.generationKwargs,
          prompt_cache_key: this.options.promptCacheKey,
        },
        defaultHeaders: {
          ...this.options.kimiRequestHeaders,
          ...resolved.provider.defaultHeaders,
        },
      },
    };
  }
}

class RecordingWireRecordService extends AgentWireRecordService {
  constructor(
    private readonly onAppend: (record: PersistedWireRecord) => void,
    @IBootstrapService bootstrap: IBootstrapService,
    @IAgentBlobStoreService blobStore?: AgentBlobStoreService,
    @IAppendLogStore log?: IAppendLogStore,
  ) {
    super({}, bootstrap, blobStore, log);
  }

  override append(record: WireRecord): void {
    const stamped: WireRecord =
      record.time !== undefined ? record : ({ ...record, time: Date.now() } as WireRecord);
    this.onAppend(stamped);
    super.append(stamped);
  }
}

function renderPluginSessionStartReminder(
  sessionStarts: readonly EnabledPluginSessionStart[],
  catalog: SkillCatalog,
  log?: { warn(message: string, payload?: unknown): void },
): string | undefined {
  if (sessionStarts.length === 0) return undefined;
  const blocks: string[] = [];
  for (const sessionStart of sessionStarts) {
    const skill = catalog.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
    if (skill === undefined) {
      log?.warn('plugin sessionStart skill not found', {
        pluginId: sessionStart.pluginId,
        skillName: sessionStart.skillName,
      });
      continue;
    }
    blocks.push(
      `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
        `skill="${escapeXmlAttr(skill.name)}">\n${catalog.renderSkillPrompt(skill, '')}\n</plugin_session_start>`,
    );
  }
  return blocks.length > 0 ? blocks.join('\n') : undefined;
}

export class AgentTestContext {
  private readonly serviceOverrides: readonly TestAgentScopedServiceOverride[];
  private readonly options: TestAgentOptions;
  private readonly scriptedGenerate = createScriptedGenerate();
  readonly recordHistory: PersistedWireRecord[] = [];
  private readonly root: Scope;
  private readonly session: Scope;
  private readonly agent: Scope;
  private readonly disposables: IDisposable[] = [];
  private suppressWireSnapshot = false;
  private pluginSessionStartRegistered = false;
  kimiConfig: KimiConfig;
  private cwd = process.cwd();
  private closed = false;

  readonly snapshots = recordAgentEvents();
  readonly emitter = new EventEmitter();
  readonly allEvents: EventSnapshotEntry[] = this.snapshots.entries;
  readonly rpc: PromiseAgentAPI;
  readonly llmCalls = this.scriptedGenerate.calls;
  readonly lastLlmInput = this.scriptedGenerate.lastInput;
  readonly llmInputs = this.scriptedGenerate.inputs;
  readonly mockNextResponse = this.scriptedGenerate.mockNextResponse;
  readonly mockNextProviderResponse = this.scriptedGenerate.mockNextProviderResponse;

  constructor(
    overrides: readonly TestAgentServiceOverride[] = [],
    options: TestAgentOptions = {},
  ) {
    this.options = options;
    this.serviceOverrides = flattenServiceOverrides(overrides);
    this.emitter.on('error', () => {});
    this.kimiConfig = applyTestAgentOptionsToConfig(emptyConfig(), options);

    const sessionId = 'test-session';
    const agentId = 'main';
    const persistence = options.persistence ?? new InMemoryWireRecordPersistence();

    const appSeeds = collectScopeSeed([
      (reg) => {
        for (const [id, value] of bootstrapSeed({
          homeDir: '/tmp/kimi-code-agent-app-v2-test',
          cwd: this.cwd,
          osHomeDir: TEST_HOME_DIR,
          env: process.env,
        })) {
          reg.defineInstance(id, value);
        }
        // In-memory Storage-layer backend. The `InMemoryStorageService` is no
        // longer auto-registered, so the harness seeds it here to keep a
        // workable default for storage-backed services. Tests that need durable
        // (file) storage override this via `homeDirServices(dir)` — overrides
        // win over this base seed (see `collectScopeSeed`).
        const memoryStorage = (): SyncDescriptor<IStorageService> =>
          new SyncDescriptor(InMemoryStorageService, [], true);
        reg.defineDescriptor(IStorageService, memoryStorage());
        reg.defineDescriptor(IAppendLogStorage, memoryStorage());
        reg.defineDescriptor(IAtomicDocumentStorage, memoryStorage());
        reg.defineDescriptor(IBlobStorage, memoryStorage());
        reg.defineInstance(IConfigService, configService(() => this.kimiConfig));
        reg.defineInstance(
          IAppendLogStore,
          new PersistenceAppendLogStore(
            persistence,
            () => {},
            (event) => {
              this.recordHistory.push(cloneRecord(event));
            },
          ),
        );
        reg.defineInstance(ILogService, createLogService(undefined));
        reg.defineInstance(
          IChatProviderFactory,
          createGenerateBackedChatProviderFactory(
            options.generate ?? this.scriptedGenerate.generate,
          ),
        );
        if (options.telemetry !== undefined) {
          reg.defineInstance(ITelemetryService, options.telemetry);
        }
      },
    ], this.serviceOverrides, 'app');
    this.root = createAppScope({ extra: appSeeds });

    const bootstrap = this.root.accessor.get(IBootstrapService);
    this.session = this.root.createChild(LifecycleScope.Session, sessionId, {
      extra: collectScopeSeed([
        (reg) => {
          reg.defineInstance(ISessionContext, {
            _serviceBrand: undefined,
            sessionId,
            workspaceId: 'test-workspace',
            sessionDir: `${bootstrap.sessionsDir}/test-workspace/${sessionId}`,
            metaScope: `sessions/test-workspace/${sessionId}/session-meta`,
          });
          reg.defineInstance(ISessionInteractionService, this.createInteractionService());
          reg.defineInstance(ISessionApprovalService, this.createApprovalService());
          reg.defineInstance(ISessionQuestionService, this.createQuestionService());
          reg.defineInstance(IExecContext, createExecContext(this.cwd));
          // Note: `ISessionAgentFileSystem` and `ISessionProcessRunner` are
          // auto-registered by their service files and backed by `IExecContext`.
          // Tests that need a fake override them via `execEnvServices`.
          reg.defineInstance(ISessionTerminalBackend, createTerminalBackend());
          reg.defineDescriptor(ISessionWorkspaceContext, new SyncDescriptor(SessionWorkspaceContextService));
          reg.defineDescriptor(ISessionModelResolver, new SyncDescriptor(ConfigBackedModelResolver, [{}]));
        },
      ], this.serviceOverrides, 'session'),
    });
    const workspace = this.session.accessor.get(ISessionWorkspaceContext);

    this.agent = this.session.createChild(LifecycleScope.Agent, agentId, {
      extra: collectScopeSeed([
        (reg) => {
          reg.defineDescriptor(IAgentWireRecordService, new SyncDescriptor(RecordingWireRecordService, [
            (event: PersistedWireRecord) => this.captureRecord(event),
          ]));
          reg.defineDescriptor(IAgentProfileService, new SyncDescriptor(AgentProfileService));
          reg.defineDescriptor(IAgentLLMRequesterService, new SyncDescriptor(AgentLLMRequesterService));
          reg.defineDescriptor(
            IAgentExternalHooksService,
            new SyncDescriptor(AgentExternalHooksService, [
              options.hookEngine === undefined ? {} : { hookEngine: options.hookEngine },
            ]),
          );
          reg.defineDescriptor(IAgentMicroCompactionService, new SyncDescriptor(AgentMicroCompactionService));
          reg.defineDescriptor(
            IAgentFullCompactionService,
            new SyncDescriptor(AgentFullCompactionService, [options.fullCompaction ?? {}]),
          );
          reg.defineDescriptor(
            IAgentPermissionRulesService,
            new SyncDescriptor(AgentPermissionRulesService),
          );
          reg.defineDescriptor(
            IAgentPermissionGate,
            new SyncDescriptor(AgentPermissionGate, [{
              agentId,
            } satisfies PermissionGateOptions]),
          );
          reg.defineDescriptor(IAgentCronService, new SyncDescriptor(AgentCronService, [{}]));
          reg.defineDescriptor(IAgentBackgroundService, new SyncDescriptor(AgentBackgroundService));
          reg.defineDescriptor(IAgentMcpService, new SyncDescriptor(AgentMcpService, [{}]));
          reg.defineDescriptor(IAgentReplayBuilderService, new SyncDescriptor(AgentReplayBuilderService, [{}]));
          reg.defineDescriptor(IAgentGoalService, new SyncDescriptor(AgentGoalService, [{}]));
          reg.defineDescriptor(IAgentSkillService, new SyncDescriptor(AgentSkillService));
          reg.defineDescriptor(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));
          reg.defineInstance(IAgentScopeContext, { _serviceBrand: undefined, agentId });
          reg.defineDescriptor(
            IAgentToolService,
            new SyncDescriptor(AgentToolService, [unavailableAgentToolRun()]),
          );
        },
      ], this.serviceOverrides, 'agent'),
    });

    this.get(IAgentProfileService).configure({
      cwd: () => this.cwd,
      chdir: async (nextCwd: string) => {
        this.cwd = nextCwd;
        workspace.setWorkDir(nextCwd);
      },
    });

    this.initializeRestorableServices();

    const events = this.get(IAgentEventSinkService);
    this.disposables.push(
      events.on((event) => {
        const { type, ...args } = event;
        this.recordRpc(type, args);
      }),
    );

    const rpcMethods = this.get(IAgentRPCService);
    this.rpc = this.createPromiseAgentApi(rpcMethods);

    if (options.autoConfigure !== false) {
      this.configure();
    }
  }

  get<T>(id: ServiceIdentifier<T>): T {
    if (id === undefined) {
      throw new Error('AgentTestContext.get called with undefined service id');
    }
    return this.agent.accessor.get(id);
  }

  get modelResolver(): ISessionModelResolver {
    return this.session.accessor.get(ISessionModelResolver);
  }

  get context(): IAgentContextMemoryService {
    return this.get(IAgentContextMemoryService);
  }

  get contextSize(): IAgentContextSizeService {
    return this.get(IAgentContextSizeService);
  }

  get wireRecord(): IAgentWireRecordService {
    return this.get(IAgentWireRecordService);
  }

  async restorePersisted(
    options?: WireRecordRestoreOptions,
  ): Promise<WireRecordRestoreResult> {
    return this.wireRecord.restore(undefined, options);
  }

  private async restoreRecordsOnly(records: readonly PersistedWireRecord[]): Promise<void> {
    await this.wireRecord.restore(records);
  }

  private async closeWireRecord(): Promise<void> {
    await this.wireRecord.flush();
    await this.wireRecord.close();
  }

  private initializeRestorableServices(): void {
    const context = this.get(IAgentContextMemoryService);
    const contextSize = this.get(IAgentContextSizeService);
    const usage = this.get(IAgentUsageService);
    const toolStore = this.get(IAgentToolStoreService);
    const background = this.get(IAgentBackgroundService);
    const permission = this.get(IAgentPermissionGate);
    const permissionMode = this.get(IAgentPermissionModeService);
    const permissionRules = this.get(IAgentPermissionRulesService);
    const cron = this.get(IAgentCronService);
    const plan = this.get(IAgentPlanService);
    const fileTools = this.get(IAgentFileToolsService);
    const shellTools = this.get(IAgentShellToolsService);
    const swarm = this.get(IAgentSwarmService);

    context.get();
    const microCompaction = this.get(IAgentMicroCompactionService);
    void microCompaction;
    void fileTools._serviceBrand;
    void shellTools._serviceBrand;
    void swarm.isActive;
    contextSize.getStatus();
    usage.status();
    toolStore.data();
    background.list(false);
    permission.data();
    void permissionMode.mode;
    void permissionRules.rules;
    cron.list();
    void plan.status();
  }

  configure({
    tools = [],
    provider = MOCK_PROVIDER,
    modelCapabilities,
  }: ConfigureOptions = {}): void {
    this.configureRuntimeModel(provider, modelCapabilities);
    const profile = this.get(IAgentProfileService);
    profile.update({
      cwd: process.cwd(),
      modelAlias: provider.model,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
    });

    if (tools.length > 0) {
      profile.update({ activeToolNames: [...tools] });
    }

    const sessionStarts = this.options['pluginSessionStarts'] as
      | readonly EnabledPluginSessionStart[]
      | undefined;
    const skillCatalog = this.options['skills'] as SkillCatalog | undefined;
    if (
      !this.pluginSessionStartRegistered &&
      sessionStarts !== undefined &&
      skillCatalog !== undefined
    ) {
      this.pluginSessionStartRegistered = true;
      this.get(IAgentContextInjectorService).register(
        'plugin_session_start',
        async () =>
          renderPluginSessionStartReminder(
            sessionStarts,
            skillCatalog,
            this.options['log'] as { warn(message: string, payload?: unknown): void } | undefined,
          ),
        { cadence: 'turn' },
      );
    }

    this.snapshots.drain();
  }

  configureRuntimeModel(
    provider: ProviderConfig,
    modelCapabilities?: ModelCapability | undefined,
  ): void {
    this.kimiConfig = configWithProvider(this.kimiConfig, provider, modelCapabilities);
    const profile = this.get(IAgentProfileService);
    profile.update({ modelAlias: provider.model });
  }

  contextData(): { readonly history: readonly ContextMessage[]; readonly tokenCount: number; } {
    const context = this.get(IAgentContextMemoryService);
    const contextSize = this.get(IAgentContextSizeService);
    return {
      history: context.get(),
      tokenCount: contextSize.getStatus().contextTokens,
    };
  }

  project(messages?: readonly ContextMessage[]) {
    const context = this.get(IAgentContextMemoryService);
    const projector = this.get(IAgentContextProjectorService);
    return projector.project(messages ?? context.get());
  }

  toolsData(): Array<ReturnType<IAgentToolRegistryService['list']>[number] & { readonly active: boolean; }> {
    const profile = this.get(IAgentProfileService);
    const toolRegistry = this.get(IAgentToolRegistryService);
    return toolRegistry.list().map((tool) => ({
      ...tool,
      active: profile.isToolActive(tool.name, tool.source),
    }));
  }

  toolStoreData(): ReturnType<IAgentToolStoreService['data']> {
    const toolStore = this.get(IAgentToolStoreService);
    return toolStore.data();
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
    const rpcMethods = this.get(IAgentRPCService);
    void rpcMethods.clearContext({});
  }

  undoHistory(count: number): number {
    const rpcMethods = this.get(IAgentRPCService);
    return rpcMethods.undoHistory({ count }) as unknown as number;
  }

  newEvents(): EventSnapshot {
    return this.snapshots.drain();
  }

  untilTurnEnd(): Promise<EventSnapshot> {
    return this.snapshots.until('turn.ended');
  }

  untilApprovalRequest(): Promise<EventSnapshot> {
    return this.snapshots.until('requestApproval');
  }

  async takeApprovalRequest(): Promise<{
    events: EventSnapshot;
    respond(response: ApprovalResponse): void;
  }> {
    const approval = await this.snapshots.take<ApprovalResponse>('requestApproval');
    return {
      events: approval.events,
      respond: approval.respond,
    };
  }

  async untilApproval(approved: boolean): Promise<EventSnapshot> {
    const { event, events } = await this.takeUntilRpc('requestApproval');
    this.resolveRpcRequest(event, {
      decision: approved ? 'approved' : 'rejected',
      selectedLabel: approved ? 'approve' : 'reject',
    } satisfies ApprovalResponse);
    return events;
  }

  untilQuestionRequest(): Promise<EventSnapshot> {
    return this.snapshots.until('requestQuestion');
  }

  async untilQuestion(result: QuestionResult): Promise<EventSnapshot> {
    const { event, events } = await this.takeUntilRpc('requestQuestion');
    this.resolveRpcRequest(event, result);
    return events;
  }

  async untilToolCall(result: TestToolResult): Promise<EventSnapshot> {
    const { event, events } = await this.takeUntilRpc('toolCall');
    this.resolveRpcRequest(event, result);
    return events;
  }

  async dispatch(event: PersistedWireRecord): Promise<void> {
    this.suppressWireSnapshot = true;
    try {
      await this.restoreRecordsOnly([event]);
      this.captureRecord(event);
    } finally {
      this.suppressWireSnapshot = false;
    }
  }

  async restore(records: readonly PersistedWireRecord[]): Promise<void> {
    this.suppressWireSnapshot = true;
    try {
      await this.restoreRecordsOnly(records);
    } finally {
      this.suppressWireSnapshot = false;
    }
    for (const record of records) {
      this.captureRecord(record);
    }
  }

  once(type: string): Promise<void> {
    return this.snapshots.once(type);
  }

  onceAny(types: readonly string[]): Promise<string> {
    return this.snapshots.onceAny(types);
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

  compactHistory(): Array<{ readonly role: string; readonly text: string; }> {
    const context = this.get(IAgentContextMemoryService);
    return context.get().map((message) => ({
      role: message.role,
      text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    }));
  }

  async expectResumeMatches(): Promise<void> {
    await this.waitForSessionMetadata();
    await this.drainWirePersistence();
    const profile = this.get(IAgentProfileService);
    const configSnapshot = structuredClone(this.get(IConfigService).getAll() as KimiConfig);
    const resumed = createTestAgent(
      { autoConfigure: false },
      ...this.serviceOverrides,
      createResumeNoSideEffectExecEnv(profile.data().cwd),
      configServices(() => configSnapshot),
      llmGenerateServices(failOnResumeGenerate),
      wireRecordPersistenceServices(new InMemoryWireRecordPersistence(
        withMetadata(this.recordHistory.map(cloneRecord)),
      )),
    );

    try {
      await resumed.restorePersisted();
      await resumed.waitForSessionMetadata();

      // oxlint-disable-next-line jest/no-standalone-expect
      expect(resumeStateSnapshot(resumed)).toEqual(resumeStateSnapshot(this));
    } finally {
      await resumed.waitForSessionMetadata();
      await resumed.dispose();
    }
  }

  private async waitForSessionMetadata(): Promise<void> {
    await this.session.accessor.get(ISessionMetadata).ready;
  }

  private async drainWirePersistence(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    const wireRecord = this.get(IAgentWireRecordService);
    await wireRecord.flush();
  }

  async close(_reason = 'Agent runtime test closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    await this.closeWireRecord();
    this.root.dispose();
  }

  async dispose(): Promise<void> {
    await this.close();
  }

  private takeUntilRpc(method: string): Promise<{
    event: RecordedEventEntry;
    events: EventSnapshot;
  }> {
    return this.snapshots.take(method);
  }

  private recordWire(event: PersistedWireRecord): WireSnapshotEntry {
    const entry = this.snapshots.recordWire(event);
    this.emitter.emit(entry.event, entry);
    this.emitter.emit('event', entry);
    return entry;
  }

  private recordRpc(
    method: string,
    args: unknown,
    response?: RpcPromise<unknown>,
  ): RecordedEventEntry {
    const entry = this.snapshots.recordEmit(method, args, response);
    this.emitter.emit(method, entry);
    this.emitter.emit('event', entry);
    return entry;
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

  private resolveRpcRequest(event: RecordedEventEntry, result: unknown): void {
    this.snapshots.respond(event, result);
  }

  private resolvePendingRpc(method: string, id: string, result: unknown): void {
    this.snapshots.respondPending(method, id, result);
  }

  private createInteractionService(): ISessionInteractionService {
    const pending = new Map<string, Interaction>();
    function createTestInteraction<TPayload>(
      request: InteractionRequest<TPayload>,
    ): Interaction<TPayload> {
      return {
        id: request.id ?? 'interaction:test',
        kind: request.kind,
        payload: request.payload,
        origin: request.origin ?? {},
        createdAt: Date.now(),
      };
    }
    return {
      _serviceBrand: undefined,
      request: <TPayload, TResponse>(request: InteractionRequest<TPayload>) => {
        if (request.kind !== 'user_tool') {
          throw new Error(`Unsupported test interaction kind: ${request.kind}`);
        }
        const interaction = createTestInteraction(request);
        pending.set(interaction.id, interaction);
        const payload = request.payload as UserToolInteractionPayload;
        const promise = this.createRpcPromise<ToolResult>();
        promise.then(
          () => pending.delete(interaction.id),
          () => pending.delete(interaction.id),
        );
        this.recordRpc(
          'toolCall',
          {
            turnId: payload.turnId,
            toolCallId: payload.toolCallId,
            args: payload.args,
          },
          promise,
        );
        return promise as unknown as Promise<TResponse>;
      },
      enqueue: <TPayload>(request: InteractionRequest<TPayload>): Interaction<TPayload> => {
        const interaction = createTestInteraction(request);
        pending.set(interaction.id, interaction);
        if (request.kind === 'user_tool') {
          const payload = request.payload as UserToolInteractionPayload;
          this.recordRpc('toolCall', {
            turnId: payload.turnId,
            toolCallId: payload.toolCallId,
            args: payload.args,
          });
        }
        return interaction;
      },
      respond: (id, response) => {
        pending.delete(id);
        this.resolvePendingRpc('toolCall', id, response);
      },
      listPending: (kind) => {
        const interactions = [...pending.values()];
        return kind === undefined
          ? interactions
          : interactions.filter((interaction) => interaction.kind === kind);
      },
      isRecentlyResolved: () => false,
      onDidChangePending: Event.None as Event<InteractionPendingChangedEvent>,
      onDidResolve: Event.None as Event<InteractionResolution>,
    };
  }

  private createApprovalService(): ISessionApprovalService {
    return {
      _serviceBrand: undefined,
      request: (request) => {
        const { sessionId: _sessionId, agentId: _agentId, ...payload } = request;
        const promise = this.createRpcPromise<ApprovalResponse>();
        this.recordRpc('requestApproval', payload, promise);
        return promise;
      },
      enqueue: (request) => {
        const id = request.id ?? request.toolCallId ?? `${request.toolName}:test`;
        const { sessionId: _sessionId, agentId: _agentId, ...payload } = { ...request, id };
        this.recordRpc('requestApproval', payload);
        return { ...request, id };
      },
      decide: (id, response) => {
        this.resolvePendingRpc('requestApproval', id, response);
      },
      listPending: () => [],
    };
  }

  private createQuestionService(): ISessionQuestionService {
    return {
      _serviceBrand: undefined,
      request: (request) => {
        const promise = this.createRpcPromise<QuestionResult>();
        this.recordRpc('requestQuestion', request, promise);
        return promise;
      },
      enqueue: (request) => {
        const id = request.id ?? request.toolCallId ?? 'question:test';
        const payload = { ...request, id };
        this.recordRpc('requestQuestion', payload);
        return payload;
      },
      answer: (id, response) => {
        this.resolvePendingRpc('requestQuestion', id, response);
      },
      dismiss: (id) => {
        this.resolvePendingRpc('requestQuestion', id, null);
      },
      listPending: () => [],
    };
  }

  private captureRecord(event: PersistedWireRecord): void {
    const cloned = cloneRecord(event);
    this.recordHistory.push(cloned);
    if (this.suppressWireSnapshot) return;

    this.recordWire(cloned);
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
    const context = this.get(IAgentContextMemoryService);
    context.splice(context.get().length, 0, messages);
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
    const context = this.get(IAgentContextMemoryService);
    const contextSize = this.get(IAgentContextSizeService);
    contextSize.measured(context.get().length, tokenTotal);
    const profile = this.get(IAgentProfileService);
    const usageService = this.get(IAgentUsageService);
    usageService.record(profile.data().modelAlias ?? 'mock-model', usage, {
      type: 'turn',
      turnId: context.get().length,
    });
  }
}

function createWorkspaceContextStub(
  initialWorkDir: string,
  initialAdditionalDirs: readonly string[],
): ISessionWorkspaceContext {
  let workDir = resolve(initialWorkDir);
  let additionalDirs = initialAdditionalDirs.map((dir) => resolve(dir));
  const isWithin = (absPath: string): boolean => {
    const target = resolve(absPath);
    if (target === workDir) return true;
    const rel = relative(workDir, target);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true;
    return additionalDirs.some((dir) => {
      const r = relative(dir, target);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    });
  };
  return {
    _serviceBrand: undefined,
    get workDir() {
      return workDir;
    },
    get additionalDirs() {
      return additionalDirs;
    },
    setWorkDir: (next) => {
      workDir = resolve(next);
    },
    resolve: (path) => isAbsolute(path) ? resolve(path) : resolve(workDir, path),
    isWithin,
    assertAllowed: (absPath: string, op: PathAccessOperation) => {
      const target = isAbsolute(absPath) ? resolve(absPath) : resolve(workDir, absPath);
      if (!isWithin(target)) {
        throw new Error(`Path outside workspace (${op}): ${target}`);
      }
      return target;
    },
    addAdditionalDir: (dir) => {
      const resolved = resolve(dir);
      if (!additionalDirs.includes(resolved)) additionalDirs = [...additionalDirs, resolved];
    },
    removeAdditionalDir: (dir) => {
      const resolved = resolve(dir);
      additionalDirs = additionalDirs.filter((candidate) => candidate !== resolved);
    },
  };
}

function createPermissionModeService(initialMode: PermissionMode): IAgentPermissionModeService {
  let mode = initialMode;
  const emptyHook = {
    register: () => toDisposable(() => {}),
    run: () => Promise.resolve(),
  };
  return {
    _serviceBrand: undefined,
    get mode() {
      return mode;
    },
    setMode: (nextMode) => {
      mode = nextMode;
    },
    hooks: {
      onChanged: emptyHook,
    } as unknown as IAgentPermissionModeService['hooks'],
  };
}

function createPermissionRulesStub(
  initialRules: readonly PermissionRule[],
): IAgentPermissionRulesService {
  let rules = [...initialRules];
  const emptyHook = {
    register: () => ({ dispose: () => {} }),
    run: () => Promise.resolve(),
  };
  return {
    _serviceBrand: undefined,
    get rules() {
      return rules;
    },
    get sessionApprovalRulePatterns() {
      return [];
    },
    addRules: (nextRules) => {
      rules = [...rules, ...nextRules];
    },
    recordApprovalResult: () => {},
    hooks: {
      onChanged: emptyHook,
      onApprovalRecorded: emptyHook,
    } as unknown as IAgentPermissionRulesService['hooks'],
  };
}

function createTerminalBackend(): ISessionTerminalBackend {
  return {
    _serviceBrand: undefined,
    spawn: async () => ({
      onData: Event.None as Event<string>,
      onExit: Event.None as Event<{ exitCode: number | null; }>,
      write: () => {},
      resize: () => {},
      kill: () => {},
    }),
  };
}

function unavailableAgentToolRun(): AgentToolRunOverride {
  const fail = async (): Promise<never> => {
    throw new Error('Agent tool run is not configured in this test.');
  };
  return {
    spawn: fail,
    resume: fail,
    retry: fail,
    getProfileName: async () => undefined,
  };
}

const failOnResumeGenerate: GenerateFn = async () => {
  throw new Error('Resume replay unexpectedly called the LLM');
};

function createResumeNoSideEffectExecEnv(initialCwd: string): TestAgentServiceOverride {
  return execEnvServices({
    execContext: { cwd: initialCwd },
    // Any fs/process interaction during a resume replay is a bug — surface it
    // loudly instead of silently no-oping.
  });
}

function resumeStateSnapshot(ctx: AgentTestContext): ResumeStateSnapshot {
  const background = ctx.get(IAgentBackgroundService);
  const usage = ctx.get(IAgentUsageService);
  const toolStore = ctx.get(IAgentToolStoreService);
  const permission = ctx.get(IAgentPermissionGate);
  return {
    background: normalizeBackgroundSnapshot(background.list(false)),
    config: configStateSnapshot(ctx),
    context: resumeContextSnapshot(ctx),
    permission: permission.data(),
    toolStore: toolStore.data(),
    usage: usage.status(),
  };
}

function normalizeBackgroundSnapshot(
  background: readonly BackgroundTaskInfo[],
): readonly BackgroundTaskInfo[] {
  return background
    .map((task) => stripUndefinedFields(task) as BackgroundTaskInfo)
    .toSorted(
      (left, right) => left.startedAt - right.startedAt || left.taskId.localeCompare(right.taskId),
    );
}

function stripUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}

function resumeContextSnapshot(ctx: AgentTestContext) {
  const context = ctx.contextData();
  return {
    ...context,
    history: context.history
      .filter((message) => !isSystemReminderMessage(message))
      .map(stripMessageId),
  };
}

function stripMessageId(message: ContextMessage): ContextMessage {
  if (message.id === undefined) return message;
  const { id: _id, ...rest } = message;
  return rest as ContextMessage;
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
  const profile = ctx.get(IAgentProfileService);
  const data = profile.data();
  return {
    cwd: data.cwd,
    activeToolNames: data.activeToolNames,
    provider: data.provider,
    profileName: data.profileName,
    thinkingLevel: data.thinkingLevel,
    systemPrompt: data.systemPrompt,
  };
}

function emptyConfig(): KimiConfig {
  return configWithProvider({ providers: {} }, MOCK_PROVIDER, undefined);
}

function applyTestAgentOptionsToConfig(
  config: KimiConfig,
  options: TestAgentOptions,
): KimiConfig {
  const initialConfig = options.initialConfig ?? {};
  return {
    ...config,
    ...initialConfig,
    providers: {
      ...config.providers,
      ...initialConfig.providers,
    },
    models: {
      ...config.models,
      ...initialConfig.models,
    },
    [MICRO_COMPACTION_SECTION]:
      options.microCompaction?.config ??
      initialConfig[MICRO_COMPACTION_SECTION] ??
      config[MICRO_COMPACTION_SECTION],
  };
}

function configService(readConfig: () => KimiConfig): IConfigService {
  const effectiveConfig = () => configWithEnvOverrides(readConfig());
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    onDidSectionChange: () => ({ dispose: () => {} }),
    get: <T>(domain: string) => (effectiveConfig() as Record<string, unknown>)[domain] as T,
    inspect: (domain: string) => {
      const value = (effectiveConfig() as Record<string, unknown>)[domain];
      return {
        value,
        defaultValue: undefined,
        userValue: undefined,
        memoryValue: value,
      };
    },
    getAll: () => effectiveConfig() as never,
    set: () => Promise.resolve(),
    replace: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    diagnostics: () => [],
  } as unknown as IConfigService;
}

function configWithEnvOverrides(config: KimiConfig): KimiConfig {
  const maxCompletionTokens =
    parseEnvCompletionTokens(process.env['KIMI_MODEL_MAX_COMPLETION_TOKENS']) ??
    parseEnvCompletionTokens(process.env['KIMI_MODEL_MAX_TOKENS']);
  const temperature = parseEnvFloat(process.env['KIMI_MODEL_TEMPERATURE']);
  const topP = parseEnvFloat(process.env['KIMI_MODEL_TOP_P']);
  const thinkingKeep = process.env['KIMI_MODEL_THINKING_KEEP']?.trim();
  const cron = cronEnvOverrides(asMutableRecord(config['cron']));
  if (
    maxCompletionTokens === undefined &&
    temperature === undefined &&
    topP === undefined &&
    (thinkingKeep === undefined || thinkingKeep.length === 0) &&
    cron === undefined
  ) {
    return config;
  }
  const modelOverrides = asMutableRecord(config['modelOverrides']);
  if (temperature !== undefined) modelOverrides['temperature'] = temperature;
  if (topP !== undefined) modelOverrides['topP'] = topP;
  if (thinkingKeep !== undefined && thinkingKeep.length > 0) {
    modelOverrides['thinkingKeep'] = thinkingKeep;
  }
  if (maxCompletionTokens !== undefined) {
    modelOverrides['maxCompletionTokens'] = maxCompletionTokens;
  }
  return {
    ...config,
    cron: cron ?? config['cron'],
    modelOverrides,
  };
}

function cronEnvOverrides(base: Record<string, unknown>): Record<string, unknown> | undefined {
  const next = { ...base };
  let changed = false;
  const setBoolean = (key: string, envName: string) => {
    const value = parseEnvBoolean(process.env[envName]);
    if (value === undefined) return;
    next[key] = value;
    changed = true;
  };
  setBoolean('debug', 'KIMI_CRON_DEBUG');
  setBoolean('noJitter', 'KIMI_CRON_NO_JITTER');
  setBoolean('noStale', 'KIMI_CRON_NO_STALE');
  setBoolean('disabled', 'KIMI_DISABLE_CRON');
  setBoolean('manualTick', 'KIMI_CRON_MANUAL_TICK');
  const pollIntervalMs = parseEnvCronPollIntervalMs(process.env['KIMI_CRON_POLL_INTERVAL_MS']);
  if (pollIntervalMs !== undefined) {
    next['pollIntervalMs'] = pollIntervalMs;
    changed = true;
  }
  if (process.env['KIMI_CRON_CLOCK'] !== undefined) {
    next['clock'] = process.env['KIMI_CRON_CLOCK'];
    changed = true;
  }
  return changed ? next : undefined;
}

function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return raw === '1';
}

function parseEnvCronPollIntervalMs(raw: string | undefined): number | null | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (value === 'null') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function parseEnvCompletionTokens(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
  return parsed;
}

function parseEnvFloat(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? { ...(value as Record<string, unknown>) }
    : {};
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
    defaultProvider: providerName,
    defaultModel: provider.model,
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

function createLogService(
  logger: Logger | undefined,
  bindings: LogContext = {},
): ILogService {
  let level: LogLevel = 'debug';
  return {
    _serviceBrand: undefined,
    get level() {
      return level;
    },
    setLevel: (next) => {
      level = next;
    },
    info: (message, payload) => {
      writeLog(logger, 'info', message, payload, bindings);
    },
    warn: (message, payload) => {
      writeLog(logger, 'warn', message, payload, bindings);
    },
    error: (message, payload) => {
      writeLog(logger, 'error', message, payload, bindings);
    },
    debug: (message, payload) => {
      writeLog(logger, 'debug', message, payload, bindings);
    },
    child: (childBindings) => createLogService(
      logger?.child?.(childBindings) ?? logger?.createChild?.(childBindings) ?? logger,
      { ...bindings, ...childBindings },
    ),
    flush: () => Promise.resolve(),
  };
}

function createGenerateBackedChatProviderFactory(generate: GenerateFn): IChatProviderFactory {
  return {
    _serviceBrand: undefined,
    create: (config) =>
      config.type === 'kimi'
        ? new GenerateBackedKimiChatProvider(config, generate)
        : new GenerateBackedChatProvider(config, generate),
    register: () => {},
  };
}

class GenerateBackedKimiChatProvider extends KimiChatProvider {
  constructor(
    config: Extract<ProviderConfig, { type: 'kimi' }>,
    private readonly generateFn: GenerateFn,
  ) {
    super(config);
  }

  override async generate(
    systemPrompt: string,
    tools: KosongTool[],
    history: KosongMessage[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    return generateBackedResponse(
      this,
      this.generateFn,
      systemPrompt,
      tools,
      history,
      options,
    );
  }
}

class GenerateBackedChatProvider implements ChatProvider {
  readonly name: string;
  readonly modelName: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly generateFn: GenerateFn,
    readonly thinkingEffort: ThinkingEffort | null = null,
    readonly modelParameters: Record<string, unknown> = modelParametersFromConfig(config),
  ) {
    this.name = config.type;
    this.modelName = modelNameFromConfig(config);
  }

  async generate(
    systemPrompt: string,
    tools: KosongTool[],
    history: KosongMessage[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    return generateBackedResponse(
      this,
      this.generateFn,
      systemPrompt,
      tools,
      history,
      options,
    );
  }

  withThinking(effort: ThinkingEffort): ChatProvider {
    return new GenerateBackedChatProvider(
      this.config,
      this.generateFn,
      effort,
      this.modelParameters,
    );
  }

  withMaxCompletionTokens(maxCompletionTokens: number): ChatProvider {
    return new GenerateBackedChatProvider(
      this.config,
      this.generateFn,
      this.thinkingEffort,
      {
        ...this.modelParameters,
        [completionBudgetParamName(this.config.type)]: maxCompletionTokens,
      },
    );
  }
}

async function generateBackedResponse(
  provider: ChatProvider,
  generateFn: GenerateFn,
  systemPrompt: string,
  tools: KosongTool[],
  history: KosongMessage[],
  options?: GenerateOptions,
): Promise<StreamedMessage> {
  const parts: StreamedMessagePart[] = [];
  const result = await generateFn(
    provider,
    systemPrompt,
    tools,
    history,
    {
      onMessagePart: (part) => {
        parts.push(structuredClone(part));
      },
    },
    {
      signal: options?.signal,
      auth: options?.auth,
    },
  );
  return createStreamedMessage(
    parts.length > 0
      ? normalizeProviderStreamParts(parts)
      : partsFromGeneratedMessage(result.message),
    {
      id: result.id,
      usage: result.usage,
      finishReason: result.finishReason,
      rawFinishReason: result.rawFinishReason,
    },
  );
}

function modelParametersFromConfig(config: ProviderConfig): Record<string, unknown> {
  return {
    model: modelNameFromConfig(config),
    baseUrl: 'baseUrl' in config ? config.baseUrl : undefined,
    ...('generationKwargs' in config ? config.generationKwargs : undefined),
  };
}

function modelNameFromConfig(config: ProviderConfig): string {
  return 'model' in config ? config.model : 'test-model';
}

function completionBudgetParamName(type: ProviderConfig['type']): string {
  if (type === 'kimi') return 'max_completion_tokens';
  if (type === 'openai_responses') return 'max_output_tokens';
  return 'max_tokens';
}

function partsFromGeneratedMessage(message: Awaited<ReturnType<GenerateFn>>['message']): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [
    ...message.content.map((part) => structuredClone(part)),
    ...message.toolCalls.map((part) => structuredClone(part)),
  ];
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function normalizeProviderStreamParts(parts: readonly StreamedMessagePart[]): StreamedMessagePart[] {
  const normalized: StreamedMessagePart[] = [];
  const pendingIndexedDeltas = new Map<number | string, StreamedMessagePart[]>();
  const seenIndexes = new Set<number | string>();

  for (const part of parts) {
    if (isToolCallPart(part) && part.index !== undefined && !seenIndexes.has(part.index)) {
      const pending = pendingIndexedDeltas.get(part.index) ?? [];
      pending.push(structuredClone(part));
      pendingIndexedDeltas.set(part.index, pending);
      continue;
    }

    normalized.push(structuredClone(part));

    if (isToolCall(part) && part._streamIndex !== undefined) {
      seenIndexes.add(part._streamIndex);
      const pending = pendingIndexedDeltas.get(part._streamIndex);
      if (pending !== undefined) {
        pendingIndexedDeltas.delete(part._streamIndex);
        normalized.push(...pending);
      }
    }
  }

  for (const pending of pendingIndexedDeltas.values()) {
    normalized.push(...pending);
  }

  return normalized;
}

function createStreamedMessage(
  parts: readonly StreamedMessagePart[],
  meta: Pick<
    Awaited<ReturnType<GenerateFn>>,
    'id' | 'usage' | 'finishReason' | 'rawFinishReason'
  >,
): StreamedMessage {
  return {
    id: meta.id,
    usage: meta.usage,
    finishReason: meta.finishReason ?? null,
    rawFinishReason: meta.rawFinishReason ?? null,
    async *[Symbol.asyncIterator]() {
      for (const part of parts) {
        yield structuredClone(part);
      }
    },
  };
}

function writeLog(
  logger: Logger | undefined,
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  payload: unknown,
  bindings: LogContext,
): void {
  if (logger === undefined) return;
  const hasBindings = Object.keys(bindings).length > 0;
  const mergedPayload = hasBindings
    ? payload === undefined
      ? bindings
      : { ...bindings, payload }
    : payload;
  logger[level](message, mergedPayload);
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
