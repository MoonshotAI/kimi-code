import type { Kaos } from '@moonshot-ai/kaos';
import type { ChatProvider, generate } from '@moonshot-ai/kosong';
import { join } from 'pathe';

import type {
  PermissionMode,
  PermissionRule,
} from '../../agent/permission';
import { normalizeAdditionalDirs, type KimiConfig } from '../../config';
import {
  Disposable,
  ServiceCollection,
  SyncDescriptor,
  getSingletonServiceDescriptors,
  type IDisposable,
  type IInstantiationService,
  type ServiceIdentifier,
} from '../../di';
import type { ExperimentalFlagResolver } from '../../flags';
import type { McpConnectionManager } from '../../mcp';
import type { EnabledPluginSessionStart } from '../../plugin/types';
import type { QuestionRequest } from '../../rpc';
import type { HookEngine } from '../../session/hooks';
import type { ModelProvider } from '../../session/provider-manager';
import { extendWorkspaceWithSkillRoots } from '../../skill';
import type { WorkspaceConfig } from '../../tools/support/workspace';
import type { SkillCatalog, SkillDefinition } from '../../skill';
import { DEFAULT_AGENT_PROFILES } from '../../profile';
import type { SubagentResult } from '../../session/subagent-batch';
import type {
  QueuedSubagentTask,
  SessionSubagentHost,
} from '../../session/subagent-host';
import {
  noopTelemetryClient,
  withTelemetryContext,
  type TelemetryClient,
} from '../../telemetry';
import {
  AskUserQuestionTool,
  AgentTool,
  BashTool,
  EditTool,
  FetchURLTool,
  GlobTool,
  GrepTool,
  ReadMediaFileTool,
  ReadTool,
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  WebSearchTool,
  WriteTool,
  type UrlFetcher,
  type VideoUploader,
  type WebSearchProvider,
} from '../../tools/builtin';
import { escapeXmlAttr } from '../../utils/xml-escape';
import { ILogService } from '../logger/logger';
import {
  BackgroundTaskPersistence,
  IBackgroundService,
  type BackgroundOptions,
  type BackgroundServiceOptions,
} from './background/background';
import { BackgroundService } from './background/backgroundService';
import {
  IBlobStoreService,
  type BlobStoreServiceOptions,
} from './blobStore/blobStore';
import { BlobStoreService } from './blobStore/blobStoreService';
import { IContextMemory } from './contextMemory/contextMemory';
import { IContextProjector } from './contextProjector/contextProjector';
import { IContextSizeService } from './contextSize/contextSize';
import { ICronService, type CronOptions } from './cron/cron';
import { CronService } from './cron/cronService';
import {
  IDynamicInjector,
  type DynamicInjectionProvider,
} from './dynamicInjector/dynamicInjector';
import { IEventBus } from './eventBus/eventBus';
import { EventBusService } from './eventBus/eventBusService';
import {
  IExternalHooksService,
  type ExternalHooksServiceOptions,
} from './externalHooks/externalHooks';
import { ExternalHooksService } from './externalHooks/externalHooksService';
import { IFullCompaction } from './fullCompaction/fullCompaction';
import {
  FullCompactionService,
  type FullCompactionServiceOptions,
} from './fullCompaction/fullCompactionService';
import { IGoalService } from './goal/goal';
import {
  GoalService,
  type GoalServiceOptions,
} from './goal/goalService';
import type { GoalInjectionOptions } from './goalMode/injection/goalInjection';
import { ILLMRequestLogService } from './llmRequestLog/llmRequestLog';
import { ILLMRequester } from './llmRequester/llmRequester';
import { LLMRequesterService } from './llmRequester/llmRequesterService';
import { ILoopService } from './loop/loop';
import { IKaosService } from './kaos/kaos';
import {
  KaosService,
  type KaosServiceOptions,
} from './kaos/kaosService';
import { IMcpRuntimeService } from './mcpRuntime/mcpRuntime';
import { McpRuntimeService } from './mcpRuntime/mcpRuntimeService';
import {
  IMicroCompactionService,
  type MicroCompactionServiceOptions,
} from './microCompaction/microCompaction';
import { MicroCompactionService } from './microCompaction/microCompactionService';
import {
  IPermissionService,
  type PermissionServiceOptions,
} from './permission/permission';
import { PermissionService } from './permission/permissionService';
import { IPermissionModeService } from './permissionMode/permissionMode';
import { IPermissionPolicyService } from './permissionPolicy/permissionPolicy';
import { IPlanModeService } from './planMode/planMode';
import {
  IPermissionRulesService,
  type PermissionRulesServiceOptions,
} from './permissionRules/permissionRules';
import { PermissionRulesService } from './permissionRules/permissionRulesService';
import {
  IProfileService,
  type ProfileServiceOptions,
} from './profile/profile';
import { ProfileService } from './profile/profileService';
import { IPromptService } from './prompt/prompt';
import { IQuestionService } from '../question/question';
import {
  IReplayBuilderService,
  type ReplayBuilderServiceOptions,
  type ReplayRangeOptions,
} from './replayBuilder/replayBuilder';
import { ReplayBuilderService } from './replayBuilder/replayBuilderService';
import { IAgentRPCService } from './rpc/rpc';
import { IAgentSkillService } from './skill/skill';
import { ModelSkillTool } from './skill/modelSkillTool';
import { AgentSkillService } from './skill/skillService';
import {
  ISubagentHost,
  type ISubagentHost as SubagentHostServiceShape,
} from './subagentHost/subagentHost';
import { SubagentHostService } from './subagentHost/subagentHostService';
import { ISwarmMode } from './swarmMode/swarmMode';
import {
  SwarmModeService,
  type SwarmModeServiceOptions,
} from './swarmMode/swarmModeService';
import { ITelemetryService } from './telemetry/telemetry';
import { TelemetryService } from './telemetry/telemetryService';
import { IToolExecutor } from './toolExecutor/toolExecutor';
import { IToolRegistry } from './toolRegistry/toolRegistry';
import { IToolStoreService } from './toolStore/toolStore';
import './todoList/todoListService';
import { ITodoListService } from './todoList/todoList';
import { ITurnRunner } from './turnRunner/turnRunner';
import { IUsageService } from './usage/usage';
import {
  IUserToolService,
  type UserToolServiceOptions,
} from './userTool/userTool';
import { UserToolService } from './userTool/userToolService';
import {
  IWireRecord,
  type PersistedWireRecord,
  type WireRecordRestoreOptions,
  type WireRecordRestoreResult,
  type WireRecordServiceOptions,
} from './wireRecord/wireRecord';
import { WireRecordService } from './wireRecord/wireRecordService';

export type AgentRuntimeType = 'main' | 'sub' | 'independent';
export type AgentRuntimeGoalOptions = GoalInjectionOptions;

export interface AgentRuntimeToolServices {
  readonly webSearcher?: WebSearchProvider;
  readonly urlFetcher?: UrlFetcher;
}

export interface AgentRuntimeDynamicInjection {
  readonly variant: string;
  readonly provider: DynamicInjectionProvider;
}

export interface AgentRuntimeReplayOptions {
  readonly range?: ReplayRangeOptions;
}

export interface AgentRuntimeOptions {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly type?: AgentRuntimeType;
  readonly homedir?: string;
  readonly cwd?: string | (() => string | undefined);
  readonly chdir?: (cwd: string) => void | Promise<void>;
  readonly kaos?: Kaos;
  readonly config?: KimiConfig | (() => KimiConfig | undefined);
  readonly modelProvider?: ModelProvider;
  readonly generate?: typeof generate;
  readonly toolServices?: AgentRuntimeToolServices;
  readonly mcp?: McpConnectionManager;
  readonly subagentHost?: SessionSubagentHost;
  readonly telemetry?: TelemetryClient;
  readonly hookEngine?: Pick<
    HookEngine,
    'trigger' | 'triggerBlock' | 'fireAndForgetTrigger'
  >;
  readonly experimentalFlags?: ExperimentalFlagResolver;
  readonly microCompaction?: MicroCompactionServiceOptions;
  readonly fullCompaction?: FullCompactionServiceOptions;
  readonly permission?: PermissionServiceOptions;
  readonly additionalDirs?: readonly string[];
  readonly permissionRules?: readonly PermissionRule[];
  readonly parentPermissionRules?: IPermissionRulesService;
  readonly permissionMode?: PermissionMode;
  readonly skills?: SkillCatalog | null;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly dynamicInjections?: readonly AgentRuntimeDynamicInjection[];
  readonly userTool?: UserToolServiceOptions;
  readonly wireRecord?: Omit<WireRecordServiceOptions, 'homedir' | 'blobStore'>;
  readonly replay?: AgentRuntimeReplayOptions;
  readonly blobStore?: BlobStoreServiceOptions | IBlobStoreService;
  readonly background?: BackgroundOptions | false;
  readonly cron?: CronOptions | false;
  readonly goal?: GoalInjectionOptions;
  readonly initializeTools?: (registry: IToolRegistry) => void;
  readonly emitStatusUpdated?: () => void;
}

interface AgentRuntimeRefs {
  child?: IInstantiationService;
  planMode?: IPlanModeService;
}

type MutableAgentRuntimeOptions = {
  additionalDirs?: readonly string[];
  permission?: PermissionServiceOptions;
};

interface AgentRuntimeServiceContext {
  readonly type: AgentRuntimeType;
  readonly cwd: string | undefined;
  readonly planMode: NonNullable<PermissionServiceOptions['planMode']>;
  readonly swarmMode: NonNullable<PermissionServiceOptions['swarmMode']>;
  initializeTools(): void;
}

export class AgentRuntime extends Disposable {
  private closed = false;

  constructor(
    readonly instantiation: IInstantiationService,
    private readonly updateAdditionalDirs?: (additionalDirs: readonly string[]) => void,
    // The provider manager used to resolve provider configs/auth. Exposed so
    // callers (and tests) can drive provider-config resolution directly.
    readonly modelProvider?: ModelProvider,
  ) {
    super();
    this._register(this.instantiation);
  }

  static create(
    instantiation: IInstantiationService,
    disposables: readonly IDisposable[] = [],
    updateAdditionalDirs?: (additionalDirs: readonly string[]) => void,
    modelProvider?: ModelProvider,
  ): AgentRuntime {
    const runtime = new AgentRuntime(instantiation, updateAdditionalDirs, modelProvider);
    for (const disposable of disposables) {
      runtime._register(disposable);
    }
    return runtime;
  }

  get<T>(id: ServiceIdentifier<T>): T {
    return this.instantiation.invokeFunction((accessor) => accessor.get(id));
  }

  async restore(
    records?: readonly PersistedWireRecord[],
    options?: WireRecordRestoreOptions,
  ): Promise<WireRecordRestoreResult> {
    this.instantiation.invokeFunction((accessor) => {
      accessor.get(IContextSizeService).getStatus();
      accessor.get(IUsageService).data();
      // oxlint-disable-next-line no-unused-expressions
      accessor.get(IPermissionModeService).mode;
      // oxlint-disable-next-line no-unused-expressions
      accessor.get(IPlanModeService).isActive;
      // Force-construct ToolStoreService so tools.update_store records restore
      // into the service before resume parity snapshots compare tool state.
      accessor.get(IToolStoreService).data();
      // Force-construct UserToolService so its wireRecord handlers
      // (tools.register_user_tool / tools.unregister_user_tool) are
      // registered before records are replayed below.
      // oxlint-disable-next-line no-unused-expressions
      accessor.get(IUserToolService);
      // Force-construct PermissionRulesService so its wireRecord handlers
      // (permission.rules.add / permission.record_approval_result) are
      // registered before records are replayed below. accessor.get() alone
      // returns a lazy proxy and does not run the constructor; reading a
      // member is what actually instantiates the service.
      // oxlint-disable-next-line no-unused-expressions
      accessor.get(IPermissionRulesService).rules;
      // Force-construct GoalService so goal.* and forked restore handlers are registered.
      accessor.get(IGoalService).getGoal();
      // oxlint-disable-next-line no-unused-expressions
      accessor.get(IFullCompaction).isCompacting;
    });
    const replayBuilder = this.get(IReplayBuilderService);
    replayBuilder.postRestoring = true;
    try {
      return await this.get(IWireRecord).restore(records, options);
    } finally {
      replayBuilder.postRestoring = false;
    }
  }

  async flush(): Promise<void> {
    await this.get(IWireRecord).flush();
  }

  setAdditionalDirs(additionalDirs: readonly string[]): void {
    this.updateAdditionalDirs?.(additionalDirs);
  }

  async close(reason = 'Agent runtime closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.get(ICronService).stop();
    await this.get(IBackgroundService).stopAll(reason);
    const wireRecord = this.get(IWireRecord);
    await wireRecord.flush();
    await wireRecord.close();
    this.dispose();
  }
}

export function createAgentRuntime(
  parent: IInstantiationService,
  options: AgentRuntimeOptions = {},
): AgentRuntime {
  const refs: AgentRuntimeRefs = {};
  const type = options.type ?? 'main';
  const services = new ServiceCollection(...getAgentServiceDescriptors());
  const context = createAgentRuntimeServiceContext(options, type, refs);

  configureAgentRuntimeServices(
    services,
    options,
    context,
  );

  refs.child = parent.createChild(services);
  refs.planMode = getService(refs.child, IPlanModeService);

  const runtime = AgentRuntime.create(
    refs.child,
    createAgentRuntimeDisposables(refs.child, options),
    (additionalDirs) => {
      const child = refs.child;
      if (child === undefined) return;
      updateAgentRuntimeAdditionalDirs(child, options, context, additionalDirs);
    },
    options.modelProvider,
  );
  try {
    activateAgentServices(refs.child);
    initializeAgentRuntimeTools(refs.child, options);
  } catch (error) {
    runtime.dispose();
    throw error;
  }
  return runtime;
}

export function getAgentServiceDescriptors(): ReadonlyArray<
  readonly [ServiceIdentifier<unknown>, SyncDescriptor<unknown>]
> {
  return getSingletonServiceDescriptors().filter(
    (entry): entry is readonly [ServiceIdentifier<unknown>, SyncDescriptor<unknown>] =>
      isAgentServiceIdentifier(entry[0]),
  );
}

export function isAgentServiceIdentifier(id: ServiceIdentifier<unknown>): boolean {
  const name = String(id);
  return name.startsWith('agent') || name.endsWith('.agent');
}

function createAgentRuntimeServiceContext(
  options: AgentRuntimeOptions,
  type: AgentRuntimeType,
  refs: AgentRuntimeRefs,
): AgentRuntimeServiceContext {
  return {
    type,
    cwd: currentCwd(options.cwd),
    planMode: {
      get isActive() {
        return refs.planMode?.isActive ?? false;
      },
      get planFilePath() {
        return refs.planMode?.planFilePath ?? null;
      },
      exit(id?: string) {
        refs.planMode?.exit(id);
      },
    },
    swarmMode: {
      get isActive() {
        return refs.child === undefined ? false : getService(refs.child, ISwarmMode).isActive;
      },
    },
    initializeTools() {
      const child = refs.child;
      if (child === undefined) return;
      initializeAgentRuntimeTools(child, options);
    },
  };
}

function initializeAgentRuntimeTools(
  instantiation: IInstantiationService,
  options: AgentRuntimeOptions,
): void {
  initializeRuntimeBuiltinTools(instantiation, options);
  options.initializeTools?.(getService(instantiation, IToolRegistry));
}

function initializeRuntimeBuiltinTools(
  instantiation: IInstantiationService,
  options: AgentRuntimeOptions,
): void {
  // Plan/todo/cron/swarm/MCP/user tools are registered by their owning services.
  // Media/goal tools still depend on unmigrated old-Agent paths.
  const registry = getService(instantiation, IToolRegistry);
  const background = getService(instantiation, IBackgroundService);
  const profile = getService(instantiation, IProfileService);
  const telemetry = getService(instantiation, ITelemetryService);
  const questionService = tryGetQuestionService(instantiation);
  const questionToolHost =
    questionService === undefined
      ? { background, telemetry }
      : {
          requestQuestion: (
            request: QuestionRequest,
            requestOptions: { readonly signal?: AbortSignal },
          ) =>
            questionService.request(
              {
                ...request,
                sessionId: options.sessionId ?? 'service-session',
                agentId: options.agentId ?? 'main',
              },
              requestOptions,
            ),
          background,
          telemetry,
        };
  registry.register(new TaskListTool(background));
  registry.register(new TaskOutputTool(background));
  registry.register(new TaskStopTool(background));
  registry.register(new AskUserQuestionTool(questionToolHost));
  if (options.subagentHost !== undefined) {
    registry.register(
      new AgentTool(
        options.subagentHost,
        background,
        DEFAULT_AGENT_PROFILES['agent']?.subagents,
        {
          allowBackground:
            profile.isToolActive('TaskList') &&
            profile.isToolActive('TaskOutput') &&
            profile.isToolActive('TaskStop'),
        },
      ),
    );
  }

  const kaos = options.kaos;
  if (kaos !== undefined) {
    const cwd = profile.data().cwd || currentCwd(options.cwd);
    if (cwd !== undefined && cwd.length > 0) {
      const workspace = extendWorkspaceWithSkillRoots(
        {
          workspaceDir: cwd,
          additionalDirs: options.additionalDirs ?? [],
        },
        options.skills?.getSkillRoots() ?? [],
      );
      registry.register(new ReadTool(kaos, workspace));
      registry.register(new WriteTool(kaos, workspace));
      registry.register(new EditTool(kaos, workspace));
      registry.register(new GrepTool(kaos, workspace));
      registry.register(new GlobTool(kaos, workspace));
      registry.register(
        new BashTool(kaos, cwd, background, {
          allowBackground:
            profile.isToolActive('TaskList') &&
            profile.isToolActive('TaskOutput') &&
            profile.isToolActive('TaskStop'),
        }),
      );
      registerReadMediaFileTool(registry, kaos, workspace, profile, options);
    }
  }

  const toolServices = options.toolServices;
  if (toolServices?.webSearcher !== undefined) {
    registry.register(new WebSearchTool(toolServices.webSearcher));
  }
  if (toolServices?.urlFetcher !== undefined) {
    registry.register(new FetchURLTool(toolServices.urlFetcher));
  }
  if ((options.skills?.listInvocableSkills().length ?? 0) > 0) {
    registry.register(new ModelSkillTool(getService(instantiation, IAgentSkillService)));
  }
}

// Capability-gated; re-runs whenever the model (and thus capabilities/provider)
// changes via `initializeBuiltinTools`. The tool registry replaces by name, so
// re-registration is idempotent.
function registerReadMediaFileTool(
  registry: IToolRegistry,
  kaos: Kaos,
  workspace: WorkspaceConfig,
  profile: IProfileService,
  options: AgentRuntimeOptions,
): void {
  if (!profile.hasModel()) return;
  const capabilities = profile.getModelCapabilities();
  if (!capabilities.image_in && !capabilities.video_in) return;
  try {
    registry.register(
      new ReadMediaFileTool(
        kaos,
        workspace,
        capabilities,
        buildVideoUploader(profile, options),
      ),
    );
  } catch (error) {
    // ReadMediaFileTool throws a `SkipThisTool` error when the model lacks
    // image/video input; the capability guard above normally prevents this,
    // but stay defensive against capability races.
    if ((error as { name?: string }).name !== 'SkipThisTool') throw error;
  }
}

// Mirrors the legacy agent's `createVideoUploader`: resolve OAuth auth (with
// the 401 force-refresh / login-required retry handled inside `resolveAuth`)
// and forward it to the provider's `uploadVideo`. The provider and auth are
// resolved lazily at upload time — the tool is registered once when the model
// is set, but the active provider can change afterwards. When the provider
// cannot upload video the bytes are inlined as a data URL (legacy parity for
// the tool's no-uploader branch).
function buildVideoUploader(
  profile: IProfileService,
  options: AgentRuntimeOptions,
): VideoUploader {
  return async (input) => {
    let provider: ChatProvider | undefined;
    try {
      provider = profile.provider;
    } catch {
      provider = undefined;
    }
    const uploadVideo = provider?.uploadVideo?.bind(provider);
    if (uploadVideo === undefined) {
      return {
        type: 'video_url',
        videoUrl: {
          url: `data:${input.mimeType};base64,${Buffer.from(input.data).toString('base64')}`,
        },
      };
    }
    const withAuth = options.modelProvider?.resolveAuth?.(profile.getModel());
    if (withAuth === undefined) return uploadVideo(input);
    return withAuth((auth) => uploadVideo(input, { auth }));
  };
}

function tryGetQuestionService(instantiation: IInstantiationService): IQuestionService | undefined {
  try {
    return instantiation.invokeFunction((accessor) => accessor.get(IQuestionService));
  } catch {
    return undefined;
  }
}

function configureAgentRuntimeServices(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
  context: AgentRuntimeServiceContext,
): void {
  configureBlobStoreService(services, options);
  configureWireRecordService(services, options);
  configureReplayBuilderService(services, options);
  configureBackgroundService(services, options);
  configureEventBusService(services);
  configureProfileService(services, options, context);
  configureLLMRequesterService(services, options);
  configureMcpRuntimeService(services, options);
  configureKaosService(services, options);
  configurePermissionRulesService(services, options);
  configurePermissionService(services, options, context);
  configureUserToolService(services, options);
  configureAgentSkillService(services, options);
  configureMicroCompactionService(services, options);
  configureFullCompactionService(services, options);
  configureExternalHooksService(services, options);
  configureTelemetryService(services, options);
  configureGoalService(services, options, context.type);
  configureCronService(services, options, context.type);
  configureSubagentHostService(services, options);
  configureSwarmModeService(services, options);
}

function configureBlobStoreService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  if (isBlobStoreInstance(options.blobStore)) {
    services.set(IBlobStoreService, options.blobStore);
    return;
  }

  services.set(
    IBlobStoreService,
    new SyncDescriptor(
      BlobStoreService,
      [
        {
          blobsDir: options.blobStore?.blobsDir ?? blobDir(options.homedir),
          threshold: options.blobStore?.threshold,
          maxCacheSize: options.blobStore?.maxCacheSize,
        } satisfies BlobStoreServiceOptions,
      ],
      true,
    ),
  );
}

function configureWireRecordService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IWireRecord,
    new SyncDescriptor(
      WireRecordService,
      [
        {
          homedir: options.homedir,
          persistence: options.wireRecord?.persistence,
          blobStore: isBlobStoreInstance(options.blobStore) ? options.blobStore : undefined,
          onPersistenceError: options.wireRecord?.onPersistenceError,
        } satisfies WireRecordServiceOptions,
      ],
      true,
    ),
  );
}

function configureReplayBuilderService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IReplayBuilderService,
    new SyncDescriptor(
      ReplayBuilderService,
      [{ range: options.replay?.range } satisfies ReplayBuilderServiceOptions],
      true,
    ),
  );
}

function configureBackgroundService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IBackgroundService,
    new SyncDescriptor(
      BackgroundService,
      [backgroundServiceOptions(options)],
      true,
    ),
  );
}

function configureEventBusService(services: ServiceCollection): void {
  services.set(IEventBus, new SyncDescriptor(EventBusService, [], true));
}

function configureProfileService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
  context: AgentRuntimeServiceContext,
): void {
  services.set(
    IProfileService,
    new SyncDescriptor(
      ProfileService,
      [
        {
          cwd: options.cwd,
          chdir: options.chdir,
          modelProvider: options.modelProvider,
          config: options.config,
          initializeBuiltinTools: () => {
            context.initializeTools();
          },
          emitStatusUpdated: options.emitStatusUpdated,
        } satisfies ProfileServiceOptions,
      ],
      true,
    ),
  );
}

function configureLLMRequesterService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    ILLMRequester,
    new SyncDescriptor(
      LLMRequesterService,
      [
        {
          modelProvider: options.modelProvider,
          config: options.config,
          generate: options.generate,
        },
      ],
      true,
    ),
  );
}

function configureMcpRuntimeService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IMcpRuntimeService,
    new SyncDescriptor(McpRuntimeService, [{ manager: options.mcp }], true),
  );
}

function configurePermissionRulesService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IPermissionRulesService,
    new SyncDescriptor(
      PermissionRulesService,
      [
        {
          initialRules: options.permissionRules,
          parent: options.parentPermissionRules,
        } satisfies PermissionRulesServiceOptions,
      ],
      true,
    ),
  );
}

function configureKaosService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IKaosService,
    new SyncDescriptor(
      KaosService,
      [
        {
          kaos: options.kaos,
        } satisfies KaosServiceOptions,
      ],
      true,
    ),
  );
}

function configurePermissionService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
  context: AgentRuntimeServiceContext,
): void {
  services.set(
    IPermissionService,
    new SyncDescriptor(
      PermissionService,
      [permissionServiceOptions(options, context)],
      true,
    ),
  );
}

function updateAgentRuntimeAdditionalDirs(
  instantiation: IInstantiationService,
  options: AgentRuntimeOptions,
  context: AgentRuntimeServiceContext,
  additionalDirs: readonly string[],
): void {
  const normalized = normalizeAdditionalDirs(additionalDirs);
  const mutable = options as MutableAgentRuntimeOptions;
  mutable.additionalDirs = normalized;
  if (options.permission !== undefined) {
    mutable.permission = { ...options.permission, additionalDirs: normalized };
  }
  getService(instantiation, IPermissionPolicyService).configure(
    permissionServiceOptions(options, context),
  );
  context.initializeTools();
}

function permissionServiceOptions(
  options: AgentRuntimeOptions,
  context: AgentRuntimeServiceContext,
): PermissionServiceOptions {
  return {
    sessionId: options.permission?.sessionId ?? options.sessionId,
    agentId: options.permission?.agentId ?? options.agentId,
    agentType:
      options.permission?.agentType ?? (context.type === 'sub' ? 'sub' : 'main'),
    cwd: options.permission?.cwd ?? context.cwd,
    additionalDirs: options.permission?.additionalDirs ?? options.additionalDirs,
    pathClass: options.permission?.pathClass,
    planMode: options.permission?.planMode ?? context.planMode,
    swarmMode: options.permission?.swarmMode ?? context.swarmMode,
    gitWorkTreeMarker: options.permission?.gitWorkTreeMarker,
    initialMode: options.permission?.initialMode ?? options.permissionMode,
  };
}

function configureUserToolService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IUserToolService,
    new SyncDescriptor(
      UserToolService,
      [
        {
          executeUserTool: options.userTool?.executeUserTool,
        } satisfies UserToolServiceOptions,
      ],
      false,
    ),
  );
}

function configureAgentSkillService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IAgentSkillService,
    new SyncDescriptor(
      AgentSkillService,
      [{ catalog: options.skills }],
      true,
    ),
  );
}

function configureMicroCompactionService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IMicroCompactionService,
    new SyncDescriptor(
      MicroCompactionService,
      [
        {
          config: options.microCompaction?.config,
          experimentalFlags:
            options.microCompaction?.experimentalFlags ?? options.experimentalFlags,
          now: options.microCompaction?.now,
          maxContextTokens: options.microCompaction?.maxContextTokens,
        } satisfies MicroCompactionServiceOptions,
      ],
      false,
    ),
  );
}

function configureFullCompactionService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IFullCompaction,
    new SyncDescriptor(
      FullCompactionService,
      [
        {
          compactionStrategy: options.fullCompaction?.compactionStrategy,
        } satisfies FullCompactionServiceOptions,
      ],
      false,
    ),
  );
}

function configureExternalHooksService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    IExternalHooksService,
    new SyncDescriptor(
      ExternalHooksService,
      [{ hookEngine: options.hookEngine } satisfies ExternalHooksServiceOptions],
      true,
    ),
  );
}

function configureTelemetryService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    ITelemetryService,
    new SyncDescriptor(
      TelemetryService,
      [{ client: telemetryClient(options) }],
      true,
    ),
  );
}

function configureGoalService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
  type: AgentRuntimeType,
): void {
  services.set(
    IGoalService,
    new SyncDescriptor(
      GoalService,
      [
        {
          enabled: type === 'main',
          injection: options.goal,
        } satisfies GoalServiceOptions,
      ],
      true,
    ),
  );
}

function configureCronService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
  type: AgentRuntimeType,
): void {
  services.set(
    ICronService,
    new SyncDescriptor(
      CronService,
      [cronServiceOptions(options, type)],
      !isCronEnabled(options, type),
    ),
  );
}

function configureSubagentHostService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  if (options.subagentHost === undefined) {
    services.set(ISubagentHost, new MissingSubagentHostService());
    return;
  }

  services.set(
    ISubagentHost,
    new SyncDescriptor(SubagentHostService, [options.subagentHost], true),
  );
}

function configureSwarmModeService(
  services: ServiceCollection,
  options: AgentRuntimeOptions,
): void {
  services.set(
    ISwarmMode,
    new SyncDescriptor(
      SwarmModeService,
      [
        {
          registerAgentSwarmTool: options.subagentHost !== undefined,
        } satisfies SwarmModeServiceOptions,
      ],
      true,
    ),
  );
}

function createAgentRuntimeDisposables(
  instantiation: IInstantiationService,
  options: AgentRuntimeOptions,
): readonly IDisposable[] {
  const disposables: IDisposable[] = [];
  const pluginSessionStart = registerPluginSessionStartInjection(
    instantiation,
    options,
  );
  if (pluginSessionStart !== undefined) {
    disposables.push(pluginSessionStart);
  }
  for (const injection of options.dynamicInjections ?? []) {
    disposables.push(
      getService(instantiation, IDynamicInjector).register(
        injection.variant,
        injection.provider,
      ),
    );
  }
  return disposables;
}

function registerPluginSessionStartInjection(
  instantiation: IInstantiationService,
  options: AgentRuntimeOptions,
): IDisposable | undefined {
  const sessionStarts = options.pluginSessionStarts ?? [];
  const catalog = options.skills ?? undefined;
  if (sessionStarts.length === 0 || catalog === undefined) return undefined;

  return getService(instantiation, IDynamicInjector).register(
    'plugin_session_start',
    ({ injectedAt }) => {
      if (injectedAt !== null) return undefined;

      const blocks: string[] = [];
      for (const sessionStart of sessionStarts) {
        const skill = catalog.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
        if (skill === undefined) {
          warnPluginSessionStartSkillNotFound(instantiation, sessionStart);
          continue;
        }
        blocks.push(
          renderPluginSessionStartBlock(
            sessionStart,
            skill,
            catalog.renderSkillPrompt(skill, ''),
          ),
        );
      }
      return blocks.length === 0 ? undefined : blocks.join('\n');
    },
  );
}

function renderPluginSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  skill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeXmlAttr(skill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}

function warnPluginSessionStartSkillNotFound(
  instantiation: IInstantiationService,
  sessionStart: EnabledPluginSessionStart,
): void {
  try {
    getService(instantiation, ILogService).warn(
      {
        pluginId: sessionStart.pluginId,
        skillName: sessionStart.skillName,
      },
      'plugin sessionStart skill not found',
    );
  } catch {
    return;
  }
}

function activateAgentServices(instantiation: IInstantiationService): void {
  instantiation.invokeFunction((accessor) => {
    accessor.get(IWireRecord);
    accessor.get(IEventBus);
    accessor.get(IReplayBuilderService);
    accessor.get(IContextMemory);
    accessor.get(IContextSizeService).getStatus();
    accessor.get(ITelemetryService);
    accessor.get(IProfileService).data();
    // Force real BackgroundService construction before restore/replay registers its hooks.
    void accessor.get(IBackgroundService).list;
    accessor.get(ILLMRequestLogService);
    accessor.get(IToolRegistry);
    accessor.get(IToolStoreService);
    accessor.get(ITodoListService);
    accessor.get(IUserToolService);
    accessor.get(ISubagentHost);
    // Force real (non-proxy) construction so the MCP status-change listener
    // registered in the constructor is live before restore/replay runs.
    void accessor.get(IMcpRuntimeService).oauthService;
    accessor.get(IExternalHooksService);
    accessor.get(IPermissionRulesService);
    void accessor.get(IPermissionModeService).mode;
    // Force real construction so the plan_mode.enter/cancel/exit wire
    // resumers registered in the constructor are live before replay.
    void accessor.get(IPlanModeService).isActive;
    accessor.get(IPermissionPolicyService);
    accessor.get(IPermissionService).data();
    accessor.get(IUsageService);
    accessor.get(IGoalService);
    accessor.get(IDynamicInjector);
    accessor.get(IMicroCompactionService);
    accessor.get(IContextProjector);
    accessor.get(ILLMRequester);
    accessor.get(IToolExecutor);
    // Force real construction so the loop-service-reconcile (onSpliced) and
    // finish-resume (onResumeEnded) hooks registered in the constructor are
    // live before restore/replay runs.
    void accessor.get(ILoopService).runTurn;
    accessor.get(ITurnRunner);
    accessor.get(IPromptService);
    accessor.get(IAgentRPCService);
    accessor.get(ICronService);
    accessor.get(IFullCompaction);
    void accessor.get(ISwarmMode).isActive;
    // Force-construct AgentSkillService so skill.activate records can replay.
    void accessor.get(IAgentSkillService).activate;
  });
}

function backgroundServiceOptions(
  options: AgentRuntimeOptions,
): BackgroundServiceOptions {
  const background = options.background === false ? undefined : options.background;
  return {
    persistence:
      background?.persistence ??
      (options.background === false || options.homedir === undefined
        ? undefined
        : new BackgroundTaskPersistence(options.homedir)),
    maxRunningTasks: background?.maxRunningTasks,
  };
}

function cronServiceOptions(
  options: AgentRuntimeOptions,
  type: AgentRuntimeType,
): CronOptions {
  const cron = options.cron === false ? undefined : options.cron;
  const enabled = isCronEnabled(options, type);
  return {
    persistence: enabled ? cron?.persistence : undefined,
    homedir: enabled ? (cron?.homedir ?? options.homedir) : undefined,
    clocks: cron?.clocks,
    pollIntervalMs: cron?.pollIntervalMs,
    autoStart: enabled ? cron?.autoStart : false,
    registerTools: enabled ? cron?.registerTools : false,
    onPersistenceError: cron?.onPersistenceError,
    isSubagent: !enabled,
  };
}

function telemetryClient(options: AgentRuntimeOptions): TelemetryClient {
  const client = options.telemetry ?? noopTelemetryClient;
  if (options.sessionId === undefined) return client;
  return withTelemetryContext(client, { sessionId: options.sessionId });
}

function isCronEnabled(
  options: AgentRuntimeOptions,
  type: AgentRuntimeType,
): boolean {
  return type !== 'sub' && options.cron !== false;
}

function currentCwd(cwd: AgentRuntimeOptions['cwd']): string | undefined {
  return typeof cwd === 'function' ? cwd() : cwd;
}

function blobDir(homedir: string | undefined): string | undefined {
  return homedir === undefined ? undefined : join(homedir, 'blobs');
}

function getService<T>(
  instantiation: IInstantiationService,
  id: ServiceIdentifier<T>,
): T {
  return instantiation.invokeFunction((accessor) => accessor.get(id));
}

function isBlobStoreInstance(
  value: AgentRuntimeOptions['blobStore'],
): value is IBlobStoreService {
  return (
    typeof value === 'object' &&
    value !== null &&
    'offloadParts' in value &&
    'rehydrateParts' in value
  );
}

class MissingSubagentHostService implements SubagentHostServiceShape {
  declare readonly _serviceBrand: undefined;

  getSwarmItem(_agentId: string): string | undefined {
    return undefined;
  }

  startBtw(): Promise<string> {
    throw new Error('Subagent host is not configured.');
  }

  generateAgentsMd(): Promise<void> {
    throw new Error('Subagent host is not configured.');
  }

  runQueued<T>(
    _tasks: readonly QueuedSubagentTask<T>[],
  ): Promise<Array<SubagentResult<T>>> {
    throw new Error('Subagent host is not configured.');
  }
}
