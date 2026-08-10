/**
 * tui-session.ts — the session contract the interactive TUI depends on.
 *
 * The TUI and its controllers/commands used to annotate `this.session` as the
 * SDK `Session` *concrete class*. That class carries private fields, so
 * TypeScript's structural rules forbid assigning any non-`Session` value to it
 * — which blocks swapping in a native-engine facade.
 *
 * `TuiSession` is derived with `Pick` from a local mirror of the SDK `Session`
 * surface (see the `Session` interface below; the member shapes mirror
 * `#/cli/sdk-types-local`, the localized SDK type mirror), so:
 *  - every member signature stays in sync with the SDK shape (no drift), and
 *  - the derived type is a plain structural object type (no private brand), so
 *    the SDK `Session` satisfies it *and* an alternative implementation (the
 *    native-engine {@link NativeSession} facade) can satisfy it too.
 *
 * The member set below is the full surface the TUI, its controllers, and its
 * slash commands touch. Adding a new `session.<member>` call in the TUI means
 * adding the member here (the compiler enforces it once files annotate against
 * `TuiSession`).
 */
import type {
  AddAdditionalDirOptions,
  AddAdditionalDirResult,
  AgentContextData,
  ApprovalHandler,
  BackgroundTaskInfo,
  CompactOptions,
  CreateGoalInput,
  Event,
  GetCronTasksResult,
  GoalSnapshot,
  GoalToolResult,
  JsonObject,
  McpServerInfo,
  McpStartupMetrics,
  PermissionMode,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PromptInput,
  ReloadSessionOptions,
  ReloadSummary,
  ResumedSessionState,
  ResumedSessionSummary,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionUsage,
  SkillSummary,
  SwarmModeTrigger,
  ThinkingEffort,
  Unsubscribe,
} from '#/cli/sdk-types-local';

/** Loosened mirror of the SDK question handler (host-side AskUserQuestion). */
type QuestionHandler = (request: Record<string, unknown>) => unknown;

/**
 * Local mirror of the SDK `Session` surface, narrowed to the members the TUI
 * touches (the pick list below). Shapes follow `#/cli/sdk-types-local`; keep
 * in sync when the TUI starts calling a new `session.<member>`.
 */
interface Session {
  // Identity / metadata
  readonly id: string;
  readonly workDir: string;
  readonly summary?: SessionSummary | undefined;
  // Events + reverse-RPC handlers
  onEvent(listener: (event: Event) => void): Unsubscribe;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  // Resume / reload
  getResumeState(): ResumedSessionState | undefined;
  reloadSession(options?: ReloadSessionOptions): Promise<ResumedSessionSummary>;
  // Turn driving
  prompt(input: string | PromptInput): Promise<void>;
  steer(input: string | PromptInput): Promise<void>;
  swarm(input: string | PromptInput): Promise<void>;
  cancel(): Promise<void>;
  // Shell
  runShellCommand(
    command: string,
    options?: { readonly commandId?: string },
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly isError?: boolean;
    readonly backgrounded?: boolean;
  }>;
  cancelShellCommand(commandId: string): Promise<void>;
  // Session-level actions
  init(): Promise<void>;
  getSessionWarnings(): Promise<readonly unknown[]>;
  addAdditionalDir(path: string, options?: AddAdditionalDirOptions): Promise<AddAdditionalDirResult>;
  startBtw(): Promise<string>;
  // Runtime mode / config
  setModel(model: string): Promise<void>;
  setThinking(effort: ThinkingEffort): Promise<void>;
  setPermission(mode: PermissionMode): Promise<void>;
  updateMetadata(patch: JsonObject): Promise<void>;
  setPlanMode(enabled: boolean): Promise<void>;
  setSwarmMode(enabled: boolean, trigger: SwarmModeTrigger): Promise<void>;
  // Plan
  getPlan(): Promise<SessionPlan>;
  clearPlan(): Promise<void>;
  // Context
  compact(options?: CompactOptions): Promise<void>;
  cancelCompaction(): Promise<void>;
  undoHistory(count?: number): Promise<void>;
  clearContext(): Promise<void>;
  importContext(content: string, source: string): Promise<void>;
  getContext(): Promise<AgentContextData>;
  // Status / usage
  getUsage(): Promise<SessionUsage>;
  getStatus(): Promise<SessionStatus>;
  // Skills
  listSkills(): Promise<readonly SkillSummary[]>;
  activateSkill(name: string, args?: string): Promise<void>;
  // Plugin commands (model-facing)
  listPluginCommands(): Promise<readonly PluginCommandDef[]>;
  activatePluginCommand(pluginId: string, commandName: string, args?: string): Promise<void>;
  // Goal lifecycle
  createGoal(input: CreateGoalInput): Promise<GoalSnapshot>;
  getGoal(): Promise<GoalToolResult>;
  pauseGoal(): Promise<GoalSnapshot>;
  resumeGoal(): Promise<GoalSnapshot>;
  cancelGoal(): Promise<GoalSnapshot>;
  // Cron
  getCronTasks(): Promise<GetCronTasksResult>;
  // MCP
  listMcpServers(): Promise<readonly McpServerInfo[]>;
  getMcpStartupMetrics(): Promise<McpStartupMetrics>;
  reconnectMcpServer(name: string): Promise<void>;
  // Plugin management
  listPlugins(): Promise<readonly PluginSummary[]>;
  installPlugin(source: string): Promise<PluginSummary>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
  removePlugin(id: string): Promise<void>;
  reloadPlugins(): Promise<ReloadSummary>;
  getPluginInfo(id: string): Promise<PluginInfo>;
  // Background tasks
  listBackgroundTasks(options?: {
    readonly activeOnly?: boolean;
    readonly limit?: number;
  }): Promise<readonly BackgroundTaskInfo[]>;
  getBackgroundTaskOutput(taskId: string): Promise<string>;
  stopBackgroundTask(taskId: string, options?: { readonly reason?: string }): Promise<void>;
  detachBackgroundTask(taskId: string): Promise<BackgroundTaskInfo | undefined>;
  waitForBackgroundTasksOnPrint(): Promise<void>;
  handlePrintMainTurnCompleted(): Promise<'finish' | 'continue'>;
  // Lifecycle
  close(): Promise<void>;
}

export type TuiSession = Pick<
  Session,
  // Identity / metadata
  | 'id'
  | 'workDir'
  | 'summary'
  // Events + reverse-RPC handlers
  | 'onEvent'
  | 'setApprovalHandler'
  | 'setQuestionHandler'
  // Resume / reload
  | 'getResumeState'
  | 'reloadSession'
  // Turn driving
  | 'prompt'
  | 'steer'
  | 'swarm'
  | 'cancel'
  // Shell
  | 'runShellCommand'
  | 'cancelShellCommand'
  // Session-level actions
  | 'init'
  | 'getSessionWarnings'
  | 'addAdditionalDir'
  | 'startBtw'
  // Runtime mode / config
  | 'setModel'
  | 'setThinking'
  | 'setPermission'
  | 'updateMetadata'
  | 'setPlanMode'
  | 'setSwarmMode'
  // Plan
  | 'getPlan'
  | 'clearPlan'
  // Context
  | 'compact'
  | 'cancelCompaction'
  | 'undoHistory'
  | 'clearContext'
  | 'importContext'
  | 'getContext'
  // Status / usage
  | 'getUsage'
  | 'getStatus'
  // Skills
  | 'listSkills'
  | 'activateSkill'
  // Plugin commands (model-facing)
  | 'listPluginCommands'
  | 'activatePluginCommand'
  // Goal lifecycle
  | 'createGoal'
  | 'getGoal'
  | 'pauseGoal'
  | 'resumeGoal'
  | 'cancelGoal'
  // Cron
  | 'getCronTasks'
  // MCP
  | 'listMcpServers'
  | 'getMcpStartupMetrics'
  | 'reconnectMcpServer'
  // Plugin management
  | 'listPlugins'
  | 'installPlugin'
  | 'setPluginEnabled'
  | 'setPluginMcpServerEnabled'
  | 'removePlugin'
  | 'reloadPlugins'
  | 'getPluginInfo'
  // Background tasks
  | 'listBackgroundTasks'
  | 'getBackgroundTaskOutput'
  | 'stopBackgroundTask'
  | 'detachBackgroundTask'
  | 'waitForBackgroundTasksOnPrint'
  | 'handlePrintMainTurnCompleted'
  // Lifecycle
  | 'close'
> & {
  /**
   * Native-engine sessions rename via `session/update_metadata`; harness
   * sessions go through the harness instead. Absent on sessions that cannot
   * rename themselves.
   */
  renameSession?: (title: string) => Promise<void>;
};
