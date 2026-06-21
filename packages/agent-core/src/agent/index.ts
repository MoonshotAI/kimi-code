import { join } from 'pathe';

import { ErrorCodes, KimiError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { AgentAPI, AgentEvent, KimiConfig, SDKAgentRPC } from '#/rpc';
import { generate } from '@moonshot-ai/kosong';

import type { EnabledPluginSessionStart } from '#/plugin';

import type { IMcpConnectionService } from '../mcp';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import type { PreparedSystemPromptContext, ResolvedAgentProfile } from '../profile';
import type { ModelProvider } from '../session/provider-manager';
import type { ISubagentHostService } from '../session/subagent-host';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import type { PromisableMethods } from '../utils/types';
import {
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
  type IInstantiationService,
} from '../di';
import { BackgroundService, BackgroundTaskPersistence, IBackgroundService } from './background';
import { DomainEventBus, IDomainEventBus } from '../event/event-bus';
import { ILifecycleService, LifecycleService } from './lifecycle';
import {
  CompactionService,
  MicroCompactionService,
  type CompactionStrategy,
  ICompactionService,
  IMicroCompactionService,
  type MicroCompactionConfig,
} from './compaction';
import { CronService, ICronService } from './cron';
import { AgentConfigService, IAgentConfigService } from './config';
import { ContextService, IContextService } from './context';
import { GoalService, IGoalService } from './goal';
import { type IHookService } from '../session/hooks';
import { InjectionService, IInjectionService } from './injection/manager';
import { PermissionService, IPermissionService, type PermissionManagerOptions } from './permission';
import { PlanService, IPlanService } from './plan';
import {
  BlobStore,
  FileSystemAgentRecordPersistence,
  RecordsService,
  type AgentRecord,
  type AgentRecordPersistence,
  type AgentRecordsReplayOptions,
  IRecordsService,
} from './records';
import { ReplayService, IReplayService, type ReplayBuilderOptions } from './replay';
import { AgentSkillService, IAgentSkillService } from './skill';
import type { SkillRegistry } from './skill/types';
import { SwarmService, ISwarmService } from './swarm';
import { AgentToolService, IAgentToolService } from './tool/index';
import { TurnService, ITurnService } from './turn';
import { KosongLLM } from './turn/kosong-llm';
import { UsageService, IUsageService } from './usage';
import { AgentStatusService, IAgentStatusService } from './status';
import type { AgentStatusHost } from './status';
import { LlmService } from './llm';
import type { ILlmService } from './llm';
import { LlmRequestLogger } from './llm-request-logger';
import type { Kaos } from '@moonshot-ai/kaos';
import type { ToolServices } from '../tools/support/services';

export type { AgentRecord, AgentRecordPersistence } from './records';
export type { SwarmModeTrigger } from './swarm';
export type { BuiltinTool, ToolInfo, ToolSource, UserToolRegistration } from './tool';
export * from './goal';

export type AgentType = 'main' | 'sub' | 'independent';

export interface AgentOptions {
  readonly kaos: Kaos;
  readonly config?: KimiConfig;
  readonly homedir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly persistence?: AgentRecordPersistence;
  readonly type?: AgentType;
  readonly id?: string;
  readonly generate?: typeof generate;
  readonly toolServices?: ToolServices;
  readonly compactionStrategy?: CompactionStrategy;
  readonly microCompaction?: Partial<MicroCompactionConfig>;
  readonly modelProvider?: ModelProvider | undefined;
  readonly subagentHost?: ISubagentHostService | undefined;
  readonly skills?: SkillRegistry;
  readonly mcp?: IMcpConnectionService;
  readonly hookEngine?: IHookService;
  readonly permission?: PermissionManagerOptions | undefined;
  readonly log?: Logger;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly experimentalFlags?: ExperimentalFlagResolver;
  readonly replay?: ReplayBuilderOptions;
  readonly instantiationService?: IInstantiationService | undefined;
}

export class Agent {
  readonly type: AgentType;
  readonly id: string | undefined;
  private _kaos: Kaos;

  get kaos(): Kaos {
    return this._kaos;
  }

  readonly kimiConfig?: KimiConfig;
  readonly homedir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly toolServices?: ToolServices;
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  readonly rawGenerate: typeof generate;
  readonly modelProvider?: ModelProvider;
  readonly subagentHost?: ISubagentHostService;
  readonly mcp?: IMcpConnectionService;
  readonly hooks?: IHookService;
  readonly log: Logger;
  readonly telemetry: TelemetryClient;
  readonly experimentalFlags: ExperimentalFlagResolver;

  readonly llmRequestLogger: LlmRequestLogger;
  readonly llmService: ILlmService;
  readonly blobStore: BlobStore | undefined;
  readonly records: IRecordsService;
  readonly fullCompaction: ICompactionService;
  readonly microCompaction: IMicroCompactionService;
  readonly context: IContextService;
  readonly config: IAgentConfigService;
  readonly turn: ITurnService;
  readonly injection: IInjectionService;
  readonly permission: IPermissionService;
  readonly planMode: IPlanService;
  readonly swarmMode: ISwarmService;
  readonly usage: IUsageService;
  readonly statusService: IAgentStatusService;
  readonly eventBus: IDomainEventBus;
  readonly lifecycle: ILifecycleService;
  private readonly scope: IInstantiationService;
  readonly skills: IAgentSkillService | null;
  readonly tools: IAgentToolService;
  readonly background: IBackgroundService;
  readonly cron: ICronService | null;
  readonly goal: IGoalService;
  readonly replayBuilder: IReplayService;

  constructor(options: AgentOptions) {
    this.type = options.type ?? 'main';
    this.id = options.id;
    this._kaos = options.kaos;
    this.kimiConfig = options.config;
    this.homedir = options.homedir;
    this.rpc = options.rpc;
    this.toolServices = options.toolServices;
    this.pluginSessionStarts = options.pluginSessionStarts ?? [];
    this.rawGenerate = options.generate ?? generate;
    this.modelProvider = options.modelProvider;
    this.subagentHost = options.subagentHost;
    this.mcp = options.mcp;
    this.hooks = options.hookEngine;
    this.log = options.log ?? log;
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.experimentalFlags = options.experimentalFlags ?? new FlagResolver();

    this.llmRequestLogger = new LlmRequestLogger(this.log);
    this.blobStore = options.homedir
      ? new BlobStore({ blobsDir: join(options.homedir, 'blobs') })
      : undefined;
    const recordsPersistence =
      options.persistence ??
      (options.homedir
        ? new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), {
            onError: (error) => {
              this.emitRecordsWriteError(error);
            },
            blobStore: this.blobStore,
          })
        : undefined);
    const backgroundPersistence =
      this.homedir === undefined ? undefined : new BackgroundTaskPersistence(this.homedir);

    const perAgentServices = new ServiceCollection();
    perAgentServices.set(IRecordsService, new SyncDescriptor(RecordsService, [this, recordsPersistence]));
    perAgentServices.set(
      ICompactionService,
      new SyncDescriptor(CompactionService, [this, options.compactionStrategy]),
    );
    perAgentServices.set(
      IMicroCompactionService,
      new SyncDescriptor(MicroCompactionService, [this, options.microCompaction]),
    );
    perAgentServices.set(IContextService, new SyncDescriptor(ContextService, [this]));
    perAgentServices.set(IAgentConfigService, new SyncDescriptor(AgentConfigService, [this]));
    perAgentServices.set(ITurnService, new SyncDescriptor(TurnService, [this]));
    perAgentServices.set(IInjectionService, new SyncDescriptor(InjectionService, [this]));
    perAgentServices.set(
      IPermissionService,
      new SyncDescriptor(PermissionService, [this, options.permission]),
    );
    perAgentServices.set(
      IAgentStatusService,
      new SyncDescriptor(AgentStatusService, [this satisfies AgentStatusHost]),
    );
    perAgentServices.set(
      IPlanService,
      new SyncDescriptor(PlanService, [this.kaos, this.homedir]),
    );
    perAgentServices.set(ISwarmService, new SyncDescriptor(SwarmService));
    perAgentServices.set(IUsageService, new SyncDescriptor(UsageService));
    perAgentServices.set(IAgentToolService, new SyncDescriptor(AgentToolService, [this]));
    perAgentServices.set(
      IBackgroundService,
      new SyncDescriptor(BackgroundService, [this, backgroundPersistence]),
    );
    perAgentServices.set(IReplayService, new SyncDescriptor(ReplayService, [options.replay]));
    perAgentServices.set(
      IDomainEventBus,
      new SyncDescriptor(DomainEventBus, [
        (event: AgentEvent) => {
          if (!this.records.restoring) void this.rpc?.emitEvent?.(event);
        },
      ]),
    );
    perAgentServices.set(ILifecycleService, new SyncDescriptor(LifecycleService, []));
    perAgentServices.set(
      IGoalService,
      new SyncDescriptor(GoalService, [this.telemetry, (event: AgentEvent) => { this.eventBus.publish(event); }]),
    );
    if (options.skills !== undefined) {
      perAgentServices.set(
        IAgentSkillService,
        new SyncDescriptor(AgentSkillService, [this, options.skills]),
      );
    }
    if (this.type !== 'sub') {
      perAgentServices.set(ICronService, new SyncDescriptor(CronService, [this]));
    }
    this.scope = (options.instantiationService ?? new InstantiationService(undefined, true)).createChild(
      perAgentServices,
    );

    this.eventBus = this.scope.invokeFunction((accessor) => accessor.get(IDomainEventBus));
    this.lifecycle = this.scope.invokeFunction((accessor) => accessor.get(ILifecycleService));
    // Constructor is synchronous, so lifecycle hooks here are fire-and-forget;
    // WillCreate fires as soon as the lifecycle service is resolved (the
    // earliest point an `agentId` + lifecycle are both available).
    if (this.id !== undefined) {
      void this.lifecycle.fireAgentWillCreate({ agentId: this.id });
    }
    this.records = this.scope.invokeFunction((accessor) => accessor.get(IRecordsService));
    this.fullCompaction = this.scope.invokeFunction((accessor) => accessor.get(ICompactionService));
    this.microCompaction = this.scope.invokeFunction((accessor) =>
      accessor.get(IMicroCompactionService),
    );
    this.context = this.scope.invokeFunction((accessor) => accessor.get(IContextService));
    this.config = this.scope.invokeFunction((accessor) => accessor.get(IAgentConfigService));
    this.llmService = new LlmService({
      config: this.config,
      llmRequestLogger: this.llmRequestLogger,
      rawGenerate: this.rawGenerate,
      modelProvider: this.modelProvider,
      log: this.log,
      kimiConfig: this.kimiConfig,
    });
    this.turn = this.scope.invokeFunction((accessor) => accessor.get(ITurnService));
    this.injection = this.scope.invokeFunction((accessor) => accessor.get(IInjectionService));
    this.permission = this.scope.invokeFunction((accessor) => accessor.get(IPermissionService));
    this.planMode = this.scope.invokeFunction((accessor) => accessor.get(IPlanService));
    this.swarmMode = this.scope.invokeFunction((accessor) => accessor.get(ISwarmService));
    this.usage = this.scope.invokeFunction((accessor) => accessor.get(IUsageService));
    this.statusService = this.scope.invokeFunction((accessor) => accessor.get(IAgentStatusService));
    this.skills = options.skills
      ? this.scope.invokeFunction((accessor) => accessor.get(IAgentSkillService))
      : null;
    this.tools = this.scope.invokeFunction((accessor) => accessor.get(IAgentToolService));
    this.background = this.scope.invokeFunction((accessor) => accessor.get(IBackgroundService));
    this.cron =
      this.type === 'sub'
        ? null
        : this.scope.invokeFunction((accessor) => accessor.get(ICronService));
    this.goal = this.scope.invokeFunction((accessor) => accessor.get(IGoalService));
    this.replayBuilder = this.scope.invokeFunction((accessor) => accessor.get(IReplayService));
    if (this.id !== undefined) {
      void this.lifecycle.fireAgentDidCreate({ agentId: this.id });
    }
  }

  setKaos(kaos: Kaos) {
    this._kaos = kaos;
  }

  get generate(): typeof generate {
    return this.llmService.generate;
  }

  get llm(): KosongLLM {
    return this.llmService.llm;
  }

  useProfile(profile: ResolvedAgentProfile, context?: PreparedSystemPromptContext): void {
    const systemPrompt = profile.systemPrompt({
      osEnv: this.kaos.osEnv,
      cwd: this.config.cwd,
      skills: this.skills?.registry,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
    });
    this.config.update({ profileName: profile.name, systemPrompt });
    this.tools.setActiveTools(profile.tools);
  }

  async resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }> {
    if (this.id !== undefined) {
      await this.lifecycle.fireAgentWillResume({ agentId: this.id });
    }
    const result = await this.records.replay(options);
    try {
      this.replayBuilder.postRestoring = true;
      this.goal.normalizeAfterReplay();
      await this.background.loadFromDisk();
      await this.background.reconcile();
      await this.cron?.loadFromDisk();
      this.context.finishResume();
      this.turn.finishResume();
    } finally {
      this.replayBuilder.postRestoring = false;
    }
    if (this.id !== undefined) {
      await this.lifecycle.fireAgentDidResume({ agentId: this.id });
    }
    return result;
  }

  /**
   * Marks the agent teardown boundary by firing `fireAgentWillDispose`. The
   * actual teardown (cron stop, background tasks, turn cancellation) is
   * orchestrated by the owning `Session`; this method exists so the lifecycle
   * hook fires from the agent boundary before that teardown runs.
   */
  async dispose(): Promise<void> {
    if (this.id !== undefined) {
      await this.lifecycle.fireAgentWillDispose({ agentId: this.id });
    }
  }

  get rpcMethods(): PromisableMethods<AgentAPI> {
    return {
      prompt: (payload) => {
        this.turn.prompt(payload.input);
      },
      steer: (payload) => {
        this.telemetry.track('input_steer', { parts: payload.input.length });
        this.turn.steer(payload.input);
      },
      cancel: (payload) => {
        if (this.turn.hasActiveTurn) {
          this.telemetry.track('cancel', { from: 'streaming' });
        }
        this.turn.cancel(payload.turnId);
      },
      undoHistory: (payload) => {
        this.context.undo(payload.count);
      },
      setThinking: (payload) => {
        const wasEnabled = this.config.thinkingLevel !== 'off';
        this.config.update({ thinkingLevel: payload.level });
        const enabled = this.config.thinkingLevel !== 'off';
        if (enabled !== wasEnabled) {
          this.telemetry.track('thinking_toggle', { enabled });
        }
      },
      setPermission: (payload) => {
        const wasYolo = this.permission.mode === 'yolo';
        const wasAuto = this.permission.mode === 'auto';
        this.permission.setMode(payload.mode);
        const enabled = this.permission.mode === 'yolo';
        if (enabled !== wasYolo) {
          this.telemetry.track('yolo_toggle', { enabled });
        }
        const afkEnabled = this.permission.mode === 'auto';
        if (afkEnabled !== wasAuto) {
          this.telemetry.track('afk_toggle', { enabled: afkEnabled });
        }
      },
      setModel: (payload) => {
        // Validate the alias resolves before recording it so resume / runtime
        // callers fail fast on missing aliases instead of deferring to the
        // next prompt.
        const resolved = this.modelProvider?.resolveProviderConfig(payload.model);
        if (this.config.modelAlias !== payload.model) {
          this.config.update({ modelAlias: payload.model });
          this.telemetry.track('model_switch', { model: payload.model });
        }
        return {
          model: payload.model,
          providerName: resolved?.providerName,
        };
      },
      getModel: () => {
        return this.config.modelAlias ?? '';
      },
      enterPlan: async () => {
        await this.planMode.enter();
      },
      cancelPlan: (payload) => {
        this.planMode.cancel(payload.id);
      },
      clearPlan: () => this.planMode.clear(),
      enterSwarm: (payload) => {
        this.swarmMode.enter(payload.trigger);
      },
      exitSwarm: () => {
        this.swarmMode.exit();
      },
      getSwarmMode: () => {
        return this.swarmMode.isActive;
      },
      beginCompaction: (payload) => {
        this.fullCompaction.begin({ source: 'manual', instruction: payload.instruction });
      },
      cancelCompaction: () => {
        if (this.fullCompaction.isCompacting) {
          this.telemetry.track('cancel', { from: 'compacting' });
        }
        this.fullCompaction.cancel();
      },
      registerTool: (payload) => {
        this.tools.registerUserTool(payload);
      },
      unregisterTool: (payload) => {
        this.tools.unregisterUserTool(payload.name);
      },
      setActiveTools: (payload) => {
        this.tools.setActiveTools(payload.names);
      },
      stopBackground: (payload) => {
        void this.background.stop(payload.taskId, payload.reason);
      },
      clearContext: () => {
        this.context.clear();
      },
      activateSkill: (payload) => {
        if (this.skills === null) {
          throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
        }
        this.skills.activate(payload);
      },
      startBtw: () => this.subagentHost!.startBtw(),
      createGoal: (payload) => this.goal.createGoal(payload),
      getGoal: () => this.goal.getGoal(),
      pauseGoal: () => this.goal.pauseGoal(),
      resumeGoal: () => this.goal.resumeGoal(),
      cancelGoal: () => this.goal.cancelGoal(),
      getBackgroundOutput: (payload) => this.background.readOutput(payload.taskId, payload.tail),
      getContext: () => this.context.data(),
      getConfig: () => this.config.data(),
      getPermission: () => this.permission.data(),
      getPlan: () => this.planMode.data(),
      getUsage: () => this.usage.data(),
      getTools: () => this.tools.data(),
      getBackground: (payload) => this.background.list(payload.activeOnly ?? false, payload.limit),
    };
  }

  emitEvent(event: AgentEvent): void {
    this.eventBus.publish(event);
  }

  /**
   * Thin delegate preserved for callers (context / config / permission) that
   * historically triggered a status refresh through the agent. The
   * `agent.status.updated` emission now lives in {@link AgentStatusService}.
   */
  emitStatusUpdated(): void {
    this.statusService.notifyStatusChanged();
  }

  private emitRecordsWriteError(error: unknown, record?: AgentRecord | undefined): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('wire record persist failed', {
      agentHomedir: this.homedir,
      recordType: record?.type,
      error,
    });
    this.emitEvent({
      type: 'error',
      ...makeErrorPayload(
        ErrorCodes.RECORDS_WRITE_FAILED,
        `Failed to write agent records: ${message}`,
        {
          details: { recordType: record?.type },
        },
      ),
    });
  }
}
