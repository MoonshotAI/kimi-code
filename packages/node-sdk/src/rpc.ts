import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ErrorCodes,
  KimiError,
  makeErrorPayload,
  type AgentContextData,
  type ApprovalRequest,
  type ApprovalResponse,
  type BeginGlobalMcpServerAuthResult,
  type CoreAPI,
  type Event,
  type ExperimentalFeatureState,
  type GetCronTasksResult,
  type QuestionRequest,
  type QuestionResult,
  type RPCMethods,
  type SDKAPI,
  type ToolCallRequest,
  type ToolCallResponse,
  type SwarmModeTrigger,
} from '@moonshot-ai/agent-core';
import type { Kaos } from '@moonshot-ai/kaos';

import type { ApprovalHandler, QuestionHandler } from '#/events';
import type {
  AddAdditionalDirInput,
  AddAdditionalDirResult,
  AgentCommandInfo,
  BackgroundTaskInfo,
  ConfigDiagnostics,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  CreateGoalInput,
  ForkSessionInput,
  GenerateSessionTitleInput,
  GetConfigOptions,
  GlobalMcpServerAuthStatus,
  McpServerConfig,
  GoalSnapshot,
  GoalToolResult,
  JsonObject,
  KimiConfig,
  KimiConfigPatch,
  ListSessionsOptions,
  McpServerInfo,
  McpStartupMetrics,
  McpTestResult,
  PermissionMode,
  PluginInfo,
  PluginSummary,
  ReloadSummary,
  CompactOptions,
  SessionPlan,
  SessionStatus,
  SessionUsage,
  PromptInput,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
  SessionSummaryPage,
  SkillSummary,
  PluginCommandDef,
  Unsubscribe,
  WorkspaceTrustInfo,
} from '#/types';

const MAIN_AGENT_ID = 'main';

export interface SessionPromptRpcInput {
  readonly sessionId: string;
  readonly input: PromptInput;
}

export interface SessionIdRpcInput {
  readonly sessionId: string;
}

export interface ImportContextRpcInput extends SessionIdRpcInput {
  readonly content: string;
  readonly source: string;
}

export interface ReloadSessionRpcInput extends SessionIdRpcInput {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface SetSessionModelRpcInput extends SessionIdRpcInput {
  readonly model: string;
}

export interface SetSessionModelRpcResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface SetSessionThinkingRpcInput extends SessionIdRpcInput {
  readonly effort: string;
}

export interface SetSessionPermissionRpcInput extends SessionIdRpcInput {
  readonly mode: PermissionMode;
}

export interface UpdateSessionMetadataRpcInput extends SessionIdRpcInput {
  readonly metadata: JsonObject;
}

export interface SetSessionPlanModeRpcInput extends SessionIdRpcInput {
  readonly enabled: boolean;
}

export type SetSessionSwarmModeRpcInput =
  | (SessionIdRpcInput & { readonly enabled: true; readonly trigger: SwarmModeTrigger })
  | (SessionIdRpcInput & { readonly enabled: false });

export interface ActivateSkillRpcInput extends SessionIdRpcInput {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface ActivatePluginCommandRpcInput extends SessionIdRpcInput {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}

export interface RunCommandRpcInput extends SessionIdRpcInput {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface ReconnectMcpServerRpcInput extends SessionIdRpcInput {
  readonly name: string;
}

type ResolvedCoreAPI = RPCMethods<CoreAPI>;

export abstract class SDKRpcClientBase {
  private readonly interactiveAgentScope = new AsyncLocalStorage<string>();
  private readonly eventListeners = new Set<(event: Event) => void>();
  private readonly approvalHandlers = new Map<string, ApprovalHandler>();
  private readonly questionHandlers = new Map<string, QuestionHandler>();

  get interactiveAgentId(): string {
    return this.interactiveAgentScope.getStore() ?? MAIN_AGENT_ID;
  }

  withInteractiveAgent<T>(agentId: string, fn: () => T): T {
    return this.interactiveAgentScope.run(agentId, fn);
  }

  protected abstract getRpc(): Promise<ResolvedCoreAPI>;

  async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    const rpc = await this.getRpc();
    const { planMode, ...coreInput } = input;
    void planMode;
    return rpc.createSession(coreInput);
  }

  async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    void kaos;
    void persistenceKaos;
    return this.createSession(input);
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const rpc = await this.getRpc();
    return rpc.resumeSession({ ...input, sessionId: input.id });
  }

  async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    void kaos;
    void persistenceKaos;
    return this.resumeSession(input);
  }

  async reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary> {
    const rpc = await this.getRpc();
    return rpc.reloadSession({
      sessionId: input.sessionId,
      forcePluginSessionStartReminder: input.forcePluginSessionStartReminder,
    });
  }

  async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    const rpc = await this.getRpc();
    return rpc.forkSession({
      sessionId: input.id,
      id: input.forkId,
      title: input.title,
      metadata: input.metadata,
      turnIndex: input.turnIndex,
    });
  }

  async closeSession(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.closeSession({ sessionId: input.sessionId });
  }

  async deleteSession(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.deleteSession({ sessionId: input.sessionId });
  }

  async listSessions(input: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    const rpc = await this.getRpc();
    return rpc.listSessions(input);
  }

  /**
   * One keyset page of the session listing (`limit` / `before` in
   * `ListSessionsOptions`). The base implementation serves the whole filtered
   * set as a single terminal page — the v1 engine has no paged listing;
   * `SDKRpcClientV2` overrides this with real index paging.
   */
  async listSessionsPage(input: ListSessionsOptions = {}): Promise<SessionSummaryPage> {
    const items = await this.listSessions(input);
    return { items, nextCursor: undefined };
  }

  async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const rpc = await this.getRpc();
    return rpc.listWorkspaceSkills({ workDir });
  }

  /**
   * Workspace-trust state for `workDir`. The v1 engine has no trust concept,
   * so the base implementation reports an always-trusted workspace and the
   * trust write is a no-op; only the v2 client overrides these.
   */
  async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    void workDir;
    return { trusted: true, gatedMcpServers: [] };
  }

  async trustWorkspace(workDir: string): Promise<void> {
    void workDir;
  }

  async renameSession(input: RenameSessionInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.renameSession({
      sessionId: input.id,
      title: input.title,
    });
  }

  /**
   * v2-only capability (`ISessionTitleService`); the v1 engine has no title
   * generation, so the base fails loudly and `SDKRpcClientV2` overrides it.
   */
  async generateSessionTitle(input: GenerateSessionTitleInput): Promise<string | undefined> {
    void input;
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'generateSessionTitle is only available on the agent-core-v2 engine.',
    );
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

  async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    const rpc = await this.getRpc();
    return rpc.getConfigDiagnostics({});
  }

  async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    const rpc = await this.getRpc();
    return rpc.getExperimentalFeatures({});
  }

  async setConfig(input: KimiConfigPatch): Promise<KimiConfig> {
    const rpc = await this.getRpc();
    return rpc.setKimiConfig(input);
  }

  async removeProvider(providerId: string): Promise<KimiConfig> {
    const rpc = await this.getRpc();
    return rpc.removeKimiProvider({ providerId });
  }

  /**
   * Whether this client can persist several config sections as ONE atomic
   * write (see {@link replaceConfigSections}). v1 cannot — its config writes
   * are whole-document merges — so the default is false.
   */
  supportsAtomicSectionReplace(): boolean {
    return false;
  }

  /**
   * Replace several top-level config sections in ONE atomic write: a section
   * mapped to `undefined` is cleared, sections absent from the record are
   * left untouched. Unlike {@link setConfig} (a deep-merge that cannot
   * delete keys), this has replace semantics, so a staged removal can be
   * expressed by the written record itself.
   */
  replaceConfigSections(_sections: Record<string, unknown>): Promise<void> {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'This SDK client does not support atomic config section replacement.',
    );
  }

  async listGlobalMcpServers(): Promise<readonly McpServerConfig[]> {
    const rpc = await this.getRpc();
    return rpc.listGlobalMcpServers({});
  }

  async listGlobalMcpServerAuthStatuses(): Promise<readonly GlobalMcpServerAuthStatus[]> {
    const rpc = await this.getRpc();
    return rpc.listGlobalMcpServerAuthStatuses({});
  }

  async addGlobalMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    const rpc = await this.getRpc();
    return rpc.addGlobalMcpServer({ server });
  }

  async updateGlobalMcpServer(server: McpServerConfig): Promise<readonly McpServerConfig[]> {
    const rpc = await this.getRpc();
    return rpc.updateGlobalMcpServer({ server });
  }

  async removeGlobalMcpServer(name: string): Promise<readonly McpServerConfig[]> {
    const rpc = await this.getRpc();
    return rpc.removeGlobalMcpServer({ name });
  }

  async beginGlobalMcpServerAuth(name: string): Promise<BeginGlobalMcpServerAuthResult> {
    const rpc = await this.getRpc();
    return rpc.beginGlobalMcpServerAuth({ name });
  }

  async completeGlobalMcpServerAuth(
    input: { readonly flowId: string; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.completeGlobalMcpServerAuth(input, { signal });
  }

  async cancelGlobalMcpServerAuth(flowId: string): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.cancelGlobalMcpServerAuth({ flowId });
  }

  async resetGlobalMcpServerAuth(name: string): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.resetGlobalMcpServerAuth({ name });
  }

  async testGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    const rpc = await this.getRpc();
    return rpc.testGlobalMcpServer({ name, cwd: options.cwd });
  }

  async prompt(input: SessionPromptRpcInput): Promise<void> {
    const agentId = this.interactiveAgentId;
    const rpc = await this.getRpc();
    return rpc.prompt({
      sessionId: input.sessionId,
      agentId,
      input: input.input,
    });
  }

  async runShellCommand(input: {
    sessionId: string;
    command: string;
    commandId?: string;
  }): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }> {
    const agentId = this.interactiveAgentId;
    const rpc = await this.getRpc();
    return rpc.runShellCommand({
      sessionId: input.sessionId,
      agentId,
      command: input.command,
      commandId: input.commandId,
    });
  }

  async cancelShellCommand(input: { sessionId: string; commandId: string }): Promise<void> {
    const agentId = this.interactiveAgentId;
    const rpc = await this.getRpc();
    return rpc.cancelShellCommand({
      sessionId: input.sessionId,
      agentId,
      commandId: input.commandId,
    });
  }

  async steer(input: SessionPromptRpcInput): Promise<void> {
    const agentId = this.interactiveAgentId;
    const rpc = await this.getRpc();
    return rpc.steer({
      sessionId: input.sessionId,
      agentId,
      input: input.input,
    });
  }

  async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.generateAgentsMd({ sessionId: input.sessionId });
  }

  async getSessionWarnings(input: SessionIdRpcInput) {
    const rpc = await this.getRpc();
    return rpc.getSessionWarnings({ sessionId: input.sessionId });
  }

  async addAdditionalDir(input: AddAdditionalDirInput): Promise<AddAdditionalDirResult> {
    const rpc = await this.getRpc();
    return rpc.addAdditionalDir({ sessionId: input.id, path: input.path, persist: input.persist });
  }

  async startBtw(input: SessionIdRpcInput): Promise<string> {
    const agentId = this.interactiveAgentId;
    const rpc = await this.getRpc();
    return rpc.startBtw({
      sessionId: input.sessionId,
      agentId,
    });
  }

  async cancel(input: SessionIdRpcInput): Promise<void> {
    const agentId = this.interactiveAgentId;
    const rpc = await this.getRpc();
    return rpc.cancel({
      sessionId: input.sessionId,
      agentId,
    });
  }

  async clearContext(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.clearContext({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async importContext(input: ImportContextRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.importContext({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      content: input.content,
      source: input.source,
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
      effort: input.effort,
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

  async updateSessionMetadata(input: UpdateSessionMetadataRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    const current = await rpc.getSessionMetadata({ sessionId: input.sessionId });
    const metadata = { ...current.custom, ...input.metadata } as JsonObject;
    await rpc.updateSessionMetadata({
      sessionId: input.sessionId,
      metadata: { custom: metadata },
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

  async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    if (input.enabled) return this.enterSwarmMode(input);
    return this.exitSwarmMode(input);
  }

  async swarm(input: SessionPromptRpcInput): Promise<void> {
    await this.enterSwarmMode({ sessionId: input.sessionId, trigger: 'task' });
    return this.prompt(input);
  }

  private async enterSwarmMode(
    input: SessionIdRpcInput & { readonly trigger: SwarmModeTrigger },
  ): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.enterSwarm({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      trigger: input.trigger,
    });
  }

  private async exitSwarmMode(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.exitSwarm({
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

  async undoHistory(input: SessionIdRpcInput & { count: number }): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.undoHistory({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      count: input.count,
    });
  }

  async getContext(input: SessionIdRpcInput): Promise<AgentContextData> {
    const rpc = await this.getRpc();
    return rpc.getContext({
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
    const swarmMode = await rpc.getSwarmMode({
      sessionId: input.sessionId,
      agentId,
    });
    const usage = await rpc.getUsage({
      sessionId: input.sessionId,
      agentId,
    });
    const capability = config.modelCapabilities;
    const maxContextTokens = capability?.max_input_tokens ?? capability?.max_context_tokens ?? 0;
    const contextTokens = context.tokenCount;
    // Deliberately unclamped: >100% is the documented overflow signal on this
    // path (see acp-adapter's formatContextUsage), unlike the schema-bounded
    // REST status surfaces which clamp to 1.
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
    const hasUsage =
      usage.byModel !== undefined || usage.total !== undefined || usage.currentTurn !== undefined;
    return {
      model: config.modelAlias ?? config.provider?.model,
      thinkingEffort: config.thinkingEffort,
      permission: permission.mode,
      planMode: plan !== null,
      swarmMode,
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

  async listPluginCommands(input: SessionIdRpcInput): Promise<readonly PluginCommandDef[]> {
    const rpc = await this.getRpc();
    return rpc.listPluginCommands({ sessionId: input.sessionId });
  }

  /**
   * App-global plugin command list, no session required. The v1 engine only
   * exposes plugin commands through a live session, so the base returns an
   * empty list; the v2 client overrides with the app-global live view.
   */
  async listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]> {
    return [];
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

  async detachBackgroundTask(
    input: SessionIdRpcInput & { taskId: string },
  ): Promise<BackgroundTaskInfo | undefined> {
    const rpc = await this.getRpc();
    return rpc.detachBackground({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      taskId: input.taskId,
    });
  }

  async waitForBackgroundTasksOnPrint(input: SessionIdRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.waitForBackgroundTasksOnPrint({ sessionId: input.sessionId });
  }

  async handlePrintMainTurnCompleted(input: SessionIdRpcInput): Promise<'finish' | 'continue'> {
    const rpc = await this.getRpc();
    return rpc.handlePrintMainTurnCompleted({ sessionId: input.sessionId });
  }

  async createGoal(input: SessionIdRpcInput & CreateGoalInput): Promise<GoalSnapshot> {
    const rpc = await this.getRpc();
    return rpc.createGoal({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      objective: input.objective,
      replace: input.replace,
    });
  }

  async getGoal(input: SessionIdRpcInput): Promise<GoalToolResult> {
    const rpc = await this.getRpc();
    return rpc.getGoal({ sessionId: input.sessionId, agentId: this.interactiveAgentId });
  }

  async pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const rpc = await this.getRpc();
    return rpc.pauseGoal({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const rpc = await this.getRpc();
    return rpc.resumeGoal({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    const rpc = await this.getRpc();
    return rpc.cancelGoal({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
    });
  }

  async getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult> {
    const rpc = await this.getRpc();
    return rpc.getCronTasks({ sessionId: input.sessionId, agentId: this.interactiveAgentId });
  }

  async listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]> {
    const rpc = await this.getRpc();
    return rpc.listMcpServers({ sessionId: input.sessionId });
  }

  /**
   * Workspace-level MCP server list, no session required. The v2 engine owns
   * one shared connection set per workspace handler, so `/mcp` is inspectable
   * before the first session exists; the v1 engine only exposes MCP through
   * a live session and the base returns an empty list.
   */
  async listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerInfo[]> {
    void workDir;
    return [];
  }

  async getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics> {
    const rpc = await this.getRpc();
    return rpc.getMcpStartupMetrics({ sessionId: input.sessionId });
  }

  async reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.reconnectMcpServer({ sessionId: input.sessionId, name: input.name });
  }

  async listPlugins(): Promise<readonly PluginSummary[]> {
    const rpc = await this.getRpc();
    return rpc.listPlugins({});
  }

  async installPlugin(source: string): Promise<PluginSummary> {
    const rpc = await this.getRpc();
    return rpc.installPlugin({ source });
  }

  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.setPluginEnabled({ id, enabled });
  }

  async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.setPluginMcpServerEnabled({ id, server, enabled });
  }

  async removePlugin(id: string): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.removePlugin({ id });
  }

  async reloadPlugins(): Promise<ReloadSummary> {
    const rpc = await this.getRpc();
    return rpc.reloadPlugins({});
  }

  async getPluginInfo(id: string): Promise<PluginInfo> {
    const rpc = await this.getRpc();
    return rpc.getPluginInfo({ id });
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

  async activatePluginCommand(input: ActivatePluginCommandRpcInput): Promise<void> {
    const rpc = await this.getRpc();
    return rpc.activatePluginCommand({
      sessionId: input.sessionId,
      agentId: this.interactiveAgentId,
      pluginId: input.pluginId,
      commandName: input.commandName,
      args: input.args,
    });
  }

  /**
   * Contributed commands of the session's interactive agent. The
   * contributed-command seam exists only in the agent-core-v2 engine, so the
   * base implementation reports the empty set and rejects runs with a coded
   * error (same shape as `replaceConfigSections`); only the v2 client
   * overrides these.
   */
  async listCommands(input: SessionIdRpcInput): Promise<readonly AgentCommandInfo[]> {
    void input;
    return [];
  }

  async runCommand(input: RunCommandRpcInput): Promise<void> {
    void input;
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'This SDK client does not support contributed commands.',
    );
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

}

export class ClientAPI implements SDKAPI {
  constructor(readonly client: SDKRpcClientBase) {}

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
