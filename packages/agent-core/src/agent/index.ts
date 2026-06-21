import { join } from 'pathe';

import { ErrorCodes, makeErrorPayload } from '#/errors';
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
  type IInstantiationService,
} from '../di';
import { BackgroundTaskPersistence, IBackgroundService } from './background';
import { IDomainEventBus } from '../event/event-bus';
import { ILifecycleService } from './lifecycle';
import {
  type CompactionStrategy,
  ICompactionService,
  IMicroCompactionService,
  type MicroCompactionConfig,
} from './compaction';
import { ICronService } from './cron';
import { IAgentConfigService } from './config';
import { IContextService } from './context';
import { IGoalService } from './goal';
import { type IHookService } from '../session/hooks';
import { IInjectionService } from './injection/manager';
import { IPermissionService, type PermissionManagerOptions } from './permission';
import { IPlanService } from './plan';
import {
  BlobStore,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
  type AgentRecordsReplayOptions,
  IRecordsService,
} from './records';
import { IReplayService, type ReplayBuilderOptions } from './replay';
import { IAgentSkillService } from './skill';
import type { SkillRegistry } from './skill/types';
import { ISwarmService } from './swarm';
import { IAgentToolService } from './tool/index';
import { ITurnService } from './turn';
import { KosongLLM } from './turn/kosong-llm';
import { IUsageService } from './usage';
import { AgentStatusService, IAgentStatusService } from './status';
import { AgentRpcController } from './rpc-controller';
import type { AgentRpcHost, IAgentRpcController } from './rpc-controller';
import { AgentResumeService } from './resume';
import type { AgentResumeHost, IAgentResumeService } from './resume';
import { AgentProfileService } from './profile';
import type { AgentProfileHost, IAgentProfileService } from './profile';
import { AgentFactory } from './factory';
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
  readonly rpcController: IAgentRpcController;
  readonly resumeService: IAgentResumeService;
  readonly profileService: IAgentProfileService;
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

    const perAgentServices = AgentFactory.buildServiceCollection(
      this,
      options,
      recordsPersistence,
      backgroundPersistence,
    );
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
    this.rpcController = new AgentRpcController(this satisfies AgentRpcHost);
    this.resumeService = new AgentResumeService(this satisfies AgentResumeHost);
    this.profileService = new AgentProfileService(this satisfies AgentProfileHost);
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
    this.profileService.useProfile(profile, context);
  }

  async resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }> {
    return this.resumeService.resume(options);
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
    return this.rpcController.rpcMethods;
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
