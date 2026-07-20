import { EventEmitter } from 'node:events';
import { isAbsolute, relative, resolve } from 'node:path';
import { Readable, type Writable } from 'node:stream';

import { createControlledPromise } from '@antfu/utils';
import { expect, vi } from 'vitest';

import { toDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { PromisifyMethods } from '#/_base/utils/types';
import { escapeXmlAttr } from '#/_base/utils/xml-escape';
import type { AgentTaskInfo } from '#/agent/task/task';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { AgentBlobServiceImpl } from '#/agent/blob/agentBlobServiceImpl';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { SessionCronServiceImpl } from '#/session/cron/sessionCronServiceImpl';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { CronTaskPersistenceService } from '#/app/cron/cronTaskPersistenceService';
import { IAgentGoalService } from '#/agent/goal/goal';
import { AgentGoalService } from '#/agent/goal/goalService';
import { ISessionMcpService } from '#/session/mcp/sessionMcp';
import type { McpConnectionManager } from '#/agent/mcp/connection-manager';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { PermissionRule } from '#/agent/permissionRules/permissionRules';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { AgentAPI } from '#/agent/rpc/core-api';
import { IAgentSkillService } from '#/agent/skill/skill';
import { AgentSkillService } from '#/agent/skill/skillService';
import { IAgentToolDedupeService } from '#/agent/toolDedupe/toolDedupe';
import type {
  ExecutableToolOutput as ToolOutput,
  ExecutableToolResult,
} from '#/tool/toolContract';
import { AGENT_WIRE_RECORD_KEY, wireRecordToPayload, type WireRecord } from '#/wire/record';
import { OP_REGISTRY } from '#/wire/op';
import { IOAuthService } from '#/app/auth/auth';
import { IProtocolAdapterRegistry, type ProtocolAdapterConfig } from '#/app/protocol/protocol';
import type { SkillCatalog } from '#/app/skillCatalog/types';
import { type ModelCapability } from '#/app/llmProtocol/capability';
import { isToolCall, isToolCallPart, type ContentPart, type Message as KosongMessage, type StreamedMessagePart } from '#/app/llmProtocol/message';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { type Tool as KosongTool } from '#/app/llmProtocol/tool';
import type { generate as kosongGenerate } from '#/app/llmProtocol/generate';
import type { ChatProvider, GenerateOptions, StreamedMessage } from '#/app/llmProtocol/provider';
import type { ProviderConfig } from '#/app/llmProtocol/providers/providers';
import { KimiChatProvider } from '#/app/llmProtocol/providers/kimi';
import type { ILogger, LogContext, LogLevel } from '#/_base/log/log';
import { ILogOptions } from '#/_base/log/logConfig';
import type { EnabledPluginSessionStart } from '#/app/plugin/types';
import {
  WIRE_PROTOCOL_VERSION,
  AgentTaskService,
  AgentExternalHooksService,
  FileStorageService,
  InMemoryStorageService,
  AgentFullCompactionService,
  IAgentActivityView,
  IAgentRPCService,
  IAppendLogStore,
  IFileSystemStorageService,
  ISessionApprovalService,
  ISessionMetadata,
  IAgentTaskService,
  IBlobStore,
  BlobStoreService,
  IBootstrapService,
  IConfigService,
  IAgentContextMemoryService,
  IAgentContextProjectorService,
  IAgentContextSizeService,
  IAgentExternalHooksService,
  IExternalHooksRunnerService,
  IAgentFullCompactionService,
  IAgentLLMRequesterService,
  ILogService,
  IAgentPermissionGate,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IHostFileSystem,
  ISessionContext,
  ISessionProcessRunner,
  IAgentScopeContext,
  IAgentStepRetryService,
  IAgentLoopContinuationService,
  IAgentSwarmService,
  AgentSwarmService,
  ITelemetryService,
  IHostTerminalService,
  IAgentToolRegistryService,
  IAgentBuiltinToolsRegistrar,
  IAgentUserToolService,
  IAgentUsageService,
  ISessionWorkspaceContext,
  AgentLLMRequesterService,
  LifecycleScope,
  AgentMcpService,
  AgentPermissionGate,
  AgentPermissionRulesService,
  AgentProfileService,
  SyncDescriptor,
  AgentUserToolService,
  SessionWorkspaceContextService,
  bootstrap,
  bootstrapSeed,
  createAppScope,
  resolveBootstrapOptions,
  type IDisposable,
  type Scope,
  type ScopeSeed,
  type ServiceIdentifier,
} from '#/index';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';
import { WireService } from '#/wire/wireService';
import { IModelService } from '#/app/model/model';
import { type Model } from '#/app/model/modelInstance';
import { IHostRequestHeaders } from '#/app/model/hostRequestHeaders';
import { IModelResolver } from '#/app/model/modelResolver';
import { ModelResolverService } from '#/app/model/modelResolverService';
import { IPlatformService } from '#/app/platform/platform';
import { IProviderService } from '#/app/provider/provider';
import type { ApprovalResponse } from '#/session/approval/approval';
import {
  ISessionInteractionService,
  type Interaction,
  type InteractionRequest,
  type InteractionPendingChangedEvent,
  type InteractionResolution,
} from '#/session/interaction/interaction';
import type { IProcess } from '#/session/process/processRunner';
import { ISessionQuestionService, type QuestionResult } from '#/session/question/question';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionSwarmService } from '#/session/swarm/sessionSwarm';
import type { PathAccessOperation } from '#/session/workspaceContext/workspaceContext';

import { recordAgentEvents, type RecordedEventEntry } from '../snapshot/events';
import { createFakeHostFs, createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import { createScriptedGenerate } from './scripted-generate';
import {
  DEFAULT_TEST_SYSTEM_PROMPT,
  type EventSnapshot,
  type EventSnapshotEntry,
  type WireSnapshotEntry,
} from './snapshots';

const TEST_HOME_DIR = '/home/test';

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.test/v1',
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
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
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

export interface WireRecordPersistence {
  readonly records: readonly WireRecord[];
  read(): AsyncIterable<WireRecord>;
  append(event: WireRecord): void;
  rewrite(records: readonly WireRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryWireRecordPersistence implements WireRecordPersistence {
  readonly records: WireRecord[];

  constructor(records: readonly WireRecord[] = []) {
    this.records = records.map(cloneRecord);
  }

  async *read(): AsyncIterable<WireRecord> {
    for (const record of this.records) {
      yield cloneRecord(record);
    }
  }

  append(event: WireRecord): void {
    this.records.push(cloneRecord(event));
  }

  rewrite(records: readonly WireRecord[]): void {
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

type TestToolResult = ExecutableToolResult & {
  readonly content?: unknown;
};

interface UserToolInteractionPayload {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly args: unknown;
}

interface ResumeStateSnapshot {
  readonly config: {
    readonly cwd: string;
    readonly activeToolNames: readonly string[] | undefined;
    readonly provider: ReturnType<IProviderService['get']>;
    readonly profileName: string | undefined;
    readonly thinkingLevel: string;
    readonly systemPrompt: string;
  };
  readonly context: {
    readonly history: readonly ContextMessage[];
  };
  readonly permission: Omit<ReturnType<IAgentPermissionGate['data']>, 'rules'>;
  readonly usage: Omit<ReturnType<IAgentUsageService['status']>, 'currentTurn'>;
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
  readonly hookEngine?:
  | Pick<IExternalHooksRunnerService, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'>
  | undefined;
  readonly initialConfig?: Partial<KimiConfig> | undefined;
  readonly autoConfigure?: boolean | undefined;
  readonly cwd?: string | undefined;
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

export interface ExecEnvOverride {
  readonly hostFs?: IHostFileSystem | Partial<IHostFileSystem>;
  readonly processRunner?: ISessionProcessRunner | Partial<ISessionProcessRunner>;
}

export function execEnvServices(override: ExecEnvOverride = {}): TestAgentServiceOverride {
  const session = sessionServices((reg) => {
    if (override.processRunner !== undefined) {
      reg.defineInstance(
        ISessionProcessRunner,
        resolveProcessRunnerOverride(override.processRunner),
      );
    }
    reg.defineDescriptor(
      ISessionWorkspaceContext,
      new SyncDescriptor(SessionWorkspaceContextService),
    );
  });
  if (override.hostFs === undefined) return session;

  const hostFs = resolveHostFsOverride(override.hostFs);
  return [
    appServices((reg) => {
      reg.defineInstance(IHostFileSystem, hostFs);
    }),
    session,
  ];
}

function resolveHostFsOverride(input: IHostFileSystem | Partial<IHostFileSystem>): IHostFileSystem {
  if (isFullHostFs(input)) return input as IHostFileSystem;
  return createFakeHostFs(input as Partial<IHostFileSystem>);
}

function isFullHostFs(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const keys: readonly (keyof IHostFileSystem)[] = [
    'readText',
    'writeText',
    'appendText',
    'readBytes',
    'writeBytes',
    'readLines',
    'createExclusive',
    'stat',
    'readdir',
    'mkdir',
    'remove',
  ];
  return keys.every((k) => typeof (input as Record<string, unknown>)[k] === 'function');
}

function resolveProcessRunnerOverride(
  input: ISessionProcessRunner | Partial<ISessionProcessRunner>,
): ISessionProcessRunner {
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
      for (const [id, value] of bootstrapSeed({
        homeDir,
        cwd: process.cwd(),
        env: process.env,
      })) {
        reg.defineInstance(id, value);
      }
      const file = (): SyncDescriptor<IFileSystemStorageService> =>
        new SyncDescriptor(FileStorageService, [homeDir], true);
      reg.defineDescriptor(IFileSystemStorageService, file());
      reg.define(IBlobStore, BlobStoreService);
    }
  });
}

export function hostEnvironmentServices(homeDir: string): TestAgentServiceOverride {
  return appServices((reg) => {
    reg.defineInstance(
      IHostEnvironment,
      {
        _serviceBrand: undefined,
        osKind: 'Linux',
        osArch: 'x64',
        osVersion: 'test',
        shellName: 'bash',
        shellPath: '/bin/bash',
        pathClass: 'posix',
        homeDir,
        ready: Promise.resolve(),
      } satisfies IHostEnvironment,
    );
  });
}

export function additionalDirServices(additionalDirs: readonly string[]): TestAgentServiceOverride {
  return sessionServices((reg) => {
    reg.defineInstance(
      ISessionWorkspaceContext,
      createWorkspaceContextStub(process.cwd(), additionalDirs),
    );
  });
}

export function modelProviderServices(
  modelResolver: IModelResolver,
): TestAgentServiceOverride {
  return appService(IModelResolver, modelResolver);
}

export function modelProviderOptionServices(
  options: TestModelProviderOptions,
): TestAgentServiceOverride {
  return appService(
    IModelResolver,
    new SyncDescriptor(ConfigBackedModelResolver, [options]),
  );
}

export function configServices(readConfig: () => KimiConfig): TestAgentServiceOverride {
  return appService(IConfigService, configService(readConfig));
}

export function wireRecordPersistenceServices(
  persistence: WireRecordPersistence,
  onRead: (event: WireRecord) => void = () => { },
): TestAgentServiceOverride {
  return appService(IAppendLogStore, new PersistenceAppendLogStore(persistence, () => { }, onRead));
}

export function logServices(logger: Logger): TestAgentServiceOverride {
  return [
    appService(ILogService, createLogService(logger)),
    sessionService(ILogService, createLogService(logger)),
  ];
}

export function llmGenerateServices(generate: GenerateFn): TestAgentServiceOverride {
  return appService(IProtocolAdapterRegistry, createGenerateBackedProtocolRegistry(generate));
}

export function telemetryServices(telemetry: ITelemetryService): TestAgentServiceOverride {
  return appService(ITelemetryService, telemetry);
}

export function questionServices(service: ISessionQuestionService): TestAgentServiceOverride {
  return sessionService(ISessionQuestionService, service);
}

export function externalHookServices(
  hookRunner: Pick<IExternalHooksRunnerService, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'> | undefined,
): TestAgentServiceOverride {
  return [
    appService(IExternalHooksRunnerService, resolveExternalHooksRunner(hookRunner)),
    agentService(IAgentExternalHooksService, new SyncDescriptor(AgentExternalHooksService)),
  ];
}

function resolveExternalHooksRunner(
  hookRunner: Pick<IExternalHooksRunnerService, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'> | undefined,
): IExternalHooksRunnerService {
  return hookRunner === undefined
    ? noopHookRunner
    : isRunnerLike(hookRunner)
      ? hookRunner
      : { ...noopHookRunner, ...hookRunner };
}

function isRunnerLike(
  value: Pick<IExternalHooksRunnerService, 'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'>,
): value is IExternalHooksRunnerService {
  return (
    typeof value.trigger === 'function' &&
    typeof value.triggerBlock === 'function' &&
    typeof value.fireAndForgetTrigger === 'function'
  );
}

const noopHookRunner: IExternalHooksRunnerService = {
  _serviceBrand: undefined,
  trigger: async () => [],
  triggerBlock: async () => undefined,
  fireAndForgetTrigger: async () => [],
};

export function permissionModeServices(mode: PermissionMode): TestAgentServiceOverride {
  return agentService(IAgentPermissionModeService, createPermissionModeService(mode));
}

export function permissionRulesServices(
  rules: readonly PermissionRule[],
): TestAgentServiceOverride {
  return agentService(IAgentPermissionRulesService, createPermissionRulesStub(rules));
}

export function taskServices(): TestAgentServiceOverride {
  return agentService(IAgentTaskService, new SyncDescriptor(AgentTaskService));
}

export function cronServices(): TestAgentServiceOverride {
  return sessionService(ISessionCronService, new SyncDescriptor(SessionCronServiceImpl));
}

export function mcpServices(options: {
  readonly manager?: McpConnectionManager;
}): TestAgentServiceOverride {
  // `AgentMcpService` now resolves the session's shared manager through
  // `ISessionMcpService`; tests inject a fake manager by stubbing that service.
  return sessionService(ISessionMcpService, {
    _serviceBrand: undefined,
    ensureMcpReady: () => Promise.resolve(),
    connectionManager: () => options.manager!,
  } satisfies ISessionMcpService);
}

export function skillServices(
  input: ISessionSkillCatalog | SkillCatalog,
): TestAgentServiceOverride {
  const catalogService = isSessionSkillCatalog(input) ? input : createSessionSkillCatalog(input);
  return [
    sessionService(ISessionSkillCatalog, catalogService),
    agentService(IAgentSkillService, new SyncDescriptor(AgentSkillService)),
  ];
}

function isSessionSkillCatalog(
  input: ISessionSkillCatalog | SkillCatalog,
): input is ISessionSkillCatalog {
  return 'catalog' in input;
}

function createSessionSkillCatalog(catalog: SkillCatalog): ISessionSkillCatalog {
  return {
    _serviceBrand: undefined,
    catalog,
    ready: Promise.resolve(),
    onDidChange: Event.None as Event<string>,
    load: async () => { },
    reload: async () => { },
  };
}

export function swarmServices(
  swarmService: ISessionSwarmService | ISessionSwarmService['run'],
): TestAgentServiceOverride {
  const service =
    typeof swarmService === 'function'
      ? {
          _serviceBrand: undefined,
          getSwarmItem: async () => undefined,
          run: swarmService,
          cancel: () => {},
        } satisfies ISessionSwarmService
      : swarmService;
  return [
    sessionService(ISessionSwarmService, service),
    agentService(IAgentSwarmService, new SyncDescriptor(AgentSwarmService)),
  ];
}

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

function normalizeTestAgentInputs(inputs: readonly TestAgentInput[]): {
  readonly options: TestAgentOptions;
  readonly overrides: readonly TestAgentServiceOverride[];
} {
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

function mergeTestAgentOptions(base: TestAgentOptions, next: TestAgentOptions): TestAgentOptions {
  return {
    ...base,
    ...next,
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
  private readonly history: WireRecord[] = [];

  constructor(
    private readonly persistence: WireRecordPersistence,
    private readonly onAppend: (event: WireRecord) => void,
    private readonly onRead: (event: WireRecord) => void,
  ) { }

  append<R>(_scope: string, _key: string, record: R): void {
    const event = record as WireRecord;
    this.onAppend(event);
    this.persistence.append(event);
    this.history.push(cloneRecord(event));
  }

  async *read<R>(_scope: string, _key: string): AsyncIterable<R> {
    for await (const event of this.persistence.read()) {
      this.onRead(event);
      this.history.push(cloneRecord(event));
      yield event as R;
    }
  }

  rewrite<R>(_scope: string, _key: string, records: readonly R[]): Promise<void> {
    this.persistence.rewrite(records as readonly WireRecord[]);
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return this.persistence.flush();
  }

  close(): Promise<void> {
    return this.persistence.close();
  }

  acquire(_scope: string, _key: string): IDisposable {
    return toDisposable(() => { });
  }

  snapshot(): WireRecord[] {
    return this.persistence.records.map(cloneRecord);
  }

  historySnapshot(): WireRecord[] {
    return this.history.map(cloneRecord);
  }
}

class ConfigBackedModelResolver extends ModelResolverService {
  constructor(
    private readonly options: TestModelProviderOptions = {},
    @IConfigService config: IConfigService,
    @IProviderService providers: IProviderService,
    @IPlatformService platforms: IPlatformService,
    @IModelService models: IModelService,
    @IOAuthService oauth: IOAuthService,
    @IProtocolAdapterRegistry protocolRegistry: IProtocolAdapterRegistry,
    @IHostRequestHeaders hostRequestHeaders: IHostRequestHeaders,
  ) {
    super(config, providers, platforms, models, oauth, protocolRegistry, hostRequestHeaders);
  }

  override resolve(id: string): Model {
    const model = super.resolve(id);
    if (this.options.promptCacheKey === undefined) return model;
    return model.withGenerationKwargs({ prompt_cache_key: this.options.promptCacheKey });
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

  constructor(overrides: readonly TestAgentServiceOverride[] = [], options: TestAgentOptions = {}) {
    this.options = options;
    if (options.cwd !== undefined) this.cwd = options.cwd;
    this.serviceOverrides = flattenServiceOverrides(overrides);
    this.emitter.on('error', () => { });
    this.kimiConfig = applyTestAgentOptionsToConfig(emptyConfig(), options);

    const sessionId = 'test-session';
    const agentId = 'main';
    const persistence = options.persistence ?? new InMemoryWireRecordPersistence();

    const appSeeds = collectScopeSeed(
      [
        (reg) => {
          for (const [id, value] of bootstrapSeed({
            homeDir: '/tmp/kimi-code-agent-app-v2-test',
            cwd: this.cwd,
            osHomeDir: TEST_HOME_DIR,
            env: process.env,
          })) {
            reg.defineInstance(id, value);
          }
          const memoryStorage = (): SyncDescriptor<IFileSystemStorageService> =>
            new SyncDescriptor(InMemoryStorageService, [], true);
          reg.defineDescriptor(IFileSystemStorageService, memoryStorage());
          reg.define(IBlobStore, BlobStoreService);
          reg.defineInstance(
            IConfigService,
            configService(() => this.kimiConfig),
          );
          reg.defineInstance(
            IAppendLogStore,
            new PersistenceAppendLogStore(
              persistence,
              (event) => this.captureRecord(event),
              () => { },
            ),
          );
          reg.defineInstance(ILogService, createLogService(undefined));
          reg.defineInstance(
            ILogOptions,
            {
              level: 'off',
              globalLogPath: '/tmp/kimi-code-agent-app-v2-test/logs/kimi-code.log',
              globalMaxBytes: 6 * 1024 * 1024,
              globalFiles: 1,
              sessionMaxBytes: 5 * 1024 * 1024,
              sessionFiles: 1,
            } satisfies ILogOptions,
          );
          reg.defineInstance(
            IProtocolAdapterRegistry,
            createGenerateBackedProtocolRegistry(
              options.generate ?? this.scriptedGenerate.generate,
            ),
          );
          reg.defineDescriptor(
            IModelResolver,
            new SyncDescriptor(ConfigBackedModelResolver, [{}]),
          );
          if (options.telemetry !== undefined) {
            reg.defineInstance(ITelemetryService, options.telemetry);
          }
          if (options.hookEngine !== undefined) {
            reg.defineInstance(
              IExternalHooksRunnerService,
              resolveExternalHooksRunner(options.hookEngine),
            );
          }
          reg.defineInstance(IHostTerminalService, createHostTerminalService());
          reg.defineInstance(
            IHostEnvironment,
            {
              _serviceBrand: undefined,
              osKind: 'Linux',
              osArch: 'x64',
              osVersion: 'test',
              shellName: 'bash',
              shellPath: '/bin/bash',
              pathClass: 'posix',
              homeDir: TEST_HOME_DIR,
              ready: Promise.resolve(),
            } satisfies IHostEnvironment,
          );
          reg.defineDescriptor(ICronTaskPersistence, new SyncDescriptor(CronTaskPersistenceService));
        },
      ],
      this.serviceOverrides,
      'app',
    );
    this.root = createAppScope({ extra: appSeeds });

    const bootstrap = this.root.accessor.get(IBootstrapService);
    const workspaceId = 'test-workspace';
    const sessionScope = bootstrap.sessionScope(workspaceId, sessionId);
    this.session = this.root.createChild(LifecycleScope.Session, sessionId, {
      extra: collectScopeSeed(
        [
          (reg) => {
            reg.defineInstance(ISessionContext, {
              _serviceBrand: undefined,
              sessionId,
              workspaceId,
              sessionDir: bootstrap.sessionDir(workspaceId, sessionId),
              metaScope: `${sessionScope}/session-meta`,
              cwd: this.cwd,
              scope: (subKey?: string): string =>
                subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
            });
            reg.defineInstance(ISessionInteractionService, this.createInteractionService());
            reg.defineInstance(ISessionApprovalService, this.createApprovalService());
            reg.defineInstance(ISessionQuestionService, this.createQuestionService());
            reg.defineInstance(IAgentLifecycleService, {
              _serviceBrand: undefined,
              onDidCreate: Event.None as Event<IAgentScopeHandle>,
              onDidDispose: Event.None as Event<string>,
              create: () =>
                Promise.reject(
                  new Error('IAgentLifecycleService.create is not supported in the test harness'),
                ),
              fork: () =>
                Promise.reject(
                  new Error('IAgentLifecycleService.fork is not supported in the test harness'),
                ),
              get: () => undefined,
              list: () => [],
              remove: () => Promise.resolve(),
              broadcastPermissionMode: (mode: PermissionMode) => {
                this.agent.accessor.get(IAgentPermissionModeService).setMode(mode);
              },
            } satisfies IAgentLifecycleService);
            reg.defineDescriptor(
              ISessionWorkspaceContext,
              new SyncDescriptor(SessionWorkspaceContextService),
            );
            reg.defineDescriptor(
              ISessionCronService,
              new SyncDescriptor(SessionCronServiceImpl),
            );
          },
        ],
        this.serviceOverrides,
        'session',
      ),
    });
    const workspace = this.session.accessor.get(ISessionWorkspaceContext);

    this.agent = this.session.createChild(LifecycleScope.Agent, agentId, {
      extra: collectScopeSeed(
        [
          (reg) => {
            reg.defineDescriptor(
              IWireService,
              new SyncDescriptor(WireService),
            );
            reg.defineDescriptor(IAgentBlobService, new SyncDescriptor(AgentBlobServiceImpl));
            reg.defineDescriptor(IAgentProfileService, new SyncDescriptor(AgentProfileService));
            reg.defineDescriptor(
              IAgentLLMRequesterService,
              new SyncDescriptor(AgentLLMRequesterService),
            );
            reg.defineDescriptor(
              IAgentExternalHooksService,
              new SyncDescriptor(AgentExternalHooksService),
            );
            reg.defineDescriptor(
              IAgentFullCompactionService,
              new SyncDescriptor(AgentFullCompactionService),
            );
            reg.defineDescriptor(
              IAgentPermissionRulesService,
              new SyncDescriptor(AgentPermissionRulesService),
            );
            reg.defineDescriptor(
              IAgentPermissionGate,
              new SyncDescriptor(AgentPermissionGate),
            );
            reg.defineDescriptor(
              IAgentTaskService,
              new SyncDescriptor(AgentTaskService),
            );
            reg.defineDescriptor(IAgentGoalService, new SyncDescriptor(AgentGoalService));
            reg.defineDescriptor(IAgentSkillService, new SyncDescriptor(AgentSkillService));
            reg.defineDescriptor(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));
            const agentScope = bootstrap.agentScope(workspaceId, sessionId, agentId);
            reg.defineInstance(IAgentScopeContext, {
              _serviceBrand: undefined,
              agentId,
              scope: (subKey?: string): string =>
                subKey === undefined || subKey === '' ? agentScope : `${agentScope}/${subKey}`,
            });
          },
        ],
        this.serviceOverrides,
        'agent',
      ),
    });

    this.get(IAgentProfileService).configure({
      cwd: () => this.cwd,
      chdir: async (nextCwd: string) => {
        this.cwd = nextCwd;
        workspace.setWorkDir(nextCwd);
      },
    });

    this.initializeRestorableServices();
    // Resolve the activity view so its constructor subscriptions publish
    // `agent.activity.updated` — production ignites it in agentLifecycle.
    this.get(IAgentActivityView);

    const eventBus = this.get(IEventBus);
    this.disposables.push(
      eventBus.subscribe((e) => {
        const { type, ...args } = e;
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

  get modelResolver(): IModelResolver {
    return this.session.accessor.get(IModelResolver);
  }

  get context(): IAgentContextMemoryService {
    return this.get(IAgentContextMemoryService);
  }

  get contextSize(): IAgentContextSizeService {
    return this.get(IAgentContextSizeService);
  }

  get wire(): IWireService {
    return this.get(IWireService);
  }

  async restorePersisted(): Promise<void> {
    await this.wire.restore();
  }

  private async restoreRecordsOnly(records: readonly WireRecord[]): Promise<void> {
    const scope = this.get(IAgentScopeContext).scope();
    const log = this.get(IAppendLogStore);
    await log.rewrite(scope, AGENT_WIRE_RECORD_KEY, records);
    await this.wire.restore();
  }

  private async dispatchRecordsOnly(records: readonly WireRecord[]): Promise<void> {
    for (const record of records) {
      const descriptor = OP_REGISTRY.get(record.type);
      if (descriptor === undefined) {
        throw new Error(`Unknown wire record type in test harness: ${record.type}`);
      }
      this.wire.dispatch({
        type: record.type,
        payload: wireRecordToPayload(record),
        descriptor,
      });
    }
    await this.wire.flush();
  }

  private async closeWire(): Promise<void> {
    await this.wire.flush();
  }

  private initializeRestorableServices(): void {
    const context = this.get(IAgentContextMemoryService);
    const contextSize = this.get(IAgentContextSizeService);
    const usage = this.get(IAgentUsageService);
    const permissionMode = this.get(IAgentPermissionModeService);
    const permissionRules = this.get(IAgentPermissionRulesService);
    const cron = this.get(ISessionCronService);
    const plan = this.get(IAgentPlanService);
    this.get(IAgentBuiltinToolsRegistrar);
    this.get(IAgentToolDedupeService);
    this.get(IAgentExternalHooksService);
    this.get(IAgentStepRetryService);
    this.get(IAgentLoopContinuationService);
    const tasks = this.get(IAgentTaskService);
    const permission = this.get(IAgentPermissionGate);
    const swarm = this.get(IAgentSwarmService);

    context.get();
    void swarm.isActive;
    contextSize.get();
    usage.status();
    tasks.list(false);
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
        async ({ injectedPositions }) => {
          if (injectedPositions.length > 0) return undefined;
          return renderPluginSessionStartReminder(
            sessionStarts,
            skillCatalog,
            this.options['log'] as { warn(message: string, payload?: unknown): void } | undefined,
          );
        },
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

  contextData(): { readonly history: readonly ContextMessage[]; readonly tokenCount: number } {
    const context = this.get(IAgentContextMemoryService);
    const contextSize = this.get(IAgentContextSizeService);
    return {
      history: context.get(),
      tokenCount: contextSize.get().measured,
    };
  }

  project(messages?: readonly ContextMessage[]) {
    const context = this.get(IAgentContextMemoryService);
    const projector = this.get(IAgentContextProjectorService);
    return projector.project(messages ?? context.get());
  }

  toolsData(): Array<
    ReturnType<IAgentToolRegistryService['list']>[number] & { readonly active: boolean }
  > {
    const profile = this.get(IAgentProfileService);
    const toolRegistry = this.get(IAgentToolRegistryService);
    return toolRegistry.list().map((tool) => ({
      ...tool,
      active: profile.isToolActive(tool.name, tool.source),
    }));
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
      content: [
        {
          type: 'text',
          text: `<local-command-stdout>\n${content.trim()}\n</local-command-stdout>`,
        },
      ],
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

  async dispatch(event: WireRecord): Promise<void> {
    this.suppressWireSnapshot = true;
    try {
      await this.dispatchRecordsOnly([event]);
    } finally {
      this.suppressWireSnapshot = false;
    }
  }

  async restore(records: readonly WireRecord[]): Promise<void> {
    this.suppressWireSnapshot = true;
    try {
      await this.restoreRecordsOnly(records);
    } finally {
      this.suppressWireSnapshot = false;
    }
  }

  once(type: string): Promise<void> {
    return this.snapshots.once(type);
  }

  onceAny(types: readonly string[]): Promise<string> {
    return this.snapshots.onceAny(types);
  }

  appendExchange(_step: number, userText: string, assistantText: string, tokenTotal: number): void {
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
    let wireHistory = await this.wireHistory();
    let resumedThroughRecord = wireHistory.length;
    const resumed = createTestAgent(
      { autoConfigure: false, cwd: profile.data().cwd },
      ...this.serviceOverrides,
      configServices(() => configSnapshot),
      llmGenerateServices(failOnResumeGenerate),
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence(withMetadata(wireHistory)),
      ),
    );

    try {
      await resumed.restorePersisted();
      await resumed.waitForSessionMetadata();
      for (let i = 0; i < 5; i += 1) {
        await this.drainWirePersistence();
        wireHistory = await this.wireHistory();
        if (wireHistory.length === resumedThroughRecord) break;
        const nextRecords = wireHistory.slice(resumedThroughRecord);
        resumedThroughRecord = wireHistory.length;
        await resumed.dispatchRecordsOnly(nextRecords);
      }

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
    const wire = this.get(IWireService);
    let lastRecordCount = -1;
    for (let i = 0; i < 25; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        await Promise.resolve();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      await wire.flush();
      const persistedRecords = await this.persistedRecords();
      if (
        persistedRecords.length === lastRecordCount &&
        pendingTaskNotificationKeys(persistedRecords).length === 0
      ) {
        return;
      }
      lastRecordCount = persistedRecords.length;
    }
  }

  private async persistedRecords(): Promise<WireRecord[]> {
    const log = this.get(IAppendLogStore);
    if (log instanceof PersistenceAppendLogStore) return log.snapshot();
    const scope = this.get(IAgentScopeContext).scope();
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
      records.push(cloneRecord(record));
    }
    return records;
  }

  private async wireHistory(): Promise<WireRecord[]> {
    const log = this.get(IAppendLogStore);
    return log instanceof PersistenceAppendLogStore
      ? log.historySnapshot()
      : this.persistedRecords();
  }

  async close(_reason = 'Agent runtime test closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    await this.closeWire();
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

  private recordWire(event: WireRecord): WireSnapshotEntry {
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
        const promise = this.createRpcPromise<ExecutableToolResult>();
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
      cancelPendingForTurn: (turnId: number) => {
        for (const [id, interaction] of pending) {
          if (interaction.origin?.turnId === turnId) pending.delete(id);
        }
      },
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

  private captureRecord(event: WireRecord): void {
    const cloned = cloneRecord(event);
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
    context.append(...messages);
  }

  private coverUsage(tokenTotal: number | undefined): void {
    if (tokenTotal === undefined) return;
    const usage = {
      inputOther: tokenTotal - 1,
      output: 1,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    const context = this.get(IAgentContextMemoryService);
    const contextSize = this.get(IAgentContextSizeService);
    contextSize.measured(context.get(), [], usage);
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
    setAdditionalDirs: (dirs) => {
      additionalDirs = dirs.map((dir) => resolve(dir));
    },
    resolve: (path) => (isAbsolute(path) ? resolve(path) : resolve(workDir, path)),
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
  return {
    _serviceBrand: undefined,
    get mode() {
      return mode;
    },
    setMode: (nextMode) => {
      mode = nextMode;
    },
    onDidChangeMode: Event.None as IAgentPermissionModeService['onDidChangeMode'],
  };
}

function createPermissionRulesStub(
  initialRules: readonly PermissionRule[],
): IAgentPermissionRulesService {
  let rules = [...initialRules];
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
    recordApprovalResult: () => { },
  };
}

function createHostTerminalService(): IHostTerminalService {
  return {
    _serviceBrand: undefined,
    spawn: async () => ({
      onProcessData: Event.None as Event<string>,
      onProcessExit: Event.None as Event<{ exitCode: number | null }>,
      write: () => { },
      resize: () => { },
      kill: () => { },
    }),
  };
}

const failOnResumeGenerate: GenerateFn = async () => {
  throw new Error('Resume replay unexpectedly called the LLM');
};

function resumeStateSnapshot(ctx: AgentTestContext): ResumeStateSnapshot {
  const usage = ctx.get(IAgentUsageService);
  const permission = ctx.get(IAgentPermissionGate);
  const { currentTurn: _currentTurn, ...usageStatus } = usage.status();
  const { rules: _rules, ...permissionData } = permission.data();
  return {
    config: configStateSnapshot(ctx),
    context: resumeContextSnapshot(ctx),
    permission: permissionData,
    usage: usageStatus,
  };
}

function stripUndefinedFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}

function resumeContextSnapshot(ctx: AgentTestContext) {
  const context = ctx.contextData();
  return {
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

function pendingTaskNotificationKeys(records: readonly WireRecord[]): readonly string[] {
  const terminal = new Set<string>();
  const delivered = new Set<string>();
  for (const record of records) {
    if (record.type === 'task.terminated') {
      const info = record['info'];
      if (isTaskInfoLike(info) && info.detached !== false && info.terminalNotificationSuppressed !== true) {
        terminal.add(taskNotificationKey(info.taskId, info.status));
      }
      continue;
    }
    for (const message of contextMessagesFromRecord(record)) {
      const origin = message.origin;
      if (isTaskOriginLike(origin)) {
        delivered.add(`${origin.taskId}\0${origin.status}\0${origin.notificationId}`);
      }
    }
  }
  return [...terminal].filter((key) => !delivered.has(key));
}

function contextMessagesFromRecord(record: WireRecord): readonly ContextMessage[] {
  if (record.type === 'context.append_message') {
    const message = record['message'];
    return isContextMessageLike(message) ? [message] : [];
  }
  return [];
}

function isContextMessageLike(value: unknown): value is ContextMessage {
  return typeof value === 'object' && value !== null && 'role' in value;
}

function isTaskInfoLike(value: unknown): value is {
  readonly taskId: string;
  readonly status: string;
  readonly detached?: boolean;
  readonly terminalNotificationSuppressed?: boolean;
} {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return typeof info['taskId'] === 'string' && typeof info['status'] === 'string';
}

function isTaskOriginLike(value: unknown): value is {
  readonly taskId: string;
  readonly status: string;
  readonly notificationId: string;
} {
  if (typeof value !== 'object' || value === null) return false;
  const origin = value as Record<string, unknown>;
  return origin['kind'] === 'task' &&
    typeof origin['taskId'] === 'string' &&
    typeof origin['status'] === 'string' &&
    typeof origin['notificationId'] === 'string';
}

function taskNotificationKey(taskId: string, status: string): string {
  return `${taskId}\0${status}\0task:${taskId}:${status}`;
}

function configStateSnapshot(ctx: AgentTestContext): ResumeStateSnapshot['config'] {
  const profile = ctx.get(IAgentProfileService);
  const data = profile.data();
  let model: ReturnType<IAgentProfileService['resolveModel']>;
  try {
    model = profile.resolveModel();
  } catch {
    model = undefined;
  }
  const providerConfig =
    model === undefined ? undefined : ctx.get(IProviderService).get(model.providerName);
  return {
    cwd: data.cwd,
    activeToolNames: data.activeToolNames,
    provider: providerConfig,
    profileName: data.profileName,
    thinkingLevel: data.thinkingLevel,
    systemPrompt: data.systemPrompt,
  };
}

function emptyConfig(): KimiConfig {
  return configWithProvider({ providers: {} }, MOCK_PROVIDER, undefined);
}

function applyTestAgentOptionsToConfig(config: KimiConfig, options: TestAgentOptions): KimiConfig {
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
  };
}

function configService(readConfig: () => KimiConfig): IConfigService {
  const effectiveConfig = () => configWithEnvOverrides(readConfig());
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeConfiguration: () => ({ dispose: () => { } }),
    onDidSectionChange: () => ({ dispose: () => { } }),
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
  const forcedEffort = process.env['KIMI_MODEL_THINKING_EFFORT']?.trim();
  const thinkingKeep = process.env['KIMI_MODEL_THINKING_KEEP']?.trim();
  const cron = cronEnvOverrides(asMutableRecord(config['cron']));
  if (
    maxCompletionTokens === undefined &&
    temperature === undefined &&
    topP === undefined &&
    (forcedEffort === undefined || forcedEffort.length === 0) &&
    (thinkingKeep === undefined || thinkingKeep.length === 0) &&
    cron === undefined
  ) {
    return config;
  }
  const modelOverrides = asMutableRecord(config['modelOverrides']);
  const thinking = asMutableRecord(config['thinking']);
  if (temperature !== undefined) modelOverrides['temperature'] = temperature;
  if (topP !== undefined) modelOverrides['topP'] = topP;
  if (thinkingKeep !== undefined && thinkingKeep.length > 0) {
    modelOverrides['thinkingKeep'] = thinkingKeep;
  }
  if (forcedEffort !== undefined && forcedEffort.length > 0) {
    thinking['forcedEffort'] = forcedEffort;
  }
  if (maxCompletionTokens !== undefined) {
    modelOverrides['maxCompletionTokens'] = maxCompletionTokens;
  }
  return {
    ...config,
    cron: cron ?? config['cron'],
    modelOverrides,
    thinking:
      forcedEffort !== undefined && forcedEffort.length > 0 ? thinking : config['thinking'],
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
    capabilities.dynamically_loaded_tools ? 'dynamically_loaded_tools' : undefined,
  ].filter((capability): capability is string => capability !== undefined);
}

function toolCall(id: string, name: string, args: unknown): ContextMessage['toolCalls'][number] {
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

function createLogService(logger: Logger | undefined, bindings: LogContext = {}): ILogService {
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
    child: (childBindings) =>
      createLogService(
        logger?.child?.(childBindings) ?? logger?.createChild?.(childBindings) ?? logger,
        { ...bindings, ...childBindings },
      ),
    flush: () => Promise.resolve(),
  };
}

function createGenerateBackedProtocolRegistry(generate: GenerateFn): IProtocolAdapterRegistry {
  return {
    _serviceBrand: undefined,
    supportedProtocols: () =>
      ['kimi', 'anthropic', 'openai', 'openai_responses', 'google-genai', 'vertexai'] as const,
    createChatProvider: (input: ProtocolAdapterConfig) => {
      const config = {
        type: input.protocol,
        model: input.modelName,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        defaultHeaders: input.defaultHeaders as Record<string, string> | undefined,
        ...input.providerOptions,
      } as ProviderConfig;
      return input.protocol === 'kimi'
        ? new GenerateBackedKimiChatProvider(
            config as Extract<ProviderConfig, { type: 'kimi' }>,
            generate,
          )
        : new GenerateBackedChatProvider(config, generate);
    },
  } as IProtocolAdapterRegistry;
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
    return generateBackedResponse(this, this.generateFn, systemPrompt, tools, history, options);
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

  get maxCompletionTokens(): number | undefined {
    const value = this.modelParameters[completionBudgetParamName(this.config.type)];
    return typeof value === 'number' ? value : undefined;
  }

  async generate(
    systemPrompt: string,
    tools: KosongTool[],
    history: KosongMessage[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    return generateBackedResponse(this, this.generateFn, systemPrompt, tools, history, options);
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
    return new GenerateBackedChatProvider(this.config, this.generateFn, this.thinkingEffort, {
      ...this.modelParameters,
      [completionBudgetParamName(this.config.type)]: maxCompletionTokens,
    });
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
      // Forward the early-capture hook so a GenerateFn can fire the trace id
      // as soon as its (simulated) response headers arrive — e.g. before a
      // mid-stream failure — mirroring real kosong generate() behavior.
      onTraceId: options?.onTraceId,
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
      traceId: result.traceId,
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

function partsFromGeneratedMessage(
  message: Awaited<ReturnType<GenerateFn>>['message'],
): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [
    ...message.content.map((part) => structuredClone(part)),
    ...message.toolCalls.map((part) => structuredClone(part)),
  ];
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function normalizeProviderStreamParts(
  parts: readonly StreamedMessagePart[],
): StreamedMessagePart[] {
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
    'id' | 'usage' | 'finishReason' | 'rawFinishReason' | 'traceId'
  >,
): StreamedMessage {
  return {
    id: meta.id,
    usage: meta.usage,
    finishReason: meta.finishReason ?? null,
    rawFinishReason: meta.rawFinishReason ?? null,
    traceId: meta.traceId ?? null,
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

function cloneRecord<T extends WireRecord>(event: T): T {
  return structuredClone(event);
}

function withMetadata(events: readonly WireRecord[]): readonly WireRecord[] {
  if (events.length === 0 || events[0]?.type === 'metadata') return events;
  return [
    {
      type: 'metadata',
      protocol_version: WIRE_PROTOCOL_VERSION,
      created_at: 1,
    },
    ...events,
  ];
}
