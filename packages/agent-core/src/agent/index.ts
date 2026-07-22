import { join } from 'pathe';
import { randomUUID } from 'node:crypto';

import { normalizeAdditionalDirs } from '../config';
import { ErrorCodes, KimiError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { AgentAPI, AgentEvent, KimiConfig, SDKAgentRPC, UsageStatus } from '#/rpc';
import { generate, type ChatProvider } from '@moonshot-ai/kosong';

import type { EnabledPluginSessionStart, PluginCommandDef } from '#/plugin';
import { expandCommandArguments } from '../plugin/commands';
import type { PluginCommandOrigin } from './context';

import type { McpConnectionManager } from '../mcp';
import { FlagResolver, type ExperimentalFlagResolver } from '../flags';
import { ImageLimits } from '../tools/support/image-limits';
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
import { LlmRequestRecorder } from './llm-request-recorder';
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
  /**
   * Session-owned directory for pre-compression image originals
   * (`sessionMediaOriginalsDir(sessionDir)`), threaded to media-producing
   * paths (MCP tool results) so readback originals live with the session
   * rather than in the shared temp-dir fallback.
   */
  readonly mediaOriginalsDir?: string;
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
  /** Owner-scoped [image] limits; a standalone Agent gets env/built-in defaults. */
  readonly imageLimits?: ImageLimits;
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
  readonly mediaOriginalsDir?: string;
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
  readonly imageLimits: ImageLimits;

  readonly llmRequestLogger: LlmRequestLogger;
  readonly llmRequestRecorder: LlmRequestRecorder;
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

  /**
   * Print-mode (`kimi -p`) only: when true and the agent ends a turn while
   * background subagents (`kind === 'agent'`) are still running, the turn loop
   * holds the turn open and idle-waits until they finish, flushing their
   * completions into the turn so the model can react before the run exits. Set
   * by the session for print runs; defaults to false everywhere else.
   */
  printDrainAgentTasksOnStop = false;

  private additionalDirs: readonly string[];
  private activeProfile?: ResolvedAgentProfile;
  private brandHome?: string;
  private readonly emittedThinkingEffortWarnings = new Set<string>();
  private readonly pendingThinkingEffortWarnings: Array<{
    readonly code: string;
    readonly message: string;
    readonly modelAlias: string | undefined;
    readonly model: string;
    readonly effort: string;
    readonly knownEfforts: string | undefined;
  }> = [];
  private readonly systemPromptContextProvider?: (() => Promise<PreparedSystemPromptContext>) | undefined;

  constructor(options: AgentOptions) {
    this.type = options.type ?? 'main';
    this._kaos = options.kaos;
    this.kimiConfig = options.config;
    this.homedir = options.homedir;
    this.mediaOriginalsDir = options.mediaOriginalsDir;
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
    this.imageLimits = options.imageLimits ?? new ImageLimits();
    this.additionalDirs = normalizeAdditionalDirs(options.additionalDirs ?? []);
    this.systemPromptContextProvider = options.systemPromptContextProvider;

    this.llmRequestLogger = new LlmRequestLogger(this.log);
    this.llmRequestRecorder = new LlmRequestRecorder(this);
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

  /**
   * Single decision point for select_tools progressive disclosure. All three
   * gates must be open: the model has the `dynamically_loaded_tools`
   * capability (message-level tool declarations), the model declares
   * `tool_use` (a model without tool use loading tools dynamically is a
   * contradiction), and the `tool-select` experimental flag is on. Every
   * consumer — top-level tools[] convergence, select_tools registration,
   * manifest announcements, projection shaping — reads this instead of
   * re-deriving the conditions, so degradation is lossless: any closed gate
   * reproduces the inline behavior byte-for-byte.
   */
  get toolSelectEnabled(): boolean {
    const capability = this.config.modelCapabilities;
    return (
      capability.dynamically_loaded_tools === true &&
      capability.tool_use &&
      this.experimentalFlags.enabled('tool-select')
    );
  }

  get generate(): typeof generate {
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      const { requestLogFields, generateOptions } = splitGenerateOptions(options);
      const modelAlias = this.config.modelAlias;
      const run = (requestOptions: Parameters<typeof generate>[5]) => {
        // Mirror kosong generate()'s pre-flight abort check: a call whose
        // signal is already aborted never reaches the wire (generate throws
        // before dispatching), so it must not leave a request trace or a
        // diagnostic log line claiming a request was sent.
        if (requestOptions?.signal?.aborted !== true) {
          this.warnAboutAnthropicThinkingEffort(provider, modelAlias);
          this.llmRequestLogger.logRequest({
            provider,
            modelAlias,
            systemPrompt,
            tools,
            messages: history,
            fields: requestLogFields,
          });
          this.llmRequestRecorder.record({
            provider,
            systemPrompt,
            tools,
            messages: history,
            fields: requestLogFields,
          });
        }
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

  private warnAboutAnthropicThinkingEffort(
    provider: ChatProvider,
    modelAlias: string | undefined,
  ): void {
    if (provider.name !== 'anthropic') return;
    const effort = provider.thinkingEffort;
    if (effort === null || effort === 'on' || effort === 'off') return;

    let warning:
      | { readonly code: string; readonly message: string; readonly knownEfforts?: string }
      | undefined;
    try {
      const resolved =
        modelAlias === undefined
          ? undefined
          : this.modelProvider?.resolveProviderConfig(modelAlias);
      if (resolved === undefined) return;

      const supportEfforts = resolved.supportEfforts?.filter((value) => value.length > 0);
      if (supportEfforts === undefined || supportEfforts.length === 0) return;
      if (supportEfforts.includes(effort)) return;
      warning = {
        code: 'anthropic-thinking-effort-not-listed',
        message: `Thinking effort "${effort}" is not listed for model "${provider.modelName}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`,
        knownEfforts: supportEfforts.join(','),
      };
    } catch {
      // Capability diagnostics must never turn an otherwise sendable request
      // into a client-side failure.
      return;
    }

    if (warning === undefined) return;
    const key = [warning.code, modelAlias, provider.modelName, effort, warning.knownEfforts].join(
      '\u0000',
    );
    if (this.emittedThinkingEffortWarnings.has(key)) return;
    this.emittedThinkingEffortWarnings.add(key);
    const pending = {
      code: warning.code,
      message: warning.message,
      modelAlias,
      model: provider.modelName,
      effort,
      knownEfforts: warning.knownEfforts,
    };
    if (this.records.restoring) {
      this.pendingThinkingEffortWarnings.push(pending);
      return;
    }
    this.publishAnthropicThinkingEffortWarning(pending);
  }

  private publishAnthropicThinkingEffortWarning(
    warning: (typeof this.pendingThinkingEffortWarnings)[number],
  ): void {
    try {
      this.log.warn(warning.message, {
        modelAlias: warning.modelAlias,
        model: warning.model,
        effort: warning.effort,
        knownEfforts: warning.knownEfforts,
      });
    } catch {
      // Diagnostics must never block resume or request dispatch.
    }
    try {
      const delivery = this.rpc?.emitEvent?.({
        type: 'warning',
        code: warning.code,
        message: warning.message,
      });
      void delivery?.catch(() => {});
    } catch {
      // Diagnostics must never block resume or request dispatch.
    }
  }

  private flushPendingAnthropicThinkingEffortWarnings(): void {
    for (const warning of this.pendingThinkingEffortWarnings.splice(0)) {
      this.publishAnthropicThinkingEffortWarning(warning);
    }
  }

  warnAboutCurrentAnthropicThinkingEffort(): void {
    try {
      if (!this.config.hasProvider) return;
      this.warnAboutAnthropicThinkingEffort(this.config.provider, this.config.modelAlias);
    } catch {
      // A capability warning must never make config replay or session resume fail.
    }
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
    this.flushPendingAnthropicThinkingEffortWarnings();
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
          this.telemetry.track('cancel', {
            from: 'streaming',
            trace_id: this.turn.activeRequestTraceId(),
          });
        }
        this.turn.cancel(payload.turnId);
      },
      undoHistory: (payload) => {
        this.context.undo(payload.count);
        this.telemetry.track('conversation_undo', { count: payload.count });
      },
      setThinking: (payload) => {
        const previousEffort = this.config.thinkingEffort;
        this.config.setThinkingEffort(payload.effort);
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
          this.telemetry.track('cancel', {
            from: 'compacting',
            trace_id: this.fullCompaction.lastTraceId,
          });
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
      importContext: (payload) => {
        if (this.turn.hasActiveTurn || this.fullCompaction.isCompacting) {
          throw new KimiError(
            ErrorCodes.TURN_AGENT_BUSY,
            'Cannot import context while the agent is busy',
          );
        }
        this.context.importContext(payload.content, payload.source);
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
      // `cron` is null for subagents, which never schedule; report an empty
      // list rather than failing the RPC so callers can poll uniformly.
      getCronTasks: () => ({ tasks: this.cron?.listTaskSnapshots() ?? [] }),
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

  emitStatusUpdated(includeThinkingEffort = false): void {
    if (this.records.restoring) return;
    if (!this.config.hasModel) return;

    const contextTokens = this.context.tokenCount;
    const capability = this.config.modelCapabilities;
    const maxContextTokens = capability.max_input_tokens ?? capability.max_context_tokens;
    const contextUsage =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : undefined;
    const usage: UsageStatus | undefined = this.usage.status();
    const model = this.config.model;

    this.emitEvent({
      type: 'agent.status.updated',
      model,
      thinkingEffort: includeThinkingEffort ? this.config.thinkingEffort : undefined,
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
