import {
  createRPC,
  ErrorCodes,
  KimiCore,
  makeErrorPayload,
  resolveKimiHome,
  type ApprovalRequest,
  type ApprovalResponse,
  type CoreAPI,
  type Event,
  type OAuthTokenProviderResolver,
  type QuestionRequest,
  type QuestionResult,
  type SDKAPI,
  type SDKRPCClient,
  type TelemetryClient,
  type ToolCallRequest,
  type ToolCallResponse,
} from '@moonshot-ai/agent-core';
import { createKimiDefaultHeaders } from '@moonshot-ai/kimi-code-oauth';

import type { ApprovalHandler, QuestionHandler } from '#/events';
import type {
  BackgroundTaskInfo,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  ForkSessionInput,
  GetConfigOptions,
  KimiConfig,
  KimiConfigPatch,
  ListSessionsOptions,
  McpServerInfo,
  McpStartupMetrics,
  PermissionMode,
  CompactOptions,
  SessionPlan,
  SessionStatus,
  SessionUsage,
  PromptInput,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
  SkillSummary,
  Unsubscribe,
  KimiHostIdentity,
} from '#/types';

const MAIN_AGENT_ID = 'main';

export interface SDKRpcClientOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly identity?: KimiHostIdentity | undefined;
  readonly resolveOAuthTokenProvider?: OAuthTokenProviderResolver | undefined;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
}

export interface SessionPromptRpcInput {
  readonly sessionId: string;
  readonly input: PromptInput;
}

export interface SessionIdRpcInput {
  readonly sessionId: string;
}

export interface SetSessionModelRpcInput extends SessionIdRpcInput {
  readonly model: string;
}

export interface SetSessionModelRpcResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface SetSessionThinkingRpcInput extends SessionIdRpcInput {
  readonly level: string;
}

export interface SetSessionPermissionRpcInput extends SessionIdRpcInput {
  readonly mode: PermissionMode;
}

export interface SetSessionPlanModeRpcInput extends SessionIdRpcInput {
  readonly enabled: boolean;
}

export interface ActivateSkillRpcInput extends SessionIdRpcInput {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface ReconnectMcpServerRpcInput extends SessionIdRpcInput {
  readonly name: string;
}

type ResolvedCoreAPI = Awaited<ReturnType<SDKRPCClient>>;

export class SDKRpcClient {
  readonly core: KimiCore;
  interactiveAgentId = MAIN_AGENT_ID;
  private readonly ready: Promise<void>;
  private rpc: ResolvedCoreAPI | undefined;
  private readonly eventListeners = new Set<(event: Event) => void>();
  private readonly approvalHandlers = new Map<string, ApprovalHandler>();
  private readonly questionHandlers = new Map<string, QuestionHandler>();

  constructor(options: SDKRpcClientOptions = {}) {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const homeDir = resolveKimiHome(options.homeDir);
    const kimiRequestHeaders =
      options.identity === undefined
        ? undefined
        : createKimiDefaultHeaders({ homeDir, ...options.identity });
    this.core = new KimiCore(coreRpc, {
      homeDir: options.homeDir,
      configPath: options.configPath,
      kimiRequestHeaders,
      resolveOAuthTokenProvider: options.resolveOAuthTokenProvider,
      skillDirs: options.skillDirs,
      telemetry: options.telemetry,
    });
    this.ready = sdkRpc(new ClientAPI(this)).then((rpc) => {
      this.rpc = rpc;
    });
  }

  get homeDir(): string {
    return this.core.homeDir;
  }

  get configPath(): string {
    return this.core.configPath;
  }

  async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    const rpc = await this.getRpc();
    const { planMode, ...coreInput } = input;
    void planMode;
    return rpc.createSession(coreInput);
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const rpc = await this.getRpc();
    return rpc.resumeSession({ sessionId: input.id });
  }

  async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    const rpc = await this.getRpc();
    return rpc.forkSession({
      sessionId: input.id,
      id: input.forkId,
      title: input.title,
      metadata: input.metadata,
    });
  }

  async closeSession(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.closeSession({ sessionId: input.sessionId });
  }

  async listSessions(input: ListSessionsOptions): Promise<readonly SessionSummary[]> {
    const rpc = await this.getRpc();
    return rpc.listSessions(input);
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.renameSession({
      sessionId: input.id,
      title: input.title,
    });
  }

  async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const rpc = await this.getRpc();
    return rpc.exportSession({
      sessionId: input.id,
      outputPath: input.outputPath,
      includeGlobalLog: input.includeGlobalLog,
      version: input.version,
      installSource: input.installSource,
      shellEnv: input.shellEnv,
    });
  }

  async getConfig(input?: GetConfigOptions): Promise<KimiConfig> {
    const rpc = await this.getRpc();
    return rpc.getKimiConfig(input ?? {});
  }

  async setConfig(input: KimiConfigPatch): Promise<KimiConfig> {
    const rpc = await this.getRpc();
    return rpc.setKimiConfig(input);
  }

  async removeProvider(providerId: string): Promise<KimiConfig> {
    const rpc = await this.getRpc();
    return rpc.removeKimiProvider({ providerId });
  }

  async prompt(input: SessionPromptRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.prompt({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      input: input.input,
    });
  }

  async steer(input: SessionPromptRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.steer({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      input: input.input,
    });
  }

  async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.generateAgentsMd({ sessionId: input.sessionId });
  }

  async cancel(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.cancel({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult> {
    const rpc = await this.getRpc();
    return rpc.setModel({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      model: input.model,
    });
  }

  async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.setThinking({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      level: input.level,
    });
  }

  async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.setPermission({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      mode: input.mode,
    });
  }

  async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    if (!input.enabled) {
      return rpc.cancelPlan({
        sessionId: input.sessionId,
        agentId: this.interactiveAgentId,
      });
    }
    return rpc.enterPlan({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async getPlan(input: SessionIdRpcInput): Promise<SessionPlan> {
    const rpc = await this.getRpc();
    return rpc.getPlan({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async clearPlan(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    await rpc.clearPlan({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async compact(input: SessionIdRpcInput & CompactOptions): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.beginCompaction({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    });
  }

  async cancelCompaction(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.cancelCompaction({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    const rpc = await this.getRpc();
    return rpc.getUsage({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async getStatus(input: SessionIdRpcInput): Promise<SessionStatus> {
    const rpc = await this.getRpc();
    const agentId = this.interactiveAgentId;
    const config = await rpc.getConfig({
      sessionId: input.sessionId,
      agentId,
    });
    const context = await rpc.getContext({
      sessionId: input.sessionId,
      agentId,
    });
    const permission = await rpc.getPermission({
      sessionId: input.sessionId,
      agentId,
    });
    const plan = await rpc.getPlan({
      sessionId: input.sessionId,
      agentId,
    });
    const usage = await rpc.getUsage({
      sessionId: input.sessionId,
      agentId,
    });
    const maxContextTokens = config.modelCapabilities?.max_context_tokens ?? 0;
    const contextTokens = context.tokenCount;
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
    const hasUsage =
      usage.byModel !== undefined || usage.total !== undefined || usage.currentTurn !== undefined;
    return {
      model: config.modelAlias ?? config.provider?.model,
      thinkingLevel: config.thinkingLevel,
      permission: permission.mode,
      planMode: plan !== null,
      contextTokens,
      maxContextTokens,
      contextUsage,
      usage: hasUsage ? usage : undefined,
    };
  }

  async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    const rpc = await this.getRpc();
    return rpc.listSkills({ sessionId: input.sessionId });
  }

  async listBackgroundTasks(
    input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    const rpc = await this.getRpc();
    return rpc.getBackground({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      activeOnly: input.activeOnly,
      limit: input.limit,
    });
  }

  async getBackgroundTaskOutput(
    input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string> {
    const rpc = await this.getRpc();
    return rpc.getBackgroundOutput({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      taskId: input.taskId,
      tail: input.tail,
    });
  }

  async getBackgroundTaskOutputPath(
    input: SessionIdRpcInput & { taskId: string },
  ): Promise<string | undefined> {
    const rpc = await this.getRpc();
    return rpc.getBackgroundOutputPath({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      taskId: input.taskId,
    });
  }

  async stopBackgroundTask(
    input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.stopBackground({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      taskId: input.taskId,
      reason: input.reason,
    });
  }

  async listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]> {
    const rpc = await this.getRpc();
    return rpc.listMcpServers({ sessionId: input.sessionId });
  }

  async getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics> {
    const rpc = await this.getRpc();
    return rpc.getMcpStartupMetrics({ sessionId: input.sessionId });
  }

  async reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.reconnectMcpServer({ sessionId: input.sessionId, name: input.name });
  }

  async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.activateSkill({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      name: input.name,
      args: input.args,
    });
  }

  onEvent(listener: (event: Event) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  receiveEvent(event: Event): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  setApprovalHandler(sessionId: string, handler: ApprovalHandler | undefined): void {
    if (handler === undefined) {
      this.approvalHandlers.delete(sessionId);
      return;
    }
    this.approvalHandlers.set(sessionId, handler);
  }

  setQuestionHandler(sessionId: string, handler: QuestionHandler | undefined): void {
    if (handler === undefined) {
      this.questionHandlers.delete(sessionId);
      return;
    }
    this.questionHandlers.set(sessionId, handler);
  }

  clearSessionHandlers(sessionId: string): void {
    this.approvalHandlers.delete(sessionId);
    this.questionHandlers.delete(sessionId);
  }

  async requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    const handler = this.approvalHandlers.get(request.sessionId);
    if (handler === undefined) {
      return {
        decision: 'cancelled',
        feedback: 'No approval handler registered.',
      };
    }

    try {
      return await handler(request);
    } catch (error) {
      this.receiveEvent({
        type: 'error',
        sessionId: request.sessionId,
        agentId: request.agentId,
        ...makeErrorPayload(ErrorCodes.SESSION_APPROVAL_HANDLER_ERROR, errorMessage(error)),
      });
      return {
        decision: 'cancelled',
        feedback: 'Approval handler failed.',
      };
    }
  }

  async requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    const handler = this.questionHandlers.get(request.sessionId);
    if (handler === undefined) return null;

    try {
      return await handler(request);
    } catch (error) {
      this.receiveEvent({
        type: 'error',
        sessionId: request.sessionId,
        agentId: request.agentId,
        ...makeErrorPayload(ErrorCodes.SESSION_QUESTION_HANDLER_ERROR, errorMessage(error)),
      });
      return null;
    }
  }

  async toolCall(request: ToolCallRequest): Promise<ToolCallResponse> {
    return {
      output: `SDK custom tool calls are not supported: ${request.toolCallId}`,
      isError: true,
    };
  }

  private async getRpc(): Promise<ResolvedCoreAPI> {
    await this.ready;
    if (this.rpc === undefined) {
      throw new Error('SDK RPC client was not initialized.');
    }
    return this.rpc;
  }
}

export class ClientAPI implements SDKAPI {
  constructor(readonly client: SDKRpcClient) {}

  emitEvent(event: Event): void {
    this.client.receiveEvent(event);
  }

  requestApproval(
    request: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    return this.client.requestApproval(request);
  }

  requestQuestion(
    request: QuestionRequest & { sessionId: string; agentId: string },
  ): Promise<QuestionResult> {
    return this.client.requestQuestion(request);
  }

  toolCall(request: ToolCallRequest): Promise<ToolCallResponse> {
    return this.client.toolCall(request);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
