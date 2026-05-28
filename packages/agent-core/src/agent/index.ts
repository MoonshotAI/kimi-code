import { createHash } from 'node:crypto';
import { join } from 'pathe';

import { ErrorCodes, KimiError, makeErrorPayload } from '#/errors';
import { log } from '#/logging/logger';
import type { Logger } from '#/logging/types';
import type { AgentAPI, AgentEvent, SDKAgentRPC, UsageStatus } from '#/rpc';
import {
  generate,
  type ChatProvider,
  type Message,
  type Tool,
} from '@moonshot-ai/kosong';

import type { EnabledPluginSessionStart } from '#/plugin';

import type { McpConnectionManager } from '../mcp';
import type { PreparedSystemPromptContext, ResolvedAgentProfile } from '../profile';
import type { ProviderManager } from '../providers/provider-manager';
import { withProviderRequestAuth } from '../providers/request-auth';
import type { RuntimeConfig } from '../runtime-types';
import type { SessionSubagentHost } from '../session/subagent-host';
import type { SkillRegistry } from '../skill';
import { noopTelemetryClient, type TelemetryClient } from '../telemetry';
import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../utils/tokens';
import type { PromisableMethods } from '../utils/types';
import { BackgroundManager } from './background';
import { FullCompaction, type CompactionStrategy } from './compaction';
import { ConfigState } from './config';
import { ContextMemory } from './context';
import { HookEngine } from './hooks';
import { InjectionManager } from './injection/manager';
import { PermissionManager, type PermissionManagerOptions } from './permission';
import { PlanMode } from './plan';
import {
  AgentRecords,
  BlobStore,
  FileSystemAgentRecordPersistence,
  type AgentRecord,
  type AgentRecordPersistence,
} from './records';
import { ReplayBuilder } from './replay';
import { SkillManager } from './skill';
import { ToolManager } from './tool/index';
import { TurnFlow } from './turn';
import {
  GENERATE_REQUEST_LOG_CONTEXT,
  KosongLLM,
  type GenerateOptionsWithRequestLog,
} from './turn/kosong-llm';
import { UsageRecorder } from './usage';
import { resolveCompletionBudget } from '../utils/completion-budget';

export type { AgentRecord, AgentRecordPersistence } from './records';
export type { BuiltinTool, ToolInfo, ToolSource, UserToolRegistration } from './tool';

export type AgentType = 'main' | 'sub' | 'independent';

export interface AgentConfig {
  readonly runtime: RuntimeConfig;
  readonly homedir?: string;
  readonly skills?: SkillRegistry;
  readonly rpc: SDKAgentRPC;
  readonly persistence?: AgentRecordPersistence;
  readonly type?: AgentType;
  readonly generate?: typeof generate;
  readonly compactionStrategy?: CompactionStrategy;
  readonly providerManager?: ProviderManager | undefined;
  readonly sessionId?: string;
  readonly subagentHost?: SessionSubagentHost | undefined;
  readonly mcp?: McpConnectionManager;
  readonly hookEngine?: HookEngine;
  readonly backgroundMaxRunningTasks?: number;
  readonly backgroundSessionDir?: string;
  readonly permission?: PermissionManagerOptions | undefined;
  /** Parent logger; the agent appends its own ctx (agentId already bound by session). */
  readonly log?: Logger;
  readonly telemetry?: TelemetryClient | undefined;
  readonly pluginSessionStarts?: readonly EnabledPluginSessionStart[];
}

export class Agent {
  readonly runtime: RuntimeConfig;
  readonly homedir?: string;
  readonly skills?: SkillManager;
  readonly pluginSessionStarts: readonly EnabledPluginSessionStart[];
  readonly rawGenerate: typeof generate;
  readonly rpc: SDKAgentRPC;
  readonly telemetry: TelemetryClient;
  readonly providerManager: ProviderManager | undefined;
  readonly subagentHost: SessionSubagentHost | undefined;
  readonly mcp: McpConnectionManager | undefined;
  readonly hooks: HookEngine | undefined;

  readonly type: AgentType;
  readonly blobStore: BlobStore | undefined;
  readonly records: AgentRecords;
  readonly fullCompaction: FullCompaction;
  readonly context: ContextMemory;
  readonly config: ConfigState;
  readonly turn: TurnFlow;
  readonly injection: InjectionManager;
  readonly permission: PermissionManager;
  readonly planMode: PlanMode;
  readonly usage: UsageRecorder;
  readonly tools: ToolManager;
  readonly background: BackgroundManager;
  readonly replayBuilder: ReplayBuilder;
  readonly log: Logger;

  private lastLlmConfigLogSignature?: string;

  constructor(config: AgentConfig) {
    this.log = config.log ?? log;
    this.runtime = config.runtime;
    this.homedir = config.homedir;
    if (config.skills !== undefined) {
      this.skills = new SkillManager(this, config.skills);
    }
    this.pluginSessionStarts = config.pluginSessionStarts ?? [];
    this.rawGenerate = config.generate ?? generate;
    this.providerManager =
      config.sessionId === undefined
        ? config.providerManager
        : config.providerManager?.withPromptCacheKey(config.sessionId);
    this.subagentHost = config.subagentHost;
    this.mcp = config.mcp;
    this.hooks = config.hookEngine;

    this.type = config.type ?? 'main';

    this.rpc = config.rpc;
    this.telemetry = config.telemetry ?? noopTelemetryClient;
    this.blobStore = config.homedir
      ? new BlobStore({ blobsDir: join(config.homedir, 'blobs') })
      : undefined;
    this.records = new AgentRecords(
      this,
      config.persistence ??
        (config.homedir
          ? new FileSystemAgentRecordPersistence(join(config.homedir, 'wire.jsonl'), {
              onError: (error) => {
                this.emitRecordsWriteError(error);
              },
              blobStore: this.blobStore,
            })
          : undefined),
    );
    this.fullCompaction = new FullCompaction(this, config.compactionStrategy);
    this.context = new ContextMemory(this);
    this.config = new ConfigState(this);
    this.turn = new TurnFlow(this);
    this.injection = new InjectionManager(this);
    this.permission = new PermissionManager(this, config.permission);
    this.planMode = new PlanMode(this);
    this.usage = new UsageRecorder(this);
    this.tools = new ToolManager(this);
    this.background = new BackgroundManager(this, {
      maxRunningTasks: config.backgroundMaxRunningTasks,
      sessionDir: config.backgroundSessionDir,
    });
    this.replayBuilder = new ReplayBuilder(this);
  }

  get generate(): typeof generate {
    return async (provider, systemPrompt, tools, history, callbacks, options) => {
      if (options?.auth !== undefined) {
        this.logLlmRequest(provider, systemPrompt, tools, history, options);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, options);
      }
      const modelAlias = this.config.modelAlias;
      const resolveAuth =
        modelAlias === undefined
          ? undefined
          : this.providerManager?.createAuthResolverForModel(modelAlias, {
              log: this.log,
            });
      return withProviderRequestAuth(resolveAuth, (auth) => {
        const requestOptions = auth === undefined ? options : { ...options, auth };
        this.logLlmRequest(provider, systemPrompt, tools, history, requestOptions);
        return this.rawGenerate(provider, systemPrompt, tools, history, callbacks, requestOptions);
      });
    };
  }

  get llm(): KosongLLM {
    const model = this.config.model;
    const provider = this.config.provider.withThinking(this.config.thinkingLevel);
    const loopControl = this.providerManager?.config.loopControl;
    const completionBudgetConfig = resolveCompletionBudget({
      reservedContextSize: loopControl?.reservedContextSize,
    });
    return new KosongLLM({
      provider,
      modelName: model,
      systemPrompt: this.config.systemPrompt,
      capability: this.config.modelCapabilities,
      generate: this.generate,
      completionBudgetConfig,
    });
  }

  private logLlmRequest(
    provider: ChatProvider,
    systemPrompt: string,
    tools: readonly Tool[],
    history: readonly Message[],
    options: Parameters<typeof generate>[5],
  ): void {
    const context = buildLlmRequestContext(options);
    const configMetadata = buildLlmConfigMetadata(
      provider,
      this.config.modelAlias,
      systemPrompt,
      tools,
    );
    this.logLlmConfigIfChanged(
      context,
      configMetadata,
      buildLlmConfigSignature(configMetadata, systemPrompt, tools),
    );
    this.log.info('llm request', {
      ...context,
      ...buildLlmRequestMetadata(systemPrompt, tools, history),
    });
  }

  private logLlmConfigIfChanged(
    context: LlmRequestContextFields,
    metadata: LlmConfigMetadata,
    signature: string,
  ): void {
    if (signature === this.lastLlmConfigLogSignature) return;
    this.lastLlmConfigLogSignature = signature;
    this.log.info('llm config', {
      ...context,
      ...metadata,
    });
  }

  useProfile(profile: ResolvedAgentProfile, context?: PreparedSystemPromptContext): void {
    const systemPrompt = profile.systemPrompt({
      osEnv: this.runtime.kaos.osEnv,
      cwd: this.config.cwd,
      skills: this.skills?.registry,
      cwdListing: context?.cwdListing,
      agentsMd: context?.agentsMd,
    });
    this.config.update({ profileName: profile.name, systemPrompt });
    this.tools.setActiveTools(profile.tools);
  }

  async resume(): Promise<{ warning?: string }> {
    const result = await this.records.replay();
    await this.background.loadFromDisk();
    await this.background.reconcile();
    this.turn.finishResume();
    return result;
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
      setModel: async (payload) => {
        const previous = this.config.modelAlias;
        const resolved = await this.providerManager?.resolveProviderForModel(payload.model);
        if (resolved === undefined) {
          throw new Error('Runtime provider model cannot be empty');
        }
        this.config.update({
          modelAlias: resolved.modelName,
        });
        if (previous !== resolved.modelName) {
          this.telemetry.track('model_switch', { model: resolved.modelName });
        }
        return {
          model: resolved.modelName,
          providerName: resolved.providerName,
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
        if (this.skills === undefined) {
          throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${payload.name}" was not found`);
        }
        this.skills.activate(payload);
      },
      getBackgroundOutput: (payload) => this.background.readOutput(payload.taskId, payload.tail),
      getBackgroundOutputPath: (payload) => this.background.getOutputPath(payload.taskId),
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
    void this.rpc.emitEvent(event);
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

interface LlmRequestContextFields {
  turnId?: string;
  step?: number;
  attempt?: number;
  maxAttempts?: number;
}

interface LlmRequestMetadata {
  estimatedInputTokens: number;
  messageCount: number;
  toolCallCount: number;
  partialMessageCount?: number;
}

/**
 * Fields that identify an LLM configuration for deduplication.
 * Keep this interface simple and avoid dynamic keys — the shape is
 * serialized with `JSON.stringify` to produce a stable signature in
 * `logLlmConfigIfChanged`.
 */
interface LlmConfigMetadata {
  provider: string;
  model: string;
  modelAlias?: string;
  thinkingEffort?: string;
  systemPromptChars: number;
  toolCount: number;
}

function buildLlmRequestContext(options: Parameters<typeof generate>[5]): LlmRequestContextFields {
  const context = requestLogContext(options);
  if (context === undefined) return {};

  const fields: LlmRequestContextFields = {
    turnId: context.turnId,
    step: context.step,
  };
  if (
    context.attempt !== undefined &&
    context.maxAttempts !== undefined &&
    context.attempt > 1
  ) {
    fields.attempt = context.attempt;
    fields.maxAttempts = context.maxAttempts;
  }
  return fields;
}

function buildLlmRequestMetadata(
  systemPrompt: string,
  tools: readonly Tool[],
  history: readonly Message[],
): LlmRequestMetadata {
  let toolCallCount = 0;
  let partialMessageCount = 0;

  for (const message of history) {
    if (message.partial === true) partialMessageCount += 1;
    toolCallCount += message.toolCalls.length;
  }

  const estimatedInputTokens =
    estimateTokens(systemPrompt) +
    estimateTokensForMessages(history) +
    estimateTokensForTools(tools);

  const metadata: LlmRequestMetadata = {
    estimatedInputTokens,
    messageCount: history.length,
    toolCallCount,
  };
  if (partialMessageCount > 0) {
    metadata.partialMessageCount = partialMessageCount;
  }
  return metadata;
}

function buildLlmConfigMetadata(
  provider: ChatProvider,
  modelAlias: string | undefined,
  systemPrompt: string,
  tools: readonly Tool[],
): LlmConfigMetadata {
  return {
    provider: provider.name,
    model: provider.modelName,
    modelAlias,
    thinkingEffort: provider.thinkingEffort ?? undefined,
    systemPromptChars: systemPrompt.length,
    toolCount: tools.length,
  };
}

function buildLlmConfigSignature(
  metadata: LlmConfigMetadata,
  systemPrompt: string,
  tools: readonly Tool[],
): string {
  const toolsForSignature = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return JSON.stringify({
    ...metadata,
    systemPromptHash: fingerprint(systemPrompt),
    toolsHash: fingerprint(JSON.stringify(toolsForSignature)),
  });
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function requestLogContext(options: Parameters<typeof generate>[5]) {
  return (options as GenerateOptionsWithRequestLog | undefined)?.[GENERATE_REQUEST_LOG_CONTEXT];
}
