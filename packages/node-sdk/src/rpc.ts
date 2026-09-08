import { AsyncLocalStorage } from 'node:async_hooks';

import type { SwarmModeTrigger } from '@moonshot-ai/agent-core-v2/features/swarm/agent/swarm';
import type { Kaos } from '@moonshot-ai/kaos';

import type { AgentContextData } from '#/context';
import { ErrorCodes, makeErrorPayload } from '#/errors';
import type {
  ApprovalHandler,
  Event,
  QuestionHandler,
} from '#/events';
import type { ExperimentalFeatureState } from '#/flag';
import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
  ToolCallRequest,
  ToolCallResponse,
} from '#/interaction';
import type { BeginGlobalMcpServerAuthResult } from '#/mcp';
import type {
  AddAdditionalDirInput,
  AddAdditionalDirResult,
  AgentCommandInfo,
  AgentRuntimeBinding,
  AppMcpServerInspection,
  BackgroundTaskInfo,
  ConfigDiagnostics,
  CreateSessionOptions,
  ExportSessionInput,
  ExportSessionResult,
  CreateGoalInput,
  FileMeta,
  ForkSessionInput,
  GenerateSessionTitleInput,
  GetConfigOptions,
  GetCronTasksResult,
  GlobalMcpServerAuthStatus,
  McpManagedServerInfo,
  McpServerConfig,
  McpServerLocator,
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
  SessionTodoItem,
  SessionUsage,
  PromptInput,
  PromptSkillActivation,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionSummary,
  SessionSummaryPage,
  SkillSummary,
  PluginCommandDef,
  SuggestFilesInput,
  SuggestFilesResult,
  Unsubscribe,
  UploadFileOptions,
  WorkspaceTrustInfo,
} from '#/types';

const MAIN_AGENT_ID = 'main';

export interface SessionPromptRpcInput {
  readonly sessionId: string;
  readonly input: PromptInput;
  readonly disabledTools?: readonly string[];
  readonly promptId?: string;
}

export interface SessionPromptWithSkillsRpcInput extends SessionPromptRpcInput {
  readonly skills: readonly PromptSkillActivation[];
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

export interface SetSessionTowerModeRpcInput extends SessionIdRpcInput {
  readonly enabled: boolean;
  readonly base?: string;
}

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

export interface SwitchSessionRuntimeRpcInput extends SessionIdRpcInput {
  readonly runtimeId: string;
}

export interface ReconnectMcpServerRpcInput extends SessionIdRpcInput {
  readonly name: string;
  readonly config?: McpServerConfig;
}

export interface SessionWarningInfo {
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
}

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

  abstract createSession(input: CreateSessionOptions): Promise<SessionSummary>;

  async createSessionWithKaos(
    input: CreateSessionOptions,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<SessionSummary> {
    void kaos;
    void persistenceKaos;
    return this.createSession(input);
  }

  abstract resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary>;

  async resumeSessionWithKaos(
    input: ResumeSessionInput,
    kaos: Kaos,
    persistenceKaos?: Kaos,
  ): Promise<ResumedSessionSummary> {
    void kaos;
    void persistenceKaos;
    return this.resumeSession(input);
  }

  abstract reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary>;

  abstract forkSession(input: ForkSessionInput): Promise<SessionSummary>;

  abstract closeSession(input: SessionIdRpcInput): Promise<void>;

  abstract deleteSession(input: SessionIdRpcInput): Promise<void>;

  abstract listSessions(input?: ListSessionsOptions): Promise<readonly SessionSummary[]>;

  abstract listSessionsPage(input?: ListSessionsOptions): Promise<SessionSummaryPage>;

  abstract listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]>;

  abstract getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo>;

  abstract trustWorkspace(workDir: string): Promise<void>;

  abstract renameSession(input: RenameSessionInput): Promise<void>;

  abstract generateSessionTitle(input: GenerateSessionTitleInput): Promise<string | undefined>;

  abstract exportSession(input: ExportSessionInput): Promise<ExportSessionResult>;

  abstract getConfig(input?: GetConfigOptions): Promise<KimiConfig>;

  abstract getConfigDiagnostics(): Promise<ConfigDiagnostics>;

  abstract getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]>;

  abstract setConfig(input: KimiConfigPatch): Promise<KimiConfig>;

  abstract removeProvider(providerId: string): Promise<KimiConfig>;

  abstract supportsAtomicSectionReplace(): boolean;

  abstract replaceConfigSections(sections: Record<string, unknown>): Promise<void>;

  abstract uploadFile(data: Uint8Array, options: UploadFileOptions): Promise<FileMeta>;

  abstract deleteFile(fileId: string): Promise<void>;

  abstract listGlobalMcpServers(options?: {
    readonly cwd?: string;
  }): Promise<readonly McpManagedServerInfo[]>;

  abstract getGlobalMcpServer(
    name: string,
    options?: { readonly cwd?: string },
  ): Promise<McpManagedServerInfo>;

  abstract listGlobalMcpServerAuthStatuses(options?: {
    readonly cwd?: string;
    readonly verify?: boolean;
  }): Promise<readonly GlobalMcpServerAuthStatus[]>;

  abstract inspectAppMcpServers(
    targets?: readonly McpServerLocator[],
    options?: { readonly cwd?: string },
  ): Promise<readonly AppMcpServerInspection[]>;

  abstract addGlobalMcpServer(
    server: McpServerConfig,
    options?: { readonly cwd?: string },
  ): Promise<readonly McpManagedServerInfo[]>;

  abstract updateGlobalMcpServer(
    server: McpServerConfig,
    options?: { readonly cwd?: string },
  ): Promise<readonly McpManagedServerInfo[]>;

  abstract removeGlobalMcpServer(
    name: string,
    options?: { readonly cwd?: string },
  ): Promise<readonly McpManagedServerInfo[]>;

  abstract beginGlobalMcpServerAuth(
    name: string,
    options?: { readonly cwd?: string },
  ): Promise<BeginGlobalMcpServerAuthResult>;

  abstract beginMcpServerAuth(
    locator: McpServerLocator,
    options?: { readonly cwd?: string },
  ): Promise<BeginGlobalMcpServerAuthResult>;

  abstract completeGlobalMcpServerAuth(
    input: { readonly flowId: string; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<void>;

  abstract completeMcpServerAuth(
    input: { readonly flowId: string; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<void>;

  abstract cancelGlobalMcpServerAuth(flowId: string): Promise<void>;

  abstract cancelMcpServerAuth(flowId: string): Promise<void>;

  abstract resetGlobalMcpServerAuth(name: string, options?: { readonly cwd?: string }): Promise<void>;

  abstract resetMcpServerAuth(
    locator: McpServerLocator,
    options?: { readonly cwd?: string },
  ): Promise<void>;

  abstract testGlobalMcpServer(
    name: string,
    options?: { readonly cwd?: string },
  ): Promise<McpTestResult>;

  abstract testGlobalMcpServerConfig(
    server: McpServerConfig,
    options?: { readonly cwd?: string },
  ): Promise<McpTestResult>;

  abstract prompt(input: SessionPromptRpcInput): Promise<void>;

  abstract promptWithSkills(input: SessionPromptWithSkillsRpcInput): Promise<void>;

  abstract runShellCommand(input: {
    sessionId: string;
    command: string;
    commandId?: string;
  }): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }>;

  abstract cancelShellCommand(input: { sessionId: string; commandId: string }): Promise<void>;

  abstract steer(input: SessionPromptRpcInput): Promise<void>;

  abstract generateAgentsMd(input: SessionIdRpcInput): Promise<void>;

  abstract getSessionWarnings(input: SessionIdRpcInput): Promise<readonly SessionWarningInfo[]>;

  abstract addAdditionalDir(input: AddAdditionalDirInput): Promise<AddAdditionalDirResult>;

  abstract startBtw(input: SessionIdRpcInput): Promise<string>;

  abstract cancel(input: SessionIdRpcInput): Promise<void>;

  abstract clearContext(input: SessionIdRpcInput): Promise<void>;

  abstract importContext(input: ImportContextRpcInput): Promise<void>;

  abstract setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult>;

  abstract setThinking(input: SetSessionThinkingRpcInput): Promise<void>;

  abstract setPermission(input: SetSessionPermissionRpcInput): Promise<void>;

  abstract updateSessionMetadata(input: UpdateSessionMetadataRpcInput): Promise<void>;

  abstract setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void>;

  abstract setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void>;

  abstract swarm(input: SessionPromptRpcInput): Promise<void>;

  abstract setTowerMode(input: SetSessionTowerModeRpcInput): Promise<void>;

  abstract getPlan(input: SessionIdRpcInput): Promise<SessionPlan>;

  abstract clearPlan(input: SessionIdRpcInput): Promise<void>;

  abstract compact(input: SessionIdRpcInput & CompactOptions): Promise<void>;

  abstract cancelCompaction(input: SessionIdRpcInput): Promise<void>;

  abstract getTodos(input: SessionIdRpcInput): Promise<readonly SessionTodoItem[]>;

  abstract undoHistory(input: SessionIdRpcInput & { count: number }): Promise<void>;

  abstract getContext(input: SessionIdRpcInput): Promise<AgentContextData>;

  abstract getUsage(input: SessionIdRpcInput): Promise<SessionUsage>;

  abstract getStatus(input: SessionIdRpcInput): Promise<SessionStatus>;

  abstract listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]>;

  abstract listPluginCommands(input: SessionIdRpcInput): Promise<readonly PluginCommandDef[]>;

  abstract listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]>;

  abstract suggestFiles(
    workDir: string,
    input: SuggestFilesInput,
  ): Promise<SuggestFilesResult | undefined>;

  abstract listBackgroundTasks(
    input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]>;

  abstract getBackgroundTaskOutput(
    input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string>;

  abstract stopBackgroundTask(
    input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void>;

  abstract detachBackgroundTask(
    input: SessionIdRpcInput & { taskId: string },
  ): Promise<BackgroundTaskInfo | undefined>;

  abstract waitForBackgroundTasksOnPrint(input: SessionIdRpcInput): Promise<void>;

  abstract handlePrintMainTurnCompleted(input: SessionIdRpcInput): Promise<'finish' | 'continue'>;

  abstract createGoal(input: SessionIdRpcInput & CreateGoalInput): Promise<GoalSnapshot>;

  abstract getGoal(input: SessionIdRpcInput): Promise<GoalToolResult>;

  abstract pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;

  abstract resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;

  abstract cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;

  abstract getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult>;

  abstract listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]>;

  abstract listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerInfo[]>;

  abstract getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics>;

  abstract reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void>;

  abstract addSessionMcpServer(input: {
    readonly sessionId: string;
    readonly server: McpServerConfig;
    readonly persist?: boolean;
  }): Promise<McpServerInfo>;

  abstract listPlugins(): Promise<readonly PluginSummary[]>;

  abstract installPlugin(source: string): Promise<PluginSummary>;

  abstract setPluginEnabled(id: string, enabled: boolean): Promise<void>;

  abstract setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;

  abstract removePlugin(id: string): Promise<void>;

  abstract reloadPlugins(): Promise<ReloadSummary>;

  abstract getPluginInfo(id: string): Promise<PluginInfo>;

  abstract activateSkill(input: ActivateSkillRpcInput): Promise<void>;

  abstract activatePluginCommand(input: ActivatePluginCommandRpcInput): Promise<void>;

  abstract listCommands(input: SessionIdRpcInput): Promise<readonly AgentCommandInfo[]>;

  abstract runCommand(input: RunCommandRpcInput): Promise<void>;

  abstract getRuntime(input: SessionIdRpcInput): Promise<AgentRuntimeBinding>;

  abstract switchRuntime(input: SwitchSessionRuntimeRpcInput): Promise<AgentRuntimeBinding>;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
