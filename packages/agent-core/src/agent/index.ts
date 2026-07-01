import { join } from 'pathe';
import { randomUUID } from 'node:crypto';

import { normalizeAdditionalDirs } from '../config';
import { ErrorCodes, KimiError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { AgentAPI, AgentEvent, KimiConfig, SDKAgentRPC, UsageStatus } from '#/rpc';
import { generate } from '@moonshot-ai/kosong';

import type { EnabledPluginSessionStart, PluginCommandDef } from '#/plugin';
import { expandCommandArguments } from '../plugin/commands';
import type { PluginCommandOrigin } from './context';

import type { McpConnectionManager } from '../mcp';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import {
  prepareSystemPromptContext,
  type PreparedSystemPromptContext,
  type ResolvedAgentProfile,
} from '../profile';
import type { ModelProvider } from '../session/provider-manager';
import type { SessionSubagentHost } from '../session/subagent-host';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import type { PromisableMethods } from '../utils/types';
import { BackgroundManager, BackgroundTaskPersistence } from './background';
import {
  FullCompaction,
  MicroCompaction,
  type CompactionStrategy,
  type MicroCompactionConfig,
} from './compaction';
import { CronManager } from './cron';
import { ConfigState } from './config';
import { ContextMemory } from './context';
import { GoalMode } from './goal';
import { HookEngine } from '../session/hooks';
import { InjectionManager } from './injection/manager';
import { PermissionManager, type PermissionManagerOptions } from './permission';
import { PlanMode } from './plan';
import {
  AgentRecords,
  BlobStore,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
  type AgentRecordsReplayOptions,
} from './records';
import { ReplayBuilder, type ReplayBuilderOptions } from './replay';
import { SkillManager } from './skill';
import type { SkillRegistry } from './skill/types';
import { SwarmMode } from './swarm';
import { ToolManager } from './tool/index';
import { TurnFlow } from './turn';
import { KosongLLM } from './turn/kosong-llm';
import { UsageRecorder } from './usage';
import { LlmRequestLogger, splitGenerateOptions } from './llm-request-logger';
import { resolveCompletionBudget } from '../utils/completion-budget';
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
  readonly generate?: typeof generate;
  readonly toolServices?: ToolServices;
  readonly compactionStrategy?: CompactionStrategy;
  readonly microCompaction?: Partial<MicroCompactionConfig>;
  readonly modelProvider?: ModelProvider | undefined;
  readonly subagentHost?: SessionSubagentHost | undefined;
  readonly skills?: SkillRegistry;
  readonly mcp?: McpConnectionManager;
  readonly hookEngine?: HookEngine;
  readonly permission?: PermissionManagerOptions | undefined;
  readonly log?: Logger;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
  readonly pluginCommands?: readonly PluginCommandDef[];
  readonly experimentalFlags?: ExperimentalFlagResolver;
  readonly replay?: ReplayBuilderOptions;
  readonly additionalDirs?: readonly string[];
  readonly systemPromptContextProvider?: (() => Promise<PreparedSystemPromptContext>) | undefined;
}

export class Agent {
  readonly type: AgentType;
  private _kaos: Kaos;

  get kaos(): Kaos {
    return this._kaos;
  }

  readonly kimiConfig?: KimiConfig;
  readonly homedir?: string;
  readonly rpc?: Partial<SDKAgentRPC>;
  readonly toolServices?: ToolServices;
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  readonly pluginCommands: readonly PluginCommandDef[];
  readonly rawGenerate: typeof generate;
  readonly modelProvider?: ModelProvider;
  readonly subagentHost?: SessionSubagentHost;
  readonly mcp?: McpConnectionManager;
  readonly hooks?: HookEngine;
  readonly log: Logger;
  readonly telemetry: TelemetryClient;
  readonly experimentalFlags: ExperimentalFlagResolver;

  readonly llmRequestLogger: LlmRequestLogger;
  readonly blobStore: BlobStore | undefined;
  readonly records: AgentRecords;
  readonly fullCompaction: FullCompaction;
  readonly microCompaction: MicroCompaction;
  readonly context: ContextMemory;
  readonly config: ConfigState;
  readonly turn: TurnFlow;
  readonly injection: InjectionManager;
  readonly permission: PermissionManager;
  readonly planMode: PlanMode;
  readonly swarmMode: SwarmMode;
  readonly usage: UsageRecorder;
  readonly skills: SkillManager | null;
  readonly tools: ToolManager;
  readonly background: BackgroundManager;
  readonly cron: CronManager | null;
  readonly goal: GoalMode;
  readonly replayBuilder: ReplayBuilder;

  private additionalDirs: readonly string[];
  private activeProfile?: ResolvedAgentProfile;
  private brandHome?: string;
  private readonly systemPromptContextProvider?: (() => Promise<PreparedSystemPromptContext>) | undefined;

  constructor(options: AgentOptions) {
    this.type = options.type ?? 'main';
    this._kaos = options.kaos;
    this.kimiConfig = options.config;
    this.homedir = options.homedir;
    this.rpc = options.rpc;
    this.toolServices = options.toolServices;
    this.pluginSessionStarts = options.pluginSessionStarts ?? [];
    this.pluginCommands = options.pluginCommands ?? [];
    this.rawGenerate = options.generate ?? generate;
    this.modelProvider = options.modelProvider;
    this.subagentHost = options.subagentHost;
    this.mcp = options.mcp;
    this.hooks = options.hookEngine;
    this.log = options.log ?? log;
    this.telemetry = options.telemetry ?? noopTelemetryClient;
    this.experimentalFlags = options.experimentalFlags ?? new FlagResolver();
    this.additionalDirs = normalizeAdditionalDirs(options.additionalDirs ?? []);
    this.systemPromptContextProvider = options.systemPromptContextProvider;

    this.llmRequestLogger = new LlmRequestLogger(this.log);
    this.blobStore = options.homedir
      ? new BlobStore({ blobsDir: join(options.homedir, 'blobs') })
      : undefined;
    this.records = new AgentRecords(
      this,
      options.persistence ??
        (options.homedir
          ? new FileSystemAgentRecordPersistence(join(options.homedir, 'wire.jsonl'), {
              onError: (error) => {
                this.emitRecordsWriteError(error);
              },
              blobStore: this.blobStore,
            })
          : undefined),
    );
    this.fullCompaction = new FullCompaction(this, options.compactionStrategy);
    this.microCompaction = new MicroCompaction(this, options.microCompaction);
    this.context = new ContextMemory(this);
    this.config = new ConfigState(this);
    this.turn = new TurnFlow(this);
    this.injection = new InjectionManager(this);
    this.permission = new PermissionManager(this, options.permission);
    this.planMode = new PlanMode(this);
    this.swarmMode = new SwarmMode(this);
    this.usage = new UsageRecorder(this);
    this.skills = options.skills ? new SkillManager(this, options.skills) : null;
    this.tools = new ToolManager(this);
    this.background = new BackgroundManager(
      this,
      this.homedir === undefined ? undefined : new BackgroundTaskPersistence(this.homedir),
    );
    this.cron = this.type === 'sub' ? null : new CronManager(this);
    this.goal = new GoalMode(this);
    this.replayBuilder = new ReplayBuilder(this, options.replay);
  }

  setKaos(kaos: Kaos) {
    this._kaos = kaos;
  }

  getAdditionalDirs(): readonly string[] {
    return this.additionalDirs;
  }

  setAdditionalDirs(additionalDirs: readonly string[]): void {
    this.additionalDirs = normalizeAdditionalDirs(additionalDirs);
    if (this.config.hasProvider) {
      this.tools.initializeBuiltinTools();
    }
  }

  get generate(): typeof generate {
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      const { requestLogFields, generateOptions } = splitGenerateOptions(options);
      const modelAlias = this.config.modelAlias;
      const run = (requestOptions: Parameters<typeof generate>[5]) => {
        this.llmRequestLogger.logRequest({
          provider,
          modelAlias,
          systemPrompt,
          tools,
          messages: history,
          fields: requestLogFields,
        });
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, requestOptions);
      };
      if (generateOptions?.auth !== undefined) {
        return run(generateOptions);
      }
      const withAuth =
        modelAlias === undefined
          ? undefined
          : this.modelProvider?.resolveAuth?.(modelAlias, { log: this.log });
      if (withAuth === undefined) {
        return run(generateOptions);
      }
      return withAuth((auth) => {
        return run({ ...generateOptions, auth });
      });
    };
  }

  get llm(): KosongLLM {
    // All provider-level request config (thinking, sampling params, thinking.keep)
    // is applied in ConfigState.provider so compaction shares it. See get provider().
    const provider = this.config.provider;
    const loopControl = this.kimiConfig?.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      maxOutputSize: this.config.maxOutputSize,
      reservedContextSize: loopControl?.reservedContextSize,
    });
    return new KosongLLM({
      provider,
      systemPrompt: this.config.systemPrompt,
      capability: this.config.modelCapabilities,
      generate: this.generate,
      completionBudgetConfig,
      usedContextTokens: () => this.context.tokenCount,
    });
  }

  useProfile(
    profile: ResolvedAgentProfile,
    context?: PreparedSystemPromptContext,
    brandHome?: string,
  ): void {
    this.setActiveProfile(profile, brandHome);
    this.updateSystemPromptFromProfile(profile, context);
    this.tools.setActiveTools(profile.tools);
  }

  setActiveProfile(profile: ResolvedAgentProfile, brandHome?: string): void {
    this.activeProfile = profile;
    this.brandHome = brandHome;
  }

  /**
   * Re-render the system prompt with freshly gathered runtime context (cwd
   * listing, AGENTS.md, additional-dirs info, skill list). Called after
   * compaction so the post-compaction turns do not keep a snapshot captured
   * at session bootstrap. Invalidates the prompt-cache prefix by design.
   */
  async refreshSystemPrompt(): Promise<void> {
    if (this.activeProfile === undefined) return;
    const context = this.systemPromptContextProvider === undefined
      ? await prepareSystemPromptContext(this.kaos, this.brandHome, {
          additionalDirs: this.additionalDirs,
        })
      : await this.systemPromptContextProvider();
    this.updateSystemPromptFromProfile(this.activeProfile, context);
  }

  private updateSystemPromptFromProfile(
    profile: ResolvedAgentProfile,
    context?: PreparedSystemPromptContext,
  ): void {
    const systemPrompt = profile.systemPrompt({
      osEnv: this.kaos.osEnv,
      cwd: this.config.cwd,
      skills: this.skills?.registry,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
      additionalDirsInfo: context?.additionalDirsInfo,
    });
    this.config.update({ profileName: profile.name, systemPrompt });
  }

  async resume(options?: AgentRecordsReplayOptions): Promise<{ warning?: string }> {
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
    return result;
  }

  get rpcMethods(): PromisableMethods<AgentAPI> {
    return {
      prompt: (payload) => {
        this.turn.prompt(payload.input);
      },
      runShellCommand: (payload) => this.tools.runShellCommand(payload.command, payload.commandId),
      cancelShellCommand: (payload) => this.tools.cancelShellCommand(payload.commandId),
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
        this.telemetry.track('conversation_undo', { count: payload.count });
      },
      setThinking: (payload) => {
        const previousEffort = this.config.thinkingEffort;
        this.config.update({ thinkingEffort: payload.effort });
        const effort = this.config.thinkingEffort;
        if (effort !== previousEffort) {
          this.telemetry.track('thinking_toggle', {
            enabled: effort !== 'off',
            effort,
            from: previousEffort,
          });
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
      detachBackground: (payload) => this.background.detach(payload.taskId),
      clearContext: () => {
        this.context.clear();
      },
      activateSkill: (payload) => {
        if (this.skills === null) {
          throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
        }
        this.skills.activate(payload);
      },
      activatePluginCommand: (payload) => {
        const def = this.pluginCommands.find(
          (d) => d.pluginId === payload.pluginId && d.name === payload.commandName,
        );
        if (def === undefined) {
          throw new KimiError(
            ErrorCodes.REQUEST_INVALID,
            `Plugin command "${payload.pluginId}:${payload.commandName}" was not found`,
          );
        }
        const commandArgs = payload.args ?? '';
        const expanded = expandCommandArguments(def.body, commandArgs);
        const origin: PluginCommandOrigin = {
          kind: 'plugin_command',
          activationId: randomUUID(),
          pluginId: payload.pluginId,
          commandName: payload.commandName,
          commandArgs: payload.args,
          trigger: 'user-slash',
        };
        this.emitEvent({
          type: 'plugin_command.activated',
          activationId: origin.activationId,
          pluginId: origin.pluginId,
          commandName: origin.commandName,
          commandArgs: origin.commandArgs,
          trigger: origin.trigger,
        });
        this.turn.prompt([{ type: 'text', text: expanded }], origin);
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
    if (this.records.restoring) return;
    void this.rpc?.emitEvent?.(event);
  }

  emitStatusUpdated(): void {
    if (this.records.restoring) return;
    if (!this.config.hasModel) return;

    const contextTokens = this.context.tokenCount;
    const maxContextTokens = this.config.modelCapabilities.max_context_tokens;
    const contextUsage =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    const usage: UsageStatus | undefined = this.usage.status();
    const model = this.config.model;

    this.emitEvent({
      type: 'agent.status.updated',
      model,
      contextTokens,
      maxContextTokens,
      contextUsage,
      planMode: this.planMode.isActive,
      swarmMode: this.swarmMode.isActive,
      permission: this.permission.mode,
      usage,
    });
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
