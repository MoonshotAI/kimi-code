/**
 * KimiTUI owns the terminal UI shell for a Kimi Code session.
 *
 * It builds the pi-tui layout, tracks view state, wires editor shortcuts and
 * slash commands, drives session startup/switching, renders SDK events into the
 * transcript and live panes, and bridges approval, question, auth, and config
 * flows back to the harness.
 */

import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir as osHomedir, release as osRelease, type as osType } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  Container,
  deleteAllKittyImages,
  type Component,
  type Focusable,
  getCapabilities,
  ProcessTerminal,
  type SlashCommand,
  Spacer,
  TUI,
} from '@earendil-works/pi-tui';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import {
  applyOpenPlatformConfig,
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  OpenPlatformApiError,
  type DeviceAuthorization,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  log,
} from '@moonshot-ai/kimi-code-sdk';
import { BUILT_IN_CATALOG_JSON } from '../built-in-catalog';
import type {
  AgentReplayRecord,
  AgentStatusUpdatedEvent,
  ApprovalRequest,
  ApprovalResponse,
  AssistantDeltaEvent,
  BackgroundTaskInfo,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  BackgroundTaskUpdatedEvent,
  Catalog,
  CatalogModel,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  ContextMessage,
  CreateSessionOptions,
  ErrorEvent,
  Event,
  HookResultEvent,
  KimiHarness,
  ModelAlias,
  McpServerInfo,
  PermissionMode,
  PluginInfo,
  PluginSummary,
  PromptOrigin,
  PromptPart,
  ResumedAgentState,
  Session,
  SessionMetaUpdatedEvent,
  SessionStatus,
  SessionUsage,
  SkillActivatedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  ThinkingDeltaEvent,
  ToolCall,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
  WarningEvent,
} from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import type { CLIOptions } from '#/cli/options';
import { detectInstallSource } from '#/cli/update/source';
import { detectShellEnvironment } from '#/utils/process/shell-env';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';
import { MigrationScreenComponent, type MigrationScreenResult } from '#/migration/index';
import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import type { GitLsFilesCache } from '#/utils/git/git-ls-files';
import { createGitLsFilesCache } from '#/utils/git/git-ls-files';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { parseImageMeta } from '#/utils/image/image-mime';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';
import { getInputHistoryFile } from '#/utils/paths';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';
import { detectFdPath } from '#/utils/process/fd-detect';
import { buildExportMarkdown } from './utils/export-markdown';

import {
  BUILTIN_SLASH_COMMANDS,
  buildSkillSlashCommands,
  parseSlashInput,
  resolveSlashCommandInput,
  slashBusyMessage,
  sortSlashCommands,
  type BuiltinSlashCommandName,
  type KimiSlashCommand,
  type SkillListSession,
} from './commands';
import { DeviceCodeBoxComponent } from './components/chrome/device-code-box';
import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import { CHROME_GUTTER } from './constant/rendering';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader';
import { TodoPanelComponent, type TodoItem } from './components/chrome/todo-panel';
import { WelcomeComponent } from './components/chrome/welcome';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from './components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from './components/dialogs/approval-preview';
import {
  ApiKeyInputDialogComponent,
  type ApiKeyInputResult,
} from './components/dialogs/api-key-input-dialog';
import { CompactionComponent } from './components/dialogs/compaction';
import { EditorSelectorComponent } from './components/dialogs/editor-selector';
import {
  FeedbackInputDialogComponent,
  type FeedbackInputDialogResult,
} from './components/dialogs/feedback-input-dialog';
import { HelpPanelComponent } from './components/dialogs/help-panel';
import { ChoicePickerComponent, type ChoiceOption } from './components/dialogs/choice-picker';
import { ModelSelectorComponent } from './components/dialogs/model-selector';
import { PlatformSelectorComponent } from './components/dialogs/platform-selector';
import { PermissionSelectorComponent } from './components/dialogs/permission-selector';
import {
  PluginMcpSelectorComponent,
  PluginMarketplaceSelectorComponent,
  PluginRemoveConfirmComponent,
  PluginsOverviewSelectorComponent,
  type PluginMcpSelection,
  type PluginMarketplaceSelection,
  type PluginRemoveConfirmResult,
  type PluginsOverviewSelection,
} from './components/dialogs/plugins-selector';
import { QuestionDialogComponent } from './components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from './components/dialogs/session-picker';
import { TaskOutputViewer } from './components/dialogs/task-output-viewer';
import { TasksBrowserApp, type TasksFilter } from './components/dialogs/tasks-browser';
import {
  SettingsSelectorComponent,
  type SettingsSelection,
} from './components/dialogs/settings-selector';
import { ThemeSelectorComponent } from './components/dialogs/theme-selector';
import { CustomEditor } from './components/editor/custom-editor';
import { FileMentionProvider } from './components/editor/file-mention-provider';
import { AgentGroupComponent } from './components/messages/agent-group';
import { AssistantMessageComponent } from './components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from './components/messages/background-agent-status';
import { buildMcpStatusReportLines } from './components/messages/mcp-status-panel';
import { ReadGroupComponent } from './components/messages/read-group';
import { SkillActivationComponent } from './components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { buildStatusReportLines } from './components/messages/status-panel';
import { ThinkingComponent } from './components/messages/thinking';
import { ToolCallComponent } from './components/messages/tool-call';
import {
  buildPluginsInfoLines,
  buildPluginsListLines,
} from './components/messages/plugins-status-panel';
import {
  buildUsageReportLines,
  UsagePanelComponent,
  type ManagedUsageReport,
} from './components/messages/usage-panel';
import { UserMessageComponent } from './components/messages/user-message';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane';
import { QueuePaneComponent } from './components/panes/queue-pane';
import { saveTuiConfig, type TuiConfig } from './config';
import {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_STATUS_CANCELLED,
  FEEDBACK_STATUS_FALLBACK,
  FEEDBACK_STATUS_NOT_SIGNED_IN,
  FEEDBACK_STATUS_SUBMITTING,
  FEEDBACK_STATUS_SUCCESS,
  FEEDBACK_TELEMETRY_EVENT,
  errorReportHintLine,
  feedbackSessionLine,
  withFeedbackVersionPrefix,
} from './constant/feedback';
import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  DEFAULT_OAUTH_PROVIDER_NAME,
  EXIT_CONFIRM_WINDOW_MS,
  isManagedUsageProvider,
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  NO_ACTIVE_SESSION_MESSAGE,
  OAUTH_LOGIN_REQUIRED_CODE,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
  PRODUCT_NAME,
} from './constant/kimi-tui';
import { STREAMING_UI_FLUSH_MS } from './constant/streaming';
import { adaptPanelResponse } from './reverse-rpc/approval/adapter';
import { ApprovalController } from './reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from './reverse-rpc/approval/handler';
import { registerReverseRPCHandlers } from './reverse-rpc/index';
import { QuestionController } from './reverse-rpc/question/controller';
import { createQuestionAskHandler } from './reverse-rpc/question/handler';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types';
import { createKimiTUIThemeBundle, type KimiTUIThemeBundle } from './theme/bundle';
import type { ResolvedTheme } from './theme/colors';
import { isTheme, type Theme } from './theme/index';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type BackgroundAgentMetadata,
  type LivePaneState,
  type QueuedMessage,
  type ToolCallBlockData,
  type ToolResultBlockData,
  type TranscriptEntry,
} from './types';
import { formatBackgroundAgentTranscript } from './utils/background-agent-status';
import { formatBackgroundTaskTranscript } from './utils/background-task-status';
import { hasDispose, isExpandable, isPlanExpandable } from './utils/component-capabilities';
import { resolveConnectCatalogRequest } from './utils/connect-catalog';
import { isDeadTerminalError } from './utils/dead-terminal';
import {
  appendStreamingArgsPreview,
  argsRecord,
  formatErrorMessage,
  isTodoItemShape,
  parseStreamingArgs,
  serializeToolResultOutput,
  stringValue,
} from './utils/event-payload';
import { isAbortError } from './utils/errors';
import { formatHookResultMarkdown, formatHookResultPlain } from './utils/hook-result-format';
import { ImageAttachmentStore, type ImageAttachment } from './utils/image-attachment-store';
import { extractMediaAttachments } from './utils/image-placeholder';
import { McpOAuthAuthorizationUrlOpener } from './utils/mcp-oauth';
import {
  appStateFromResumeAgent,
  backgroundOrigin,
  collectReplayMessageContent,
  contentPartsToText,
  countActiveBackgroundTasks,
  createReplayRenderContext,
  formatHookResultMessageForTranscript,
  isTerminalBackgroundTask,
  limitReplayRecordsByTurn,
  REPLAY_TURN_LIMIT,
  replayBackgroundProjection,
  replayEntry,
  skillActivationFromOrigin,
  toolCallFromReplayMessage,
  toolResultOutput,
  type ReplayRenderContext,
  type SkillActivationProjection,
} from './utils/message-replay';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from './utils/mcp-server-status';
import { hasPatchChanges } from './utils/object-patch';
import { openUrl } from './utils/open-url';
import { setProcessTitle } from './utils/proctitle';
import { sessionRowsForPicker } from './utils/session-picker-rows';
import { installTerminalFocusTracking } from './utils/terminal-focus';
import { notifyTerminalOnce } from './utils/terminal-notification';
import { createTerminalState, type TerminalState } from './utils/terminal-state';
import { installTerminalThemeTracking } from './utils/terminal-theme';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import { nextTranscriptId } from './utils/transcript-id';
import { formatStepDebugTiming } from '#/utils/usage/debug-timing';

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  readonly resolvedTheme?: ResolvedTheme;
  readonly migrationPlan?: MigrationPlan | null;
  /** When true, run only the migration screen, then exit (the `kimi migrate` command). */
  readonly migrateOnly?: boolean;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly plan: boolean;
  readonly model?: string;
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface KimiTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
  resolvedTheme?: ResolvedTheme;
}

export interface TUIState {
  ui: TUI;
  terminal: ProcessTerminal;
  transcriptContainer: Container;
  activityContainer: Container;
  todoPanelContainer: Container;
  todoPanel: TodoPanelComponent;
  queueContainer: Container;
  editorContainer: Container;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: KimiTUIThemeBundle;
  appState: AppState;
  startupState: TUIStartupState;
  startupNotice: string | undefined;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  activitySpinner: MoonLoader | undefined;
  activitySpinnerStyle: SpinnerStyle | undefined;
  activeThinkingComponent: ThinkingComponent | undefined;
  streamingComponent: AssistantMessageComponent | undefined;
  streamingTranscriptEntry: TranscriptEntry | undefined;
  activeCompactionBlock: CompactionComponent | undefined;
  toolOutputExpanded: boolean;
  planExpanded: boolean;
  lastActivityMode: string | undefined;
  lastHistoryContent: string | undefined;
  pendingToolComponents: Map<string, ToolCallComponent>;
  pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: AgentGroupComponent;
  } | null;
  pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null;
  backgroundAgents: Set<string>;
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata>;
  /**
   * Authoritative live mirror of the BPM. Keyed by `taskId`. Includes
   * both bash and agent tasks, and retains terminal entries until they
   * are explicitly forgotten (kept so transcript replay and footer
   * lookups stay consistent).
   */
  backgroundTasks: Map<string, BackgroundTaskInfo>;
  /**
   * Task IDs whose terminal transcript card has already been pushed.
   * Used to dedupe between the BPM `background.task.terminated` event
   * and the older `subagent.completed/failed` flow, both of which
   * arrive for `agent-*` tasks.
   */
  backgroundTaskTranscriptedTerminal: Set<string>;
  renderedSkillActivationIds: Set<string>;
  renderedMcpServerStatusKeys: Map<string, string>;
  mcpServerStatusSpinners: Map<string, MoonLoader>;
  subagentParentToolCallIds: Map<string, string>;
  subagentNames: Map<string, string>;
  sessions: SessionRow[];
  loadingSessions: boolean;
  showingSessionPicker: boolean;
  showingHelpPanel: boolean;
  /**
   * Active `/tasks` full-screen takeover. When non-undefined, the main
   * TUI's children have been replaced by `component`; `savedChildren`
   * holds the original list so we can restore on exit.
   */
  tasksBrowser:
    | {
        component: TasksBrowserApp;
        savedChildren: readonly Component[];
        filter: TasksFilter;
        selectedTaskId: string | undefined;
        tailOutput: string | undefined;
        tailLoading: boolean;
        tailRequestId: number;
        flashMessage: string | undefined;
        flashTimer: NodeJS.Timeout | undefined;
        pollTimer: NodeJS.Timeout | undefined;
        /**
         * Active nested output viewer (TaskOutputViewer). Undefined when
         * the browser is showing its normal 3-pane layout.
         */
        viewer:
          | {
              component: TaskOutputViewer;
              savedChildren: readonly Component[];
              /** Task whose output the viewer is currently following. */
              taskId: string;
              /** Latest output snapshot pushed into the viewer. */
              output: string;
              /** Last in-flight refresh — used to ignore late responses. */
              refreshId: number;
              /** 1s background poll so live tail still works if events drop. */
              pollTimer: NodeJS.Timeout;
            }
          | undefined;
      }
    | undefined;
  externalEditorRunning: boolean;
  currentTurnId: string | undefined;
  currentStep: number;
  assistantDraft: string;
  assistantStreamActive: boolean;
  thinkingDraft: string;
  activeToolCalls: Map<string, ToolCallBlockData>;
  streamingToolCallArguments: Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >;
  queuedMessages: QueuedMessage[];
}

// Builds the app-state snapshot used before a session is attached.
function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.yolo ? 'yolo' : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    sessionId: '',
    yolo: input.cliOptions.yolo,
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isStreaming: false,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: input.tuiConfig.theme,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    notifications: input.tuiConfig.notifications,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
  };
}

// Creates all pi-tui components and mutable runtime state owned by KimiTUI.
export function createTUIState(options: KimiTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = createKimiTUIThemeBundle(initialAppState.theme, options.resolvedTheme);

  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);

  // Every chrome container runs with a 2-column outer gutter on each
  // side. That gives the transcript, panels, the editor and the
  // statusline a shared left edge — the input box's `│` lines up with
  // panel borders like Welcome's `│`, and bullets / `>` share a column.
  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent(theme.colors);
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, theme.colors);
  const footer = new FooterComponent({ ...initialAppState }, theme.colors, () => {
    ui.requestRender();
  });

  return {
    ui,
    terminal,
    transcriptContainer,
    activityContainer,
    todoPanelContainer,
    todoPanel,
    queueContainer,
    editorContainer,
    footer,
    editor,
    theme,
    appState: { ...initialAppState },
    startupState: 'pending',
    startupNotice: options.startup.startupNotice,
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    activitySpinner: undefined,
    activitySpinnerStyle: undefined,
    activeThinkingComponent: undefined,
    streamingComponent: undefined,
    streamingTranscriptEntry: undefined,
    activeCompactionBlock: undefined,
    toolOutputExpanded: false,
    planExpanded: false,
    lastActivityMode: undefined,
    lastHistoryContent: undefined,
    pendingToolComponents: new Map<string, ToolCallComponent>(),
    pendingAgentGroup: null,
    pendingReadGroup: null,
    backgroundAgents: new Set<string>(),
    backgroundAgentMetadata: new Map<string, BackgroundAgentMetadata>(),
    backgroundTasks: new Map<string, BackgroundTaskInfo>(),
    backgroundTaskTranscriptedTerminal: new Set<string>(),
    renderedSkillActivationIds: new Set<string>(),
    renderedMcpServerStatusKeys: new Map<string, string>(),
    mcpServerStatusSpinners: new Map<string, MoonLoader>(),
    subagentParentToolCallIds: new Map<string, string>(),
    subagentNames: new Map<string, string>(),
    sessions: [],
    loadingSessions: false,
    showingSessionPicker: false,
    showingHelpPanel: false,
    tasksBrowser: undefined,
    externalEditorRunning: false,
    currentTurnId: undefined,
    currentStep: 0,
    assistantDraft: '',
    assistantStreamActive: false,
    thinkingDraft: '',
    activeToolCalls: new Map<string, ToolCallBlockData>(),
    streamingToolCallArguments: new Map(),
    queuedMessages: [],
  };
}

// Merges startup notices while preserving their display order.
function combineStartupNotice(
  existing: string | undefined,
  next: string | undefined,
): string | undefined {
  if (existing !== undefined && next !== undefined) {
    return `${existing}\n${next}`;
  }
  return existing ?? next;
}

function isOAuthLoginRequiredError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { readonly code?: unknown }).code === OAUTH_LOGIN_REQUIRED_CODE;
}

interface SessionUsageResult {
  readonly usage?: SessionUsage;
  readonly error?: string;
}

interface ManagedUsageResult {
  readonly usage?: ManagedUsageReport;
  readonly error?: string;
}

interface RuntimeStatusResult {
  readonly status?: SessionStatus;
  readonly error?: string;
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly hasMedia?: boolean;
}

interface LoginProgressSpinnerHandle {
  /** Stops the login progress row and replaces it with a final status. */
  stop(opts: { ok: boolean; label: string }): void;
}

export class KimiTUI {
  private readonly harness: KimiHarness;
  private readonly options: KimiTUIOptions;
  private session: Session | undefined;
  private state: TUIState;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly KimiSlashCommand[] = [];
  private readonly skillCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  private readonly fdPath: string | null = detectFdPath();
  private readonly gitLsFilesCache: GitLsFilesCache;
  private sessionEventUnsubscribe: (() => void) | undefined;
  private pendingExit: PendingExit | null = null;
  private cancelInFlight: (() => void) | undefined;
  // Queues editor messages instead of sending or steering them. Used by /init.
  private deferUserMessages = false;
  private aborted = false;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  // Cleanup callbacks for SIGHUP/SIGTERM listeners and stdout/stderr 'error'
  // listeners installed by `registerSignalHandlers()`. Drained on shutdown so
  // we never leave dangling listeners on the host `process`.
  private signalCleanupHandlers: Array<() => void> = [];
  // Guards `stop()` and `emergencyTerminalExit()` so a signal arriving mid-
  // shutdown does not race with itself.
  private isShuttingDown = false;
  // First-launch migration plan detected pre-TUI; null when nothing to migrate.
  private readonly migrationPlan: MigrationPlan | null;
  // When true, the migration screen is the whole session: run it, then exit.
  private readonly migrateOnly: boolean;
  // High-frequency model/tool deltas update draft state immediately, then use
  // these flags to coalesce expensive component rebuilds into periodic flushes.
  private streamingUiFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastStreamingUiFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  private readonly pendingToolCallFlushIds = new Set<string>();

  // The currently-mounted approval panel, if any. Kept so the full-screen
  // preview viewer can restore focus to the exact same instance (and its
  // selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // Active full-screen approval preview. While set, the root UI's normal
  // children are stashed in `savedChildren`; closing restores them.
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        savedChildren: readonly Component[];
        panel: ApprovalPanelComponent;
      }
    | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  private track(
    event: string,
    properties?: Parameters<KimiHarness['track']>[1],
  ): void {
    this.harness.track(event, properties);
  }

  // Initializes state, reverse-RPC handlers, editor callbacks, and layout.
  constructor(harness: KimiHarness, startupInput: KimiTUIStartupInput) {
    this.harness = harness;
    const tuiOptions: KimiTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
      startup: {
        sessionFlag: startupInput.cliOptions.session,
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        plan: startupInput.cliOptions.plan,
        model: startupInput.cliOptions.model,
        startupNotice: startupInput.startupNotice,
      },
      resolvedTheme: startupInput.resolvedTheme,
    };
    this.options = tuiOptions;
    this.migrationPlan = startupInput.migrationPlan ?? null;
    this.migrateOnly = startupInput.migrateOnly ?? false;
    this.state = createTUIState(tuiOptions);
    this.gitLsFilesCache = createGitLsFilesCache(tuiOptions.initialAppState.workDir);

    // Register approval / question UI controllers before SDK handlers.
    this.reverseRpcDisposers.push(
      ...registerReverseRPCHandlers(this.approvalController, this.questionController, {
        showApprovalPanel: (payload) => {
          this.showApprovalPanel(payload);
        },
        hideApprovalPanel: () => {
          this.hideApprovalPanel();
        },
        showQuestionDialog: (payload) => {
          this.showQuestionDialog(payload);
        },
        hideQuestionDialog: () => {
          this.hideQuestionDialog();
        },
      }),
    );
    this.setupEditorHandlers();
    this.buildLayout();
  }

  // =========================================================================
  // Startup Helpers
  // =========================================================================

  // Returns built-in and dynamically loaded slash commands in display order.
  private getSlashCommands(): readonly KimiSlashCommand[] {
    return [...sortSlashCommands(BUILTIN_SLASH_COMMANDS), ...this.skillCommands];
  }

  // Rebuilds editor autocomplete from slash commands and file mentions.
  private setupAutocomplete(): void {
    const slashCommands: SlashCommand[] = this.getSlashCommands().map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }));
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
      this.gitLsFilesCache,
    );
    this.state.editor.setAutocompleteProvider(provider);
  }

  // Loads skill-backed slash commands from the active session.
  private async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      this.skillCommands = [];
      this.skillCommandMap.clear();
      this.setupAutocomplete();
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  // Restores persisted input history for the current working directory.
  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.state.editor.addToHistory(entry.content);
      }
      this.state.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      /* history is best-effort */
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  // Starts the TUI, performs startup routing, and begins session event handling.
  async start(): Promise<void> {
    // Arm SIGHUP/SIGTERM and stdout/stderr 'error' handlers before touching the
    // terminal: once raw mode is on and timers start firing, a dying parent
    // shell can pin a CPU core on EIO write retries unless we can self-exit.
    this.registerSignalHandlers();
    // Outer try ensures the signal handlers are rolled back if any startup
    // path throws. Without this, callers that retry `start()` in the same
    // Node process (tests, embedded use) would accumulate listeners on
    // `process` and trip `MaxListenersExceededWarning`. Inner catch blocks
    // still own their UI/focus cleanup; this only handles the listener half.
    try {
      // Migration path: the migration screen is a pi-tui component, so the
      // event loop must run first. It then renders as the very first thing on
      // screen, before the session is created and the Welcome banner is drawn.
      if (this.migrationPlan !== null) {
        this.startEventLoop();
        try {
          const migrationResult = await this.runMigrationScreen(this.migrationPlan);
          if (this.migrateOnly) {
            // Explicit `kimi migrate`: the screen is the whole command — exit
            // instead of continuing into the chat TUI. A migration that ran
            // but failed exits non-zero so scripted callers can detect it.
            const failed =
              migrationResult.decision === 'now' && migrationResult.migrated === false;
            // Restore the terminal before `onExit` calls `process.exit`: dispose
            // the focus/theme tracking `startEventLoop()` installed, then stop
            // the pi-tui loop. Skipping either leaves the terminal in raw mode
            // or still emitting focus/OSC sequences after the command finishes.
            this.disposeTerminalTracking();
            this.state.ui.stop();
            await this.onExit?.(failed ? 1 : 0);
            return;
          }
          const shouldReplayHistory = await this.initMainTui();
          await this.finishStartup(shouldReplayHistory);
        } catch (error) {
          // The pi-tui loop is running and startEventLoop() installed focus/
          // theme tracking; a startup failure must tear all of it down before
          // the exception propagates, otherwise the terminal is left in raw
          // mode or still emitting focus/OSC sequences.
          this.disposeTerminalTracking();
          this.state.ui.stop();
          throw error;
        }
        return;
      }

      // No-migration path: ordering is identical to the original `start()`.
      const shouldReplayHistory = await this.initMainTui();
      this.startEventLoop();
      try {
        await this.finishStartup(shouldReplayHistory);
      } catch (error) {
        // The pi-tui loop is running and startEventLoop() installed focus/theme
        // tracking; tear all of it down so a finishStartup failure does not
        // leave the terminal in raw mode or emitting focus/OSC sequences.
        this.disposeTerminalTracking();
        this.state.ui.stop();
        throw error;
      }
    } catch (error) {
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  // Creates/resumes the session, renders the Welcome banner, configures
  // autocomplete and input history, and mounts the editor. Returns whether
  // transcript history should be replayed.
  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    this.renderWelcome();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    return shouldReplayHistory;
  }

  // Starts the pi-tui event loop and installs terminal focus/theme tracking.
  private startEventLoop(): void {
    this.state.ui.start();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state);
    this.refreshTerminalThemeTracking();
  }

  // Runs post-init startup tasks: startup notice, picker bootstrap, transcript
  // replay, and session event subscriptions.
  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.state.startupNotice !== undefined) {
      this.showStatus(this.state.startupNotice);
      this.state.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    if (this.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      // resumeSession (fired on picker select) owns post-pick init; nothing
      // else to do here until the user makes a choice.
      return;
    }
    if (shouldReplayHistory) {
      await this.hydrateTranscriptFromReplay(this.requireSession());
    }
    const resumeState = this.session?.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, this.state.theme.colors.warning);
    }
    if (this.session !== undefined) {
      this.startSessionEventSubscription();
    }
    void this.fetchSessions();
    if (this.session !== undefined) {
      this.refreshSessionTitle();
    }
    void this.refreshSkillCommands(this.session);
  }

  // Warns tmux users when modified Enter shortcuts are likely to be swallowed.
  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, this.state.theme.colors.warning);
  }

  // Creates or resumes the startup session and reports whether history should replay.
  private async init(): Promise<boolean> {
    await this.refreshAvailableModels();

    const { startup } = this.options;
    const { workDir } = this.state.appState;
    let session: Session | undefined;
    let shouldReplayHistory = false;
    const isResumeStartup = startup.sessionFlag !== undefined || startup.continueLast;
    const createSessionOptions: CreateSessionOptions = {
      workDir,
      model: startup.model,
      permission: startup.yolo ? 'yolo' : undefined,
      planMode: startup.plan ? true : undefined,
    };

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === '') {
          this.state.startupState = 'picker';
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.harness.listSessions({ workDir });
          const target = sessions.find((candidate) => candidate.id === startup.sessionFlag);
          if (target === undefined) {
            throw new Error(`Session "${startup.sessionFlag}" not found.`);
          }
          session = await this.harness.resumeSession({ id: startup.sessionFlag });
          shouldReplayHistory = true;
        } else {
          const sessions = await this.harness.listSessions({ workDir });
          const target = sessions[0];
          if (target !== undefined) {
            session = await this.harness.resumeSession({ id: target.id });
            shouldReplayHistory = true;
          } else {
            session = await this.harness.createSession(createSessionOptions);
            this.state.startupNotice = combineStartupNotice(
              this.state.startupNotice,
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
            );
          }
        }
      } else {
        session = await this.harness.createSession(createSessionOptions);
      }
      if (session !== undefined && startup.model !== undefined && isResumeStartup) {
        await session.setModel(startup.model);
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.enterLoginRequiredStartupState();
      return false;
    }

    if (session === undefined) {
      throw new Error('Startup session was not initialized.');
    }
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.state.startupState = 'ready';
    return shouldReplayHistory;
  }

  // Stops UI resources, active sessions, reverse-RPC handlers, and the harness.
  // `exitCode` is forwarded to `onExit`; it defaults to the conventional 0 for
  // user-initiated exits (e.g. `/exit`). Signal-driven shutdown paths pass the
  // POSIX 128 + signum value so supervisors can tell signal exits from clean
  // exits.
  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    this.discardPendingStreamingUiUpdates();
    if (this.pendingExit) {
      clearTimeout(this.pendingExit.timer);
      this.pendingExit = null;
    }
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    await this.closeSession('shutting down');
    await this.harness.close();
    this.stopAllMcpServerStatusSpinners();
    this.state.ui.stop();
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // Installs SIGHUP/SIGTERM signal handlers and stdout/stderr 'error' listeners
  // so the process can self-terminate when the controlling terminal goes away.
  //
  // SIGHUP and EIO/EPIPE/ENOTCONN on stdout/stderr both mean "the terminal is
  // gone". Running the normal `stop()` path in that state writes restore
  // sequences (cursor show, bracketed paste off, Kitty protocol off) which
  // re-trigger EIO and have been observed to pin a CPU core for days.
  // `emergencyTerminalExit()` is the safe response: it bypasses cleanup.
  //
  // SIGTERM is treated as a graceful shutdown request and routes through the
  // normal `stop()` path so telemetry and session state get flushed.
  //
  // `prependListener` ensures we run before any subsequent listener a feature
  // might register later in startup, since responsiveness here is critical.
  private registerSignalHandlers(): void {
    this.unregisterSignalHandlers();

    const signals: NodeJS.Signals[] = ['SIGTERM'];
    if (process.platform !== 'win32') {
      signals.push('SIGHUP');
    }

    for (const signal of signals) {
      const handler = (): void => {
        if (signal === 'SIGHUP') {
          this.emergencyTerminalExit();
          return;
        }
        // SIGTERM: preserve the POSIX 128 + SIGTERM(15) = 143 convention so
        // supervisors (launchd, systemd, pm2, parent shells) can distinguish
        // signal-driven exit from a normal `/exit`. Registering a listener
        // disables Node's default 143 termination, so we must reinstate it
        // explicitly. Forcing `process.exit(143)` after `stop()` resolves
        // also guards the defensive case where `onExit` was never wired up.
        // On cleanup failure we exit 143 too — the process must not hang
        // on pending I/O once `isShuttingDown` has been latched.
        this.stop(143).then(
          () => {
            process.exit(143);
          },
          () => {
            this.emergencyTerminalExit(143);
          },
        );
      };
      process.prependListener(signal, handler);
      this.signalCleanupHandlers.push(() => {
        process.off(signal, handler);
      });
    }

    const terminalErrorHandler = (error: Error): void => {
      if (isDeadTerminalError(error)) {
        this.emergencyTerminalExit();
      }
    };
    process.stdout.on('error', terminalErrorHandler);
    process.stderr.on('error', terminalErrorHandler);
    this.signalCleanupHandlers.push(() => {
      process.stdout.off('error', terminalErrorHandler);
    });
    this.signalCleanupHandlers.push(() => {
      process.stderr.off('error', terminalErrorHandler);
    });
  }

  private unregisterSignalHandlers(): void {
    const handlers = this.signalCleanupHandlers;
    this.signalCleanupHandlers = [];
    for (const cleanup of handlers) cleanup();
  }

  // Bails out without running normal shutdown. Reserved for SIGHUP / dead-
  // terminal write errors where every additional stdout write risks looping
  // on EIO. The default exit code 129 follows the POSIX 128 + SIGHUP(1)
  // convention; SIGTERM cleanup failures pass 143 (128 + SIGTERM(15)) so
  // supervisors still see signal-conventional exits.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    process.exit(exitCode);
  }

  // Tears down the terminal focus + theme tracking installed by
  // `startEventLoop()`. Every exit path must run this, or the terminal is
  // left with focus-reporting / theme-query modes on and emits stray
  // focus/OSC sequences after the process exits.
  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  // Returns the currently selected session id shown by the UI.
  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  // Reports whether the transcript contains user-visible session content.
  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  async getStartupMcpMs(): Promise<number> {
    const session = this.session;
    if (session === undefined) return 0;
    try {
      const metrics = await session.getMcpStartupMetrics();
      return metrics.durationMs;
    } catch {
      return 0;
    }
  }

  // =========================================================================
  // Auth / Model Bootstrap
  // =========================================================================

  // Refreshes model metadata from the harness config.
  private async refreshAvailableModels(): Promise<void> {
    const config = await this.harness.getConfig({ reload: true });
    this.setAppState({
      availableModels: config.models ?? {},
      availableProviders: config.providers ?? {},
    });
  }

  // Allows the shell to start even when the managed OAuth token needs login.
  private enterLoginRequiredStartupState(): void {
    this.resetSessionRuntime();
    this.setAppState({
      sessionId: '',
      model: '',
      thinking: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
    this.state.startupNotice = combineStartupNotice(
      this.state.startupNotice,
      OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
    );
    this.state.startupState = 'ready';
  }

  // Ensures a usable session exists for the default model after login.
  private async activateModelAfterLogin(model: string, thinking?: boolean): Promise<void> {
    const level = thinking === undefined ? undefined : thinking ? 'on' : 'off';
    if (this.session !== undefined) {
      await this.session.setModel(model);
      if (level !== undefined) {
        await this.session.setThinking(level);
      }
      return;
    }

    const session = await this.harness.createSession({
      workDir: this.state.appState.workDir,
      model,
      thinking: level,
      permission: this.options.startup.yolo ? 'yolo' : undefined,
      planMode: this.state.appState.planMode ? true : undefined,
    });
    await this.setSession(session);
    this.setAppState({
      sessionId: session.id,
      sessionTitle: session.summary?.title ?? null,
    });
    await this.syncRuntimeState(session);
    this.startSessionEventSubscription();
    void this.fetchSessions();
    this.refreshSessionTitle();
    void this.refreshSkillCommands(this.session);
  }

  // Clears the active session and runtime UI after logout.
  private async clearActiveSessionAfterLogout(): Promise<void> {
    await this.closeSession('logged out');
    this.resetSessionRuntime();
    this.setAppState({
      sessionId: '',
      model: '',
      sessionTitle: null,
    });
    await this.refreshSkillCommands();
  }

  // Reloads config after login and selects the configured default model.
  private async refreshConfigAfterLogin(): Promise<void> {
    const config = await this.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    const defaultModel = this.options.startup.model ?? config.defaultModel;
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;

    if (defaultModel === undefined || selected === undefined) {
      this.setAppState({ availableModels, availableProviders });
      return;
    }

    await this.activateModelAfterLogin(defaultModel, config.defaultThinking);
    const appStatePatch: Partial<AppState> = {
      availableModels,
      availableProviders,
      model: defaultModel,
      maxContextTokens: selected.maxContextSize,
    };
    if (config.defaultThinking !== undefined) {
      appStatePatch.thinking = config.defaultThinking;
    }
    this.setAppState(appStatePatch);
  }

  // Reloads config after logout and clears model-dependent state.
  private async refreshConfigAfterLogout(): Promise<void> {
    const config = await this.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    this.setAppState({
      availableModels,
      availableProviders,
      model: '',
      thinking: false,
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
    });
  }

  // =========================================================================
  // Layout / Editor Setup
  // =========================================================================

  // Mounts the root TUI containers in their rendering order.
  private buildLayout(): void {
    const { ui } = this.state;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.todoPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.editorContainer);
    // FooterComponent isn't a Container; wrap it so it picks up the same
    // outer gutter as the transcript/panels above.
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    ui.addChild(footerWrap);
  }

  // Wires editor shortcuts, submission, paste, and navigation callbacks.
  private setupEditorHandlers(): void {
    const editor = this.state.editor;

    editor.onSubmit = (text: string) => {
      this.handleUserInput(text);
    };

    editor.onChange = (text: string) => {
      if (this.pendingExit) this.clearPendingExit();
      this.updateEditorBorderHighlight(text);
    };

    editor.onCtrlC = () => {
      if (this.cancelInFlight !== undefined) {
        const cancel = this.cancelInFlight;
        this.cancelInFlight = undefined;
        this.clearPendingExit();
        cancel();
        return;
      }

      if (this.state.appState.isStreaming) {
        this.clearPendingExit();
        this.cancelCurrentStream();
        return;
      }

      if (this.state.appState.isCompacting) {
        this.clearPendingExit();
        this.cancelCurrentCompaction();
        return;
      }

      if (this.pendingExit?.kind === 'ctrl-c') {
        this.clearPendingExit();
        void this.stop();
        return;
      }

      if (editor.getText().length > 0) {
        editor.setText('');
      }
      this.armPendingExit('ctrl-c', CTRL_C_HINT);
    };

    editor.onCtrlD = () => {
      if (this.pendingExit?.kind === 'ctrl-d') {
        this.clearPendingExit();
        void this.stop();
        return;
      }
      this.armPendingExit('ctrl-d', CTRL_D_HINT);
    };

    editor.onEscape = () => {
      if (this.pendingExit) this.clearPendingExit();
      if (this.state.showingSessionPicker) {
        this.hideSessionPicker();
        return;
      }
      if (this.state.appState.isStreaming) {
        this.cancelCurrentStream();
        return;
      }
      if (this.state.appState.isCompacting) {
        this.cancelCurrentCompaction();
      }
    };

    editor.onShiftTab = () => {
      const session = this.session;
      if (session === undefined) {
        this.showError(NO_ACTIVE_SESSION_MESSAGE);
        return;
      }
      const next = !this.state.appState.planMode;
      this.track('shortcut_plan_toggle', { enabled: next });
      this.track('shortcut_mode_switch', { to_mode: next ? 'plan' : 'agent' });
      void this.applyPlanMode(session, next);
    };

    editor.onOpenExternalEditor = () => {
      this.track('shortcut_editor');
      void this.openExternalEditor();
    };

    editor.onToggleToolExpand = () => {
      this.track('shortcut_expand');
      this.toggleToolOutputExpansion();
    };

    editor.onTogglePlanExpand = () => this.togglePlanExpansion();

    editor.onCtrlS = () => {
      if (!this.state.appState.isStreaming || this.state.appState.isCompacting) return;
      const text = editor.getText().trim();
      const queuedTexts = this.state.queuedMessages.map((m) => m.text);
      this.state.queuedMessages = [];

      const parts: string[] = [];
      for (const q of queuedTexts) {
        const trimmed = q.trim();
        if (trimmed.length > 0) parts.push(trimmed);
      }
      if (text.length > 0) parts.push(text);

      if (parts.length > 0) {
        editor.setText('');
        const session = this.session;
        if (this.state.appState.model.trim().length === 0 || session === undefined) {
          this.showError(LLM_NOT_SET_MESSAGE);
        } else {
          this.steerMessage(session, parts);
        }
      }
      this.updateQueueDisplay();
      this.state.ui.requestRender();
    };

    editor.onUndo = () => {
      this.track('undo');
    };

    editor.onInsertNewline = () => {
      this.track('shortcut_newline');
    };

    editor.onTextPaste = () => {
      this.track('shortcut_paste', { kind: 'text' });
    };

    editor.onUpArrowEmpty = () => {
      if (!this.state.appState.isStreaming && !this.state.appState.isCompacting) return false;
      const recalled = this.recallLastQueued();
      if (recalled !== undefined) {
        editor.setText(recalled);
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return true;
      }
      return false;
    };

    editor.onPasteImage = async () => this.handleClipboardImagePaste();
  }

  // Cancels the pending double-key exit prompt.
  private clearPendingExit(): void {
    if (!this.pendingExit) return;
    clearTimeout(this.pendingExit.timer);
    this.state.footer.setTransientHint(null);
    this.pendingExit = null;
  }

  // Starts a timed confirmation window for Ctrl-C or Ctrl-D exit.
  private armPendingExit(kind: 'ctrl-c' | 'ctrl-d', hint: string): void {
    this.clearPendingExit();
    this.state.footer.setTransientHint(hint);

    const timer = setTimeout(() => {
      if (this.pendingExit?.timer === timer) {
        this.clearPendingExit();
        this.state.ui.requestRender();
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    this.pendingExit = { kind, timer };
    this.state.ui.requestRender();
  }

  // Reads image or video data from the clipboard and inserts an attachment placeholder.
  private async handleClipboardImagePaste(): Promise<boolean> {
    let media;
    try {
      media = await readClipboardMedia();
    } catch (error) {
      if (error instanceof ClipboardMediaError) {
        this.showError(error.message);
        return true;
      }
      return false;
    }
    if (media === null) return false;

    if (media.kind === 'video') {
      const attachment = this.imageStore.addVideo(media.mimeType, media.sourcePath, media.filename);
      this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
      this.state.ui.requestRender();
      this.track('shortcut_paste', { kind: 'video' });
      return true;
    }

    const meta = parseImageMeta(media.bytes);
    if (meta === null) return false;
    const attachment = this.imageStore.addImage(media.bytes, meta.mime, meta.width, meta.height);
    this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.state.ui.requestRender();
    this.track('shortcut_paste', { kind: 'image' });
    return true;
  }

  // Opens the configured external editor and writes the edited text back.
  private async openExternalEditor(): Promise<void> {
    if (this.state.externalEditorRunning) return;
    const cmd = resolveEditorCommand(this.state.appState.editorCommand);
    if (cmd === undefined) {
      this.showError('No editor configured. Set $VISUAL / $EDITOR, or run /editor <command>.');
      return;
    }
    this.state.externalEditorRunning = true;
    const seed = this.state.editor.getExpandedText?.() ?? this.state.editor.getText();
    this.state.ui.stop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const result = await editInExternalEditor(seed, cmd);
      if (result !== undefined) {
        this.state.editor.setText(result.replaceAll('\r\n', '\n').replace(/\n$/, ''));
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`External editor failed: ${msg}`);
    } finally {
      if (typeof process.stdin.pause === 'function') {
        process.stdin.pause();
      }
      this.state.ui.start();
      this.state.ui.setFocus(this.state.editor);
      this.state.ui.requestRender(true);
      this.state.externalEditorRunning = false;
    }
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  // Routes submitted editor text to slash command handling or normal prompting.
  private handleUserInput(text: string): void {
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError('Cannot send input while session history is replaying.');
      return;
    }
    void this.persistInputHistory(text);
    if (parseSlashInput(text) !== null) {
      void this.executeSlashCommand(text);
      return;
    }

    this.sendNormalUserInput(text);
  }

  // Parses and executes a slash command intent.
  private async executeSlashCommand(input: string): Promise<void> {
    const parsedCommand = parseSlashInput(input);
    const intent = resolveSlashCommandInput({
      input,
      skillCommandMap: this.skillCommandMap,
      isStreaming: this.state.appState.isStreaming,
      isCompacting: this.state.appState.isCompacting,
    });

    switch (intent.kind) {
      case 'not-command':
        return;
      case 'blocked':
        this.track('input_command_invalid', { reason: 'blocked', command: intent.commandName });
        this.showError(slashBusyMessage(intent.commandName, intent.reason));
        return;
      case 'skill': {
        const session = this.session;
        if (this.state.appState.model.trim().length === 0 || session === undefined) {
          this.showError(LLM_NOT_SET_MESSAGE);
          return;
        }
        this.track('input_command', {
          command: intent.commandName,
          skill_name: intent.skillName,
        });
        this.sendSkillActivation(session, intent.skillName, intent.args);
        return;
      }
      case 'message': {
        this.sendNormalUserInput(intent.input);
        return;
      }
      case 'builtin':
        this.track('input_command', { command: intent.name });
        if (intent.name === 'new' && parsedCommand?.name === 'clear') {
          this.track('clear');
        }
        try {
          await this.handleBuiltInSlashCommand(intent.name, intent.args);
        } catch (error) {
          this.showError(formatErrorMessage(error));
        }
        return;
    }
  }

  // Dispatches a built-in slash command to its concrete handler.
  private async handleBuiltInSlashCommand(
    name: BuiltinSlashCommandName,
    args: string,
  ): Promise<void> {
    switch (name) {
      case 'exit':
        void this.stop();
        return;
      case 'help':
        this.showHelpPanel();
        return;
      case 'version':
        this.showStatus(`Kimi Code v${this.state.appState.version}`);
        return;
      case 'new':
        await this.createNewSession();
        this.state.ui.requestRender();
        return;
      case 'sessions':
        void this.showSessionPicker();
        return;
      case 'tasks':
        void this.showTasksBrowser();
        return;
      case 'mcp':
        void this.showMcpServers();
        return;
      case 'plugins':
        void this.handlePluginsCommand(args);
        return;
      case 'editor':
        await this.handleEditorCommand(args, {});
        return;
      case 'theme':
        await this.handleThemeCommand(args);
        return;
      case 'model':
        this.handleModelCommand(args);
        return;
      case 'permission':
        this.showPermissionPicker();
        return;
      case 'settings':
        this.showSettingsSelector();
        return;
      case 'usage':
        void this.showUsage();
        return;
      case 'status':
        void this.showStatusReport();
        return;
      case 'feedback':
        await this.handleFeedbackCommand();
        return;
      case 'title':
        await this.handleTitleCommand(args);
        return;
      case 'yolo':
        await this.handleYoloCommand(args);
        return;
      case 'plan':
        await this.handlePlanCommand(args);
        return;
      case 'compact':
        await this.handleCompactCommand(args);
        return;
      case 'init':
        await this.handleInitCommand();
        return;
      case 'fork':
        await this.handleForkCommand(args);
        return;
      case 'export-md':
        await this.handleExportMdCommand(args);
        return;
      case 'export-debug-zip':
        await this.handleExportDebugZipCommand();
        return;
      case 'login':
        await this.handleLoginCommand();
        return;
      case 'connect':
        await this.handleConnectCommand(args);
        return;
      case 'logout':
        await this.handleLogoutCommand();
        return;
      default:
        this.showError(`Unknown slash command: /${String(name)}`);
        return;
    }
  }

  // Sends regular user input after validating model and media support.
  private sendNormalUserInput(text: string): void {
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    const extraction = extractMediaAttachments(text, this.imageStore);
    if (!this.validateMediaCapabilities(extraction)) return;
    const session = this.session;
    if (session === undefined) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  // Checks whether the current model can accept attached media.
  private validateMediaCapabilities(
    extraction: ReturnType<typeof extractMediaAttachments>,
  ): boolean {
    if (!extraction.hasMedia) return true;
    if (
      extraction.imageAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError('Current model does not support image input.');
      return false;
    }
    if (
      extraction.videoAttachmentIds.length > 0 &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.showError('Current model does not support video input.');
      return false;
    }
    return true;
  }

  // Tests the active model's advertised capability list.
  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  // Persists a submitted input line and mirrors it into editor history.
  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.state.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.state.lastHistoryContent);
      if (written) this.state.lastHistoryContent = trimmed;
    } catch {
      this.state.lastHistoryContent = trimmed;
    }
  }

  // Pops the most recent queued message back into the editor.
  private recallLastQueued(): string | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const last = this.state.queuedMessages.at(-1)!;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    return last.text;
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  // Adds a message to the queue for delivery after current work finishes.
  private enqueueMessage(text: string, options?: SendMessageOptions): void {
    this.state.queuedMessages.push({
      text,
      agentId: this.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
    });
    this.track('input_queue');
  }

  // Resets request-scoped state before submitting work to the active session.
  private beginSessionRequest(): void {
    this.state.currentTurnId = undefined;
    this.resetLiveTextRuntime();
    this.resetLiveToolUiState();
    this.resetToolCallState();

    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      isStreaming: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  // Ends a failed session request and renders the failure to the transcript.
  private failSessionRequest(message: string): void {
    this.setAppState({ isStreaming: false, streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  // Sends a queued message after restoring the agent target captured at enqueue time.
  private sendQueuedMessage(session: Session, item: QueuedMessage): void {
    this.harness.interactiveAgentId = item.agentId ?? MAIN_AGENT_ID;
    this.sendMessageInternal(session, item.text, {
      parts: item.parts,
      imageAttachmentIds: item.imageAttachmentIds,
    });
  }

  // Appends the user message and sends the prompt to the session immediately.
  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    });

    this.beginSessionRequest();

    const sdkInput = options?.parts ?? input;
    void session.prompt(sdkInput).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Failed to send: ${message}`);
    });
  }

  // Starts a skill activation turn on the session.
  private sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
    this.beginSessionRequest();
    void session.activateSkill(skillName, skillArgs).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.failSessionRequest(`Skill "${skillName}" failed: ${message}`);
    });
  }

  // Sends a message now or queues it when the session is busy.
  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    if (
      this.deferUserMessages ||
      this.state.appState.isStreaming ||
      this.state.appState.isCompacting
    ) {
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  // Sends steering input into an active stream or falls back to normal prompts.
  private steerMessage(session: Session, input: string[]): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      for (const part of input) {
        this.enqueueMessage(part);
      }
      return;
    }
    if (!this.state.appState.isStreaming) {
      for (const part of input) {
        this.sendMessageInternal(session, part);
      }
      return;
    }

    for (const part of input) {
      this.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'user',
        turnId: this.state.currentTurnId,
        renderMode: 'plain',
        content: part,
      });
    }

    void session.steer(input.join('\n\n')).catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.showError(`Failed to steer: ${message}`);
    });
  }

  // Requests cancellation of the active session stream.
  private cancelCurrentStream(): void {
    const session = this.session;
    if (session === undefined) return;
    void session.cancel();
  }

  private cancelCurrentCompaction(): void {
    const session = this.session;
    if (session === undefined) return;
    void session.cancelCompaction().catch((error: unknown) => {
      const message = formatErrorMessage(error);
      this.showError(`Failed to cancel compaction: ${message}`);
    });
  }

  private hasPendingStreamingUiUpdates(): boolean {
    return (
      this.pendingAssistantFlush ||
      this.pendingThinkingFlush ||
      this.pendingToolCallFlushIds.size > 0
    );
  }

  private clearStreamingUiFlushTimer(): void {
    if (this.streamingUiFlushTimer === undefined) return;
    clearTimeout(this.streamingUiFlushTimer);
    this.streamingUiFlushTimer = undefined;
  }

  private clearStreamingUiFlushTimerIfIdle(): void {
    if (this.hasPendingStreamingUiUpdates()) return;
    this.clearStreamingUiFlushTimer();
  }

  private discardPendingStreamingUiUpdates(): void {
    this.clearStreamingUiFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlushIds.clear();
  }

  // Schedule trailing UI work for streaming deltas. Terminal drawing is already
  // coalesced by pi-tui; this avoids doing our own markdown/tool preview rebuild
  // work on every chunk before pi-tui even gets a chance to render.
  private scheduleStreamingUiFlush(): void {
    if (!this.hasPendingStreamingUiUpdates()) return;
    if (this.streamingUiFlushTimer !== undefined) return;
    const delay =
      this.lastStreamingUiFlushAt === undefined
        ? 0
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastStreamingUiFlushAt));
    this.streamingUiFlushTimer = setTimeout(() => {
      this.streamingUiFlushTimer = undefined;
      this.flushStreamingUiUpdates();
    }, delay);
  }

  // Final events such as tool.result or turn.ended must observe all streamed
  // draft content, so they bypass the timer and drain pending UI work first.
  private flushStreamingUiUpdatesNow(): void {
    this.clearStreamingUiFlushTimer();
    this.flushStreamingUiUpdates();
  }

  private flushStreamingUiUpdates(): void {
    if (!this.hasPendingStreamingUiUpdates()) return;
    this.lastStreamingUiFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    const toolCallIds = [...this.pendingToolCallFlushIds];
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;
    this.pendingToolCallFlushIds.clear();

    if (shouldFlushThinking && this.state.thinkingDraft.length > 0) {
      this.onThinkingUpdate(this.state.thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this.state.assistantDraft);
    }
    for (const id of toolCallIds) {
      this.flushStreamingToolCallPreview(id);
    }
  }

  // Materializes the latest bounded argument preview for one in-flight tool
  // call. The final tool.call event still replaces this with authoritative args.
  private flushStreamingToolCallPreview(id: string): void {
    const streaming = this.state.streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this.state.activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this.state.currentStep,
      turnId: this.state.currentTurnId,
    };
    this.state.activeToolCalls.set(id, toolCall);

    if (this.state.thinkingDraft.length > 0 || this.state.assistantStreamActive) {
      this.finalizeLiveTextBuffers('tool');
    }

    const existingComponent = this.state.pendingToolComponents.get(id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (toolCall.name !== 'Agent') {
      this.onToolCallStart(toolCall);
    }
  }

  // Finalizes live thinking output and moves the live pane to the next mode.
  // onThinkingEnd() is safe to call even when no component exists (it no-ops
  // when activeThinkingComponent is undefined), and clearing an already-empty
  // thinkingDraft is harmless, so we can unconditionally clean up.
  private flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushStreamingUiUpdatesNow();
    this.state.thinkingDraft = '';
    this.onThinkingEnd();
    this.patchLivePane({ mode: nextMode });
  }

  // Finalizes live assistant text and clears streaming component state.
  private finalizeAssistantStream(): void {
    this.flushStreamingUiUpdatesNow();
    if (this.state.assistantStreamActive) {
      this.onStreamingTextEnd();
      this.state.assistantStreamActive = false;
    }
    this.state.assistantDraft = '';
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  // Discards live thinking and assistant text state without finalizing transcript output.
  private resetLiveTextRuntime(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearStreamingUiFlushTimerIfIdle();
    this.state.assistantDraft = '';
    this.state.assistantStreamActive = false;
    this.state.streamingComponent = undefined;
    this.state.streamingTranscriptEntry = undefined;
    this.state.thinkingDraft = '';
    this.disposeActiveThinkingComponent();
  }

  // Clears live tool UI state while preserving active tool-call tracking.
  private resetLiveToolUiState(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearStreamingUiFlushTimerIfIdle();
    this.state.streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this.state.pendingAgentGroup = null;
    this.state.pendingReadGroup = null;
  }

  // Clears SDK tool-call tracking.
  private resetToolCallState(): void {
    this.state.activeToolCalls.clear();
  }

  // Finalizes any live thinking and assistant text for a phase transition.
  private finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  // Completes a turn, dispatches queued work, and sends completion notification.
  private finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    if (!this.state.appState.isStreaming) return;
    this.deferUserMessages = false;
    const completedTurnKey =
      this.state.currentTurnId ?? `local:${String(this.state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    this.resetToolCallState();
    this.state.currentTurnId = undefined;

    if (this.state.queuedMessages.length > 0) {
      const [next, ...rest] = this.state.queuedMessages;
      this.state.queuedMessages = rest;
      this.setAppState({ isStreaming: false, streamingPhase: 'idle' });
      this.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          sendQueued(next);
        }, 0);
      }
      return;
    }

    this.setAppState({ isStreaming: false, streamingPhase: 'idle' });
    this.resetLivePane();
    notifyTerminalOnce(this.state, `turn-complete:${completedTurnKey}`, {
      title: 'Kimi Code task complete',
      body: this.state.appState.sessionTitle ?? undefined,
    });
  }

  // =========================================================================
  // State Helpers
  // =========================================================================

  // Applies app-state changes and refreshes dependent UI surfaces.
  private setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const busyChanged = 'isStreaming' in patch || 'isCompacting' in patch;
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  // Applies live-pane changes and refreshes activity presentation.
  private patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  // Restores the live pane to its initial idle state.
  private resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  // =========================================================================
  // Session Runtime
  // =========================================================================

  // Returns the active session or raises the standard no-session error.
  private requireSession(): Session {
    if (this.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.session;
  }

  // Creates a session using the current model, known session runtime, permission, and plan state.
  private async createSessionFromCurrentState(): Promise<Session> {
    const model = this.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(LLM_NOT_SET_MESSAGE);
    }
    return this.harness.createSession({
      workDir: this.state.appState.workDir,
      model,
      thinking:
        this.session === undefined ? undefined : this.state.appState.thinking ? 'on' : 'off',
      permission: this.state.appState.permissionMode,
      planMode: this.state.appState.planMode ? true : undefined,
    });
  }

  // Replaces the active session and installs approval/question handlers.
  private async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
  }

  // Pulls runtime session status into the app state.
  private async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const status = await session.getStatus();
    this.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinking: status.thinkingLevel !== 'off',
      permissionMode: status.permission,
      yolo: status.permission === 'yolo',
      planMode: status.planMode,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      sessionTitle: session.summary?.title ?? null,
    });
  }

  // Applies current permission to the active session. Plan mode is applied by
  // createSession when requested, so post-create setup must not enter it again.
  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  // Detaches and closes the current session.
  private async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
  }

  // Detaches session subscriptions and cancels pending interactive requests.
  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.harness.setTelemetryContext({ sessionId: null });
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
  }

  // Connects session approval and question requests to local controllers.
  private registerSessionHandlers(session: Session): void {
    session.setApprovalHandler(
      createApprovalRequestHandler(this.approvalController, (request, response) => {
        this.appendApprovalTranscriptEntry(request, response);
      }),
    );
    session.setQuestionHandler(createQuestionAskHandler(this.questionController));
  }

  // Loads session picker rows for the current working directory.
  private async fetchSessions(): Promise<void> {
    this.state.loadingSessions = true;
    try {
      const sessions = await this.harness.listSessions({ workDir: this.state.appState.workDir });
      this.state.sessions = sessionRowsForPicker(
        sessions,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
    } catch {
      /* silently ignore */
    } finally {
      this.state.loadingSessions = false;
    }
  }

  // Syncs the process title with the current session title and id.
  private refreshSessionTitle(): void {
    setProcessTitle(this.state.appState.sessionTitle, this.state.appState.sessionId);
  }

  // Resets turn, tool, queue, and background-agent state for a session switch.
  private resetSessionRuntime(): void {
    this.aborted = false;
    this.discardPendingStreamingUiUpdates();
    this.state.queuedMessages = [];
    this.harness.interactiveAgentId = MAIN_AGENT_ID;
    this.resetToolCallState();
    this.resetLiveToolUiState();
    this.state.backgroundAgents.clear();
    this.state.backgroundAgentMetadata.clear();
    this.state.backgroundTasks.clear();
    this.state.backgroundTaskTranscriptedTerminal.clear();
    this.closeTasksBrowser();
    this.state.subagentParentToolCallIds.clear();
    this.state.subagentNames.clear();
    this.state.renderedSkillActivationIds.clear();
    this.state.renderedMcpServerStatusKeys.clear();
    this.stopAllMcpServerStatusSpinners();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.setTodoList([]);
    this.state.currentTurnId = undefined;
    this.state.currentStep = 0;
    this.resetLiveTextRuntime();
    this.updateQueueDisplay();
  }

  // Switches to an existing session and replays its transcript.
  private async resumeSession(targetSessionId: string): Promise<boolean> {
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus('Already on this session.');
      return true;
    }
    if (this.state.appState.isStreaming) {
      this.showError('Cannot switch sessions while streaming — press Esc or Ctrl-C first.');
      return false;
    }
    if (this.state.appState.isReplaying) {
      this.showError('Cannot switch sessions while history is replaying.');
      return false;
    }

    let session: Session;
    try {
      session = await this.harness.resumeSession({ id: targetSessionId });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to resume session ${targetSessionId}: ${msg}`);
      return false;
    }

    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  // Switches to a provided session and replays its transcript.
  private async switchToSession(session: Session, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.refreshSessionTitle();
    try {
      await this.refreshSkillCommands(this.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.clearTranscriptAndRedraw();
    try {
      await this.hydrateTranscriptFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to replay session history: ${msg}`);
    } finally {
      this.startSessionEventSubscription();
    }
    const resumeState = session.getResumeState();
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, this.state.theme.colors.warning);
    }
    this.showStatus(statusMessage);
  }

  // Creates a fresh session from current UI settings and resets the transcript.
  private async createNewSession(): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError('Cannot start a new session while history is replaying.');
      return;
    }

    let session: Session;
    try {
      session = await this.createSessionFromCurrentState();
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to start a new session: ${msg}`);
      return;
    }

    this.resetSessionRuntime();
    await this.setSession(session);
    this.setAppState({ sessionId: session.id });
    try {
      await this.activateRuntime();
      await this.syncRuntimeState(session);
    } catch (error) {
      this.startSessionEventSubscription();
      const msg = formatErrorMessage(error);
      this.showError(`Post-create setup failed: ${msg}`);
      return;
    }
    try {
      await this.refreshSkillCommands(this.session);
    } catch {
      /* keep the new session usable even if dynamic skills fail */
    }
    this.startSessionEventSubscription();
    this.clearTranscriptAndRedraw();
    this.showStatus(`Started a new session (${session.id}).`);
  }

  // =========================================================================
  // Session Replay
  // =========================================================================

  private async hydrateTranscriptFromReplay(session: Session): Promise<boolean> {
    this.setAppState({ isReplaying: true });
    try {
      const main = session.getResumeState()?.agents['main'];
      if (main === undefined) {
        this.showError('Session history is unavailable for this session.');
        return false;
      }

      this.hydrateReplaySnapshot(main);
      this.renderReplayRecords(main);
      return true;
    } catch (error) {
      const message = formatErrorMessage(error);
      this.showError(`Failed to replay session history: ${message}`);
      return false;
    } finally {
      this.setAppState({ isReplaying: false });
    }
  }

  private hydrateReplaySnapshot(agent: ResumedAgentState): void {
    this.setAppState(appStateFromResumeAgent(agent));
    this.hydrateTodoPanelFromResume(agent);
    this.hydrateBackgroundStateFromResume(agent);
  }

  private hydrateTodoPanelFromResume(agent: ResumedAgentState): void {
    const rawTodos = agent.toolStore?.['todo'];
    if (!Array.isArray(rawTodos)) {
      this.setTodoList([]);
      return;
    }

    const todos = rawTodos
      .filter((todo): todo is TodoItem => isTodoItemShape(todo))
      .map((todo) => ({ title: todo.title, status: todo.status }));
    if (todos.length > 0 && todos.every((todo) => todo.status === 'done')) {
      this.setTodoList([]);
      return;
    }

    this.setTodoList(todos);
  }

  private hydrateBackgroundStateFromResume(agent: ResumedAgentState): void {
    const projection = replayBackgroundProjection(agent.background);
    this.state.backgroundAgents = new Set(projection.backgroundAgents);
    this.state.backgroundAgentMetadata = new Map(projection.backgroundAgentMetadata);
    this.state.backgroundTasks = new Map<string, BackgroundTaskInfo>(
      agent.background.map((info) => [info.taskId, info]),
    );
    this.state.backgroundTaskTranscriptedTerminal.clear();
    for (const info of agent.background) {
      if (isTerminalBackgroundTask(info)) {
        this.state.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
    }
    this.state.footer.setBackgroundCounts(countActiveBackgroundTasks(this.state.backgroundTasks));
    this.state.ui.requestRender();
  }

  private renderReplayRecords(agent: ResumedAgentState): void {
    const context = createReplayRenderContext();
    for (const record of limitReplayRecordsByTurn(agent.replay, REPLAY_TURN_LIMIT)) {
      this.renderReplayRecord(context, record);
    }
    this.flushReplayAssistant(context);
    this.cleanupReplayRuntime(context);
  }

  private renderReplayRecord(context: ReplayRenderContext, record: AgentReplayRecord): void {
    switch (record.type) {
      case 'message':
        this.renderReplayMessage(context, record.message);
        return;
      case 'plan_updated':
        this.flushReplayAssistant(context);
        if (!record.enabled && context.suppressNextPlanModeOffNotice) {
          context.suppressNextPlanModeOffNotice = false;
          return;
        }
        context.suppressNextPlanModeOffNotice = false;
        this.appendTranscriptEntry(
          replayEntry(context, 'status', `Plan mode: ${record.enabled ? 'ON' : 'OFF'}`, 'notice'),
        );
        return;
      case 'permission_updated':
        this.flushReplayAssistant(context);
        this.renderReplayPermissionUpdate(context, record.mode);
        return;
      case 'approval_result':
        this.flushReplayAssistant(context);
        this.renderReplayApprovalResult(context, record.record);
        return;
      case 'config_updated':
        return;
    }
  }

  private renderReplayMessage(context: ReplayRenderContext, message: ContextMessage): void {
    switch (message.role) {
      case 'user':
        this.renderReplayUserMessage(context, message);
        return;
      case 'assistant':
        if (message.origin?.kind === 'hook_result') {
          this.renderReplayHookResult(context, message);
          this.renderReplayToolCalls(context, message.toolCalls);
          return;
        }
        collectReplayMessageContent(context.assistant, message.content);
        this.flushReplayAssistant(context);
        this.renderReplayToolCalls(context, message.toolCalls);
        return;
      case 'tool':
        this.flushReplayAssistant(context);
        this.renderReplayToolResult(context, message);
        return;
      case 'system':
        return;
      default:
        return;
    }
  }

  private renderReplayUserMessage(context: ReplayRenderContext, message: ContextMessage): void {
    const origin = backgroundOrigin(message);
    if (origin !== undefined) {
      this.flushReplayAssistant(context);
      this.renderReplayBackgroundTaskNotification(context, origin);
      return;
    }
    if (message.origin?.kind === 'hook_result') {
      this.renderReplayHookResult(context, message);
      return;
    }
    if (message.origin?.kind === 'injection') {
      return;
    }

    this.flushReplayAssistant(context);
    const skill = skillActivationFromOrigin(message.origin);
    if (skill !== undefined) {
      this.renderReplaySkillActivation(context, skill);
      if (message.origin?.kind === 'skill_activation' && message.origin.trigger === 'user-slash') {
        this.advanceReplayTurn(context);
      }
      return;
    }

    this.advanceReplayTurn(context);
    this.appendTranscriptEntry(
      replayEntry(context, 'user', contentPartsToText(message.content), 'plain'),
    );
  }

  private renderReplayToolCalls(
    context: ReplayRenderContext,
    toolCalls: readonly ToolCall[],
  ): void {
    if (toolCalls.length === 0) return;
    context.stepIndex += 1;
    this.applyReplayStepContext(context);
    for (const rawToolCall of toolCalls) {
      const toolCall = toolCallFromReplayMessage(rawToolCall, context);
      if (toolCall === undefined) continue;
      context.toolCalls.set(toolCall.id, toolCall);
      this.state.activeToolCalls.set(toolCall.id, toolCall);
      this.onToolCallStart(toolCall);
    }
  }

  private renderReplayToolResult(context: ReplayRenderContext, message: ContextMessage): void {
    const toolCallId = message.toolCallId;
    if (toolCallId === undefined) return;
    const call = context.toolCalls.get(toolCallId);
    if (call === undefined) return;

    const result: ToolResultBlockData = {
      tool_call_id: toolCallId,
      output: toolResultOutput(message.content),
      is_error: message.isError,
    };
    call.result = result;
    this.applyReplayStepContext(context);
    this.onToolCallEnd(toolCallId, result);
    this.state.activeToolCalls.delete(toolCallId);
    context.completedToolCallIds.add(toolCallId);
  }

  private advanceReplayTurn(context: ReplayRenderContext): void {
    context.turnIndex += 1;
    context.stepIndex = 0;
    context.currentTurnId = `replay:${String(context.turnIndex)}`;
    this.applyReplayStepContext(context);
  }

  private applyReplayStepContext(context: ReplayRenderContext): void {
    this.state.currentTurnId = context.currentTurnId;
    this.state.currentStep = context.stepIndex;
  }

  private flushReplayAssistant(context: ReplayRenderContext): void {
    const thinking = context.assistant.thinking.join('');
    const text = context.assistant.text.join('');
    context.assistant = { thinking: [], text: [] };
    this.applyReplayStepContext(context);

    if (thinking.length > 0) {
      this.onThinkingUpdate(thinking);
      this.onThinkingEnd();
    }
    if (text.length > 0) {
      this.state.assistantStreamActive = true;
      this.onStreamingTextStart();
      this.onStreamingTextUpdate(text);
      this.onStreamingTextEnd();
      this.state.assistantStreamActive = false;
      this.state.assistantDraft = '';
    }
  }

  private cleanupReplayRuntime(context: ReplayRenderContext): void {
    this.flushReplayAssistant(context);
    this.state.activeToolCalls.clear();
    for (const toolCallId of context.completedToolCallIds) {
      this.state.pendingToolComponents.delete(toolCallId);
    }
    this.state.pendingAgentGroup = null;
    this.state.pendingReadGroup = null;
    this.state.currentTurnId = undefined;
    this.state.currentStep = 0;
    this.state.streamingToolCallArguments.clear();
    this.pendingToolCallFlushIds.clear();
    this.state.ui.requestRender();
  }

  private renderReplaySkillActivation(
    context: ReplayRenderContext,
    skill: SkillActivationProjection,
  ): void {
    if (context.skillActivationIds.has(skill.activationId)) return;
    if (this.state.renderedSkillActivationIds.has(skill.activationId)) return;
    context.skillActivationIds.add(skill.activationId);
    this.state.renderedSkillActivationIds.add(skill.activationId);
    this.appendTranscriptEntry({
      ...replayEntry(context, 'skill_activation', `Activated skill: ${skill.skillName}`, 'plain'),
      skillActivationId: skill.activationId,
      skillName: skill.skillName,
      skillArgs: skill.skillArgs,
    });
  }

  private renderReplayHookResult(context: ReplayRenderContext, message: ContextMessage): void {
    if (message.origin?.kind !== 'hook_result') return;
    this.flushReplayAssistant(context);
    this.appendTranscriptEntry(
      replayEntry(
        context,
        'assistant',
        formatHookResultMessageForTranscript(
          contentPartsToText(message.content),
          message.origin.event,
          message.origin.blocked === true,
        ),
        'markdown',
      ),
    );
  }

  private renderReplayPermissionUpdate(
    context: ReplayRenderContext,
    mode: PermissionMode,
  ): void {
    if (mode === 'yolo') {
      this.appendTranscriptEntry(
        replayEntry(context, 'status', 'YOLO mode: ON', 'notice', {
          detail: 'All actions will be approved automatically. Use with caution.',
        }),
      );
      return;
    }
    this.appendTranscriptEntry(
      replayEntry(
        context,
        'status',
        mode === 'manual' ? 'YOLO mode: OFF' : `Permission mode: ${mode}`,
        'notice',
      ),
    );
  }

  private renderReplayApprovalResult(
    context: ReplayRenderContext,
    record: Extract<AgentReplayRecord, { type: 'approval_result' }>['record'],
  ): void {
    if (record.toolName === 'ExitPlanMode') {
      this.renderReplayPlanReviewResult(context, record);
      return;
    }

    const { result } = record;
    const parts: string[] = [];
    switch (result.decision) {
      case 'approved':
        parts.push(result.scope === 'session' ? 'Approved for session' : 'Approved');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${record.action}`);
    if (result.feedback !== undefined && result.feedback.length > 0) {
      parts.push(` — "${result.feedback}"`);
    }
    this.appendTranscriptEntry(replayEntry(context, 'status', parts.join(''), 'notice'));
  }

  private renderReplayPlanReviewResult(
    context: ReplayRenderContext,
    record: Extract<AgentReplayRecord, { type: 'approval_result' }>['record'],
  ): void {
    const { result } = record;
    if (result.decision === 'approved') {
      context.suppressNextPlanModeOffNotice = true;
      return;
    }
    this.removeReplayToolCall(record.toolCallId);

    let content: string;
    switch (result.decision) {
      case 'rejected':
        content =
          result.selectedLabel === 'Revise' ? 'Plan sent back for revision' : 'Plan review rejected';
        break;
      case 'cancelled':
        content = 'Plan review cancelled';
        break;
    }
    const detail =
      result.feedback !== undefined && result.feedback.length > 0
        ? `Feedback: ${result.feedback}`
        : undefined;
    this.appendTranscriptEntry(replayEntry(context, 'status', content, 'notice', { detail }));
  }

  private removeReplayToolCall(toolCallId: string): void {
    this.state.activeToolCalls.delete(toolCallId);
    this.state.pendingToolComponents.delete(toolCallId);
    const index = this.state.transcriptEntries.findIndex(
      (entry) => entry.toolCallData?.id === toolCallId,
    );
    if (index >= 0) this.state.transcriptEntries.splice(index, 1);
    const children = this.state.transcriptContainer.children;
    const childIndex = children.findIndex(
      (child) => child instanceof ToolCallComponent && child.toolCallView.id === toolCallId,
    );
    if (childIndex >= 0) {
      children.splice(childIndex, 1);
      this.state.transcriptContainer.invalidate();
    }
  }

  private renderReplayBackgroundTaskNotification(
    context: ReplayRenderContext,
    origin: Extract<PromptOrigin, { kind: 'background_task' }>,
  ): void {
    const task = this.state.backgroundTasks.get(origin.taskId);
    if (task !== undefined && task.taskId.startsWith('bash-')) {
      const status = formatBackgroundTaskTranscript({ ...task, status: origin.status });
      this.appendTranscriptEntry({
        ...replayEntry(context, 'status', status.headline, 'plain'),
        detail: status.detail,
        backgroundAgentStatus: status,
      });
      this.state.backgroundTaskTranscriptedTerminal.add(origin.taskId);
      return;
    }

    const meta: BackgroundAgentMetadata = {
      agentId: origin.taskId,
      parentToolCallId: origin.taskId,
      description: task?.description,
    };
    let status = formatBackgroundAgentTranscript(
      origin.status === 'completed' ? 'completed' : 'failed',
      meta,
    );
    if (origin.status === 'lost') {
      status = {
        ...status,
        headline: status.headline.replace(' failed in background', ' lost in background'),
      };
    } else if (origin.status === 'killed') {
      status = {
        ...status,
        headline: status.headline.replace(' failed in background', ' stopped'),
      };
    }
    this.appendTranscriptEntry({
      ...replayEntry(context, 'status', status.headline, 'plain'),
      detail: status.detail,
      backgroundAgentStatus: status,
    });
    this.state.backgroundAgents.delete(meta.agentId);
    this.state.backgroundAgentMetadata.delete(meta.agentId);
  }

  // =========================================================================
  // Session Events
  // =========================================================================

  private startSessionEventSubscription(): void {
    const session = this.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      this.sendQueuedMessage(session, item);
    };
    this.sessionEventUnsubscribe?.();
    const mcpOAuthOpener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const { sessionId } = this.state.appState;
    this.sessionEventUnsubscribe = session.onEvent((event) => {
      if (this.aborted) return;
      if (event.sessionId !== sessionId) return;
      if (event.type === 'tool.progress') {
        mcpOAuthOpener.handleToolProgress(event);
      }
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  private async syncMcpServerStatusSnapshot(session: Session): Promise<void> {
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (this.session !== session || this.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.showError(`Failed to sync MCP server status: ${message}`);
      return;
    }
    if (this.session !== session || this.state.appState.sessionId !== session.id) return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.state.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }

    const hidden: McpServerStatusSnapshot[] = [];
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.state.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.state.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
      hidden.push(server);
    }
    if (hidden.length > 0) {
      this.showStatus(
        formatMcpStartupStatusSummary(hidden, visible.length),
        this.state.theme.colors.textMuted,
      );
    }
  }

  // Routes an SDK event to the matching TUI state transition.
  private handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    if (this.routeSubagentEvent(event)) {
      return;
    }

    if ('turnId' in event && event.turnId !== undefined) {
      this.state.currentTurnId = String(event.turnId);
    }

    switch (event.type) {
      case 'turn.started':
        this.handleTurnBegin(event);
        break;
      case 'turn.ended':
        this.handleTurnEnd(event, sendQueued);
        break;
      case 'turn.step.started':
        this.handleStepBegin(event);
        break;
      case 'turn.step.interrupted':
        this.handleStepInterrupted(event);
        break;
      case 'turn.step.completed':
        this.handleStepCompleted(event);
        break;
      case 'turn.step.retrying':
        break;
      case 'tool.progress':
        this.handleToolProgress(event);
        break;
      case 'assistant.delta':
        this.handleAssistantDelta(event);
        break;
      case 'hook.result':
        this.handleHookResult(event);
        break;
      case 'thinking.delta':
        this.handleThinkingDelta(event);
        break;
      case 'tool.call.started':
        this.handleToolCall(event);
        break;
      case 'tool.call.delta':
        this.handleToolCallDelta(event);
        break;
      case 'tool.result':
        this.handleToolResult(event);
        break;
      case 'agent.status.updated':
        this.handleStatusUpdate(event);
        break;
      case 'session.meta.updated':
        this.handleSessionMetaChanged(event);
        break;
      case 'skill.activated':
        this.handleSkillActivated(event);
        break;
      case 'error':
        this.handleSessionError(event);
        break;
      case 'warning':
        this.handleSessionWarning(event);
        break;
      case 'compaction.started':
        this.handleCompactionBegin(event);
        break;
      case 'compaction.completed':
        this.handleCompactionEnd(event, sendQueued);
        break;
      case 'compaction.blocked':
        break;
      case 'compaction.cancelled':
        this.handleCompactionCancel(event, sendQueued);
        break;
      case 'subagent.spawned':
        this.handleSubagentSpawned(event);
        break;
      case 'subagent.completed':
        this.handleSubagentCompleted(event);
        break;
      case 'subagent.failed':
        this.handleSubagentFailed(event);
        break;
      case 'background.task.started':
      case 'background.task.updated':
      case 'background.task.terminated':
        this.handleBackgroundTaskEvent(event);
        break;
      case 'mcp.server.status':
        this.renderMcpServerStatus(event.server);
        break;
      case 'tool.list.updated':
        break;
      default:
        break;
    }
  }

  // Routes child-agent events into their parent tool-call component.
  private routeSubagentEvent(event: Event): boolean {
    const subagentId = event.agentId;
    if (subagentId === MAIN_AGENT_ID) return false;

    const parentToolCallId = this.state.subagentParentToolCallIds.get(subagentId);
    if (parentToolCallId === undefined || parentToolCallId.length === 0) return true;
    const sourceName = this.state.subagentNames.get(subagentId);
    const toolCall = this.state.pendingToolComponents.get(parentToolCallId);
    if (toolCall === undefined) return true;
    toolCall.setSubagentMeta(subagentId, sourceName);

    switch (event.type) {
      case 'hook.result':
        toolCall.appendSubagentText(formatHookResultPlain(event), 'text');
        return true;
      case 'assistant.delta':
        toolCall.appendSubagentText(event.delta, 'text');
        return true;
      case 'thinking.delta':
        toolCall.appendSubagentText(event.delta, 'thinking');
        return true;
      case 'tool.call.started':
        toolCall.appendSubToolCall({
          id: `${subagentId}:${event.toolCallId}`,
          name: event.name,
          args: argsRecord(event.args),
        });
        return true;
      case 'tool.call.delta':
        toolCall.appendSubToolCallDelta({
          id: `${subagentId}:${event.toolCallId}`,
          name: event.name,
          argumentsPart: event.argumentsPart ?? null,
        });
        return true;
      case 'tool.result':
        toolCall.finishSubToolCall({
          tool_call_id: `${subagentId}:${event.toolCallId}`,
          output: serializeToolResultOutput(event.output),
          is_error: event.isError,
        });
        return true;
      case 'agent.status.updated': {
        const usageObj = event.usage;
        const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
        toolCall.updateSubagentMetrics({
          contextTokens: event.contextTokens,
          usage: totalUsage,
        });
        return true;
      }
      case 'background.task.started':
      case 'background.task.updated':
      case 'background.task.terminated':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
      case 'compaction.started':
      case 'error':
      case 'session.meta.updated':
      case 'skill.activated':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.spawned':
      case 'tool.progress':
      case 'tool.list.updated':
      case 'mcp.server.status':
      case 'turn.ended':
      case 'turn.started':
      case 'turn.step.completed':
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
      case 'turn.step.started':
        return true;
      default:
        return true;
    }
  }

  // Initializes turn-scoped buffers when the SDK starts a turn.
  private handleTurnBegin(_event: TurnStartedEvent): void {
    void _event;
    this.resetLiveToolUiState();
    this.state.currentStep = 0;
    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      isStreaming: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  // Finalizes turn-scoped state when the SDK completes a turn.
  private handleTurnEnd(_event: TurnEndedEvent, sendQueued: (item: QueuedMessage) => void): void {
    void _event;
    this.flushStreamingUiUpdatesNow();
    const todos = this.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.setTodoList([]);
    }
    this.resetLiveToolUiState();
    this.finalizeTurn(sendQueued);
  }

  // Resets live render state for a new turn step.
  private handleStepBegin(event: TurnStepStartedEvent): void {
    this.flushStreamingUiUpdatesNow();
    this.state.currentStep = event.step;
    this.resetLiveToolUiState();
    this.finalizeLiveTextBuffers('waiting');
    this.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  // Surfaces step-level outcomes the user needs to act on. The common
  // case (finishReason === 'tool_use' or 'end_turn') is silent — those
  // already render via tool.call.started/tool.result and assistant.delta.
  // The interesting case is max_tokens: the model started a tool_use but
  // ran out of budget before finalizing it, so the partial tool call is
  // still pinned in 'Preparing' state with no signal that anything went
  // wrong. Flip those into a visible 'Truncated' state and append a
  // notice pointing at the config knob.
  private handleStepCompleted(event: TurnStepCompletedEvent): void {
    this.flushStreamingUiUpdatesNow();
    this.maybeShowDebugTiming(event);
    if (event.finishReason !== 'max_tokens') return;

    // Scope the truncation marking to tool calls that belong to the
    // step that just completed. Without this guard, stale entries from
    // earlier retry attempts (or unrelated still-tracked calls) would
    // get relabeled and counted, producing misleading "tool call was
    // truncated" notices for the wrong step.
    const eventTurnId = String(event.turnId);
    let truncatedCount = 0;
    for (const toolCall of this.state.activeToolCalls.values()) {
      if (toolCall.result !== undefined) continue;
      if (toolCall.streamingArguments === undefined) continue;
      if (toolCall.turnId !== eventTurnId) continue;
      if (toolCall.step !== event.step) continue;
      toolCall.truncated = true;
      const component = this.state.pendingToolComponents.get(toolCall.id);
      if (component !== undefined) {
        component.updateToolCall(toolCall);
      }
      truncatedCount += 1;
    }
    this.state.streamingToolCallArguments.clear();

    const title =
      truncatedCount > 0
        ? 'Model hit max_tokens — tool call was truncated before it could run.'
        : 'Model hit max_tokens — no tool call was emitted.';
    // The `max_output_size` knob is only wired through to provider
    // requests for the Anthropic provider (see toKosongProviderConfig).
    // For OpenAI / Kimi / Google sessions the advice would be a
    // dead end, so skip the second line on those providers.
    const detail = this.isAnthropicSessionActive()
      ? 'If this limit is wrong for your model, set `max_output_size` on the model alias in your kimi-code config.'
      : undefined;
    this.showNotice(title, detail);
  }

  private maybeShowDebugTiming(event: TurnStepCompletedEvent): void {
    if (process.env['KIMI_CODE_DEBUG'] !== '1') return;
    const text = formatStepDebugTiming(event);
    if (text !== undefined) this.showStatus(text);
  }

  private isAnthropicSessionActive(): boolean {
    const providerKey = this.state.appState.availableModels[this.state.appState.model]?.provider;
    if (providerKey === undefined) return false;
    return this.state.appState.availableProviders[providerKey]?.type === 'anthropic';
  }

  // Renders user-facing status for an interrupted turn step.
  private handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.flushStreamingUiUpdatesNow();
    this.resetLiveToolUiState();
    this.finalizeLiveTextBuffers('idle');
    const reason = event.reason;
    if (reason === 'error') return;
    if (reason === 'aborted' || reason === undefined || reason === '') {
      this.showStatus('Interrupted by user', this.state.theme.colors.error);
      return;
    }
    this.showError(
      reason === 'max_steps'
        ? 'reached per-turn step limit (max_steps)'
        : `step interrupted (${reason})`,
    );
  }

  // Appends a thinking delta to the live thinking block.
  private handleThinkingDelta(event: ThinkingDeltaEvent): void {
    this.state.thinkingDraft += event.delta;
    this.pendingThinkingFlush = true;
    this.patchLivePane({ mode: 'idle' });
    if (this.state.appState.streamingPhase !== 'thinking') {
      this.setAppState({ streamingPhase: 'thinking', streamingStartTime: Date.now() });
    }
    this.scheduleStreamingUiFlush();
  }

  // Appends an assistant text delta to the live assistant block.
  private handleAssistantDelta(event: AssistantDeltaEvent): void {
    if (this.state.thinkingDraft.length > 0) {
      this.flushThinkingToTranscript('idle');
    }

    if (!this.state.assistantStreamActive) {
      this.state.assistantStreamActive = true;
      this.onStreamingTextStart();
    }

    this.state.assistantDraft += event.delta;
    this.pendingAssistantFlush = true;

    this.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (this.state.appState.streamingPhase !== 'composing') {
      this.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    this.scheduleStreamingUiFlush();
  }

  private handleHookResult(event: HookResultEvent): void {
    this.flushStreamingUiUpdatesNow();
    if (this.state.thinkingDraft.length > 0) {
      this.flushThinkingToTranscript('idle');
    }
    this.finalizeAssistantStream();
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: String(event.turnId),
      renderMode: 'markdown',
      content: formatHookResultMarkdown(event),
    });
    this.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  // Starts or updates a rendered tool call from a tool-call start event.
  private handleToolCall(event: ToolCallStartedEvent): void {
    this.flushStreamingUiUpdatesNow();
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.name,
      args: argsRecord(event.args),
      description: event.description,
      display: event.display,
      step: this.state.currentStep,
      turnId: this.state.currentTurnId,
    };
    const existing = this.state.activeToolCalls.get(event.toolCallId);
    this.state.activeToolCalls.set(event.toolCallId, toolCall);
    this.pendingToolCallFlushIds.delete(event.toolCallId);
    this.state.streamingToolCallArguments.delete(event.toolCallId);
    const existingComponent = this.state.pendingToolComponents.get(event.toolCallId);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (existing === undefined) {
      this.finalizeLiveTextBuffers('tool');
      if (event.name !== 'Agent') {
        this.onToolCallStart(toolCall);
      }
    }
    this.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  // Accumulates streaming tool-call arguments and updates the rendered call.
  private handleToolCallDelta(event: ToolCallDeltaEvent): void {
    if (event.toolCallId.length === 0) return;
    const id = event.toolCallId;
    const existing = this.state.streamingToolCallArguments.get(id);
    const argumentsText = appendStreamingArgsPreview(
      existing?.argumentsText,
      event.argumentsPart,
    );
    const name = event.name ?? existing?.name ?? this.state.activeToolCalls.get(id)?.name ?? 'Tool';
    const startedAtMs = existing?.startedAtMs ?? Date.now();
    this.state.streamingToolCallArguments.set(id, { name, argumentsText, startedAtMs });
    this.pendingToolCallFlushIds.add(id);

    this.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (this.state.appState.streamingPhase !== 'composing') {
      this.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    this.scheduleStreamingUiFlush();
  }

  // Streams a `{kind:'status'}` progress text into the live tool box so
  // long-blocking tools (e.g. the MCP synthetic `authenticate` tool whose
  // 15-minute browser wait would otherwise show only a spinner) can surface
  // their authorization URL. Non-status update kinds stay out of the terminal
  // transcript because only status text needs persistent display.
  private handleToolProgress(event: ToolProgressEvent): void {
    if (event.update.kind !== 'status') return;
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const tc = this.state.pendingToolComponents.get(event.toolCallId);
    if (tc === undefined) return;
    tc.appendProgress(text);
  }

  // Completes a tool call and applies any tool-specific UI side effects.
  private handleToolResult(event: ToolResultEvent): void {
    this.flushStreamingUiUpdatesNow();
    const matchedCall = this.state.activeToolCalls.get(event.toolCallId);
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output: serializeToolResultOutput(event.output),
      is_error: event.isError,
      synthetic: event.synthetic,
    };
    if (matchedCall !== undefined) {
      this.onToolCallEnd(event.toolCallId, resultData);
      if (matchedCall.name === 'TodoList' && !event.isError) {
        const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
        if (Array.isArray(rawTodos)) {
          const sanitized = rawTodos
            .filter((todo): todo is { title: string; status: 'pending' | 'in_progress' | 'done' } =>
              isTodoItemShape(todo),
            )
            .map((t) => ({ title: t.title, status: t.status }));
          this.setTodoList(sanitized);
        }
      }
    }
    this.state.activeToolCalls.delete(event.toolCallId);
    this.state.streamingToolCallArguments.delete(event.toolCallId);
    this.patchLivePane({ mode: 'waiting' });
  }

  // Applies agent status updates to app state.
  private handleStatusUpdate(event: AgentStatusUpdatedEvent): void {
    const patch: Partial<AppState> = {};
    if (event.contextUsage !== undefined) patch.contextUsage = event.contextUsage;
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.permission !== undefined) {
      patch.permissionMode = event.permission;
      patch.yolo = event.permission === 'yolo';
    }
    if (event.model !== undefined) patch.model = event.model;
    if (Object.keys(patch).length > 0) this.setAppState(patch);
  }

  // Applies session metadata changes to the UI and process title.
  private handleSessionMetaChanged(event: SessionMetaUpdatedEvent): void {
    const title = event.title ?? stringValue(event.patch?.['title']);
    if (title !== undefined) {
      this.setAppState({ sessionTitle: title });
      setProcessTitle(title, this.state.appState.sessionId);
    }
  }

  // Finalizes live buffers and renders a session error.
  private handleSessionError(event: ErrorEvent): void {
    this.flushStreamingUiUpdatesNow();
    this.resetLiveToolUiState();
    this.finalizeLiveTextBuffers('idle');
    if (event.code === OAUTH_LOGIN_REQUIRED_CODE) {
      this.showError(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
      return;
    }
    this.showError(`[${event.code}] ${event.message}`);
    const sessionId = this.state.appState.sessionId;
    if (sessionId.length > 0) {
      this.showStatus(errorReportHintLine(sessionId));
    }
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.showStatus(`Warning: ${event.message}`, this.state.theme.colors.warning);
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.state.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.state.renderedMcpServerStatusKeys.set(server.name, key);

    const colors = this.state.theme.colors;
    switch (server.status) {
      case 'connected': {
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.success);
        return;
      }
      case 'failed': {
        const message = `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ''}`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.error);
        return;
      }
      case 'needs-auth': {
        const message = `MCP server "${server.name}" needs OAuth — run /mcp-config login ${server.name}`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.warning);
        return;
      }
      case 'disabled':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" disabled`,
          colors.textMuted,
        );
        return;
      case 'pending':
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const label = `MCP server "${name}" connecting…`;
    const existing = this.state.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => chalk.hex(this.state.theme.colors.textMuted)(s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(spinner);
    this.state.mcpServerStatusSpinners.set(name, spinner);
    this.state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(name: string, message: string, color: string): void {
    const spinner = this.state.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, this.state.theme.colors, color);
    const children = this.state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      children[idx] = status;
      this.state.transcriptContainer.invalidate();
    } else {
      this.state.transcriptContainer.addChild(status);
    }
    this.state.mcpServerStatusSpinners.delete(name);
    this.state.ui.requestRender();
  }

  private stopAllMcpServerStatusSpinners(): void {
    for (const spinner of this.state.mcpServerStatusSpinners.values()) {
      spinner.stop();
    }
    this.state.mcpServerStatusSpinners.clear();
  }

  // Adds a skill activation entry to the transcript once.
  private handleSkillActivated(event: SkillActivatedEvent): void {
    if (this.state.renderedSkillActivationIds.has(event.activationId)) return;
    this.state.renderedSkillActivationIds.add(event.activationId);
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: `Activated skill: ${event.skillName}`,
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
    });
  }

  // Starts the compaction UI block and marks the app as compacting.
  private handleCompactionBegin(event: CompactionStartedEvent): void {
    this.finalizeLiveTextBuffers('waiting');
    this.setAppState({
      isCompacting: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
    this.beginCompaction(event.instruction);
  }

  // Finishes compaction and resumes queued work when possible.
  private handleCompactionEnd(
    event: CompactionCompletedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.endCompaction(event.result.tokensBefore, event.result.tokensAfter);
    this.finishCompaction(sendQueued);
  }

  private handleCompactionCancel(
    _event: CompactionCancelledEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.cancelCompactionBlock();
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    if (!this.state.appState.isStreaming) {
      this.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.resetLivePane();
      if (this.state.queuedMessages.length > 0) {
        const [next, ...rest] = this.state.queuedMessages;
        this.state.queuedMessages = rest;
        if (next !== undefined) {
          setTimeout(() => {
            sendQueued(next);
          }, 0);
        }
      }
    } else {
      this.setAppState({ isCompacting: false });
    }
  }

  // Registers a spawned subagent and renders foreground or background status.
  private handleSubagentSpawned(event: SubagentSpawnedEvent): void {
    this.state.subagentParentToolCallIds.set(event.subagentId, event.parentToolCallId);
    this.state.subagentNames.set(event.subagentId, event.subagentName);

    if (event.runInBackground) {
      const meta = this.buildBackgroundAgentMetadata(event);
      this.state.backgroundAgentMetadata.set(event.subagentId, meta);
      this.state.backgroundAgents.add(event.subagentId);
      this.appendBackgroundAgentEntry('started', meta);
      this.syncBackgroundAgentBadge();
      return;
    }

    let tc = this.state.pendingToolComponents.get(event.parentToolCallId);
    if (tc === undefined) {
      const toolCall = this.state.activeToolCalls.get(event.parentToolCallId);
      if (toolCall !== undefined) {
        this.onToolCallStart(toolCall);
        tc = this.state.pendingToolComponents.get(event.parentToolCallId);
      }
    }
    tc ??= this.createStandaloneSubagentToolCall(event);
    if (tc === undefined) return;
    tc.onSubagentSpawned({
      agentId: event.subagentId,
      agentName: event.subagentName,
      runInBackground: event.runInBackground,
    });
  }

  // Completes a subagent in its parent tool call or background transcript entry.
  private handleSubagentCompleted(event: SubagentCompletedEvent): void {
    const backgroundMeta = this.state.backgroundAgentMetadata.get(event.subagentId);
    if (this.state.backgroundAgents.delete(event.subagentId)) {
      this.syncBackgroundAgentBadge();
    }
    if (backgroundMeta !== undefined) {
      this.state.backgroundAgentMetadata.delete(event.subagentId);
      // Dedupe: if the BPM `background.task.terminated` for the
      // matching agent task already pushed a terminal card, skip.
      // Otherwise mark the subagent id so a later BPM event skips.
      const taskId = this.findAgentTaskId(event.subagentId);
      if (taskId !== undefined && this.state.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.state.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      const extras =
        event.resultSummary === undefined ? undefined : { resultSummary: event.resultSummary };
      this.appendBackgroundAgentEntry('completed', backgroundMeta, extras);
      return;
    }
    const tc = this.state.pendingToolComponents.get(event.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentCompleted({
      contextTokens: event.contextTokens,
      usage: event.usage,
      resultSummary: event.resultSummary,
    });
    if (!this.state.activeToolCalls.has(event.parentToolCallId)) {
      this.state.pendingToolComponents.delete(event.parentToolCallId);
    }
  }

  // Marks a subagent failure in its parent tool call or background transcript entry.
  private handleSubagentFailed(event: SubagentFailedEvent): void {
    const backgroundMeta = this.state.backgroundAgentMetadata.get(event.subagentId);
    if (this.state.backgroundAgents.delete(event.subagentId)) {
      this.syncBackgroundAgentBadge();
    }
    if (backgroundMeta !== undefined) {
      this.state.backgroundAgentMetadata.delete(event.subagentId);
      const taskId = this.findAgentTaskId(event.subagentId);
      if (taskId !== undefined && this.state.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.state.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      this.appendBackgroundAgentEntry('failed', backgroundMeta, { error: event.error });
      return;
    }
    const tc = this.state.pendingToolComponents.get(event.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentFailed({ error: event.error });
    if (!this.state.activeToolCalls.has(event.parentToolCallId)) {
      this.state.pendingToolComponents.delete(event.parentToolCallId);
    }
  }

  // Mounts subagents launched by session-level commands that do not originate
  // from a model-issued Agent tool call.
  private createStandaloneSubagentToolCall(event: SubagentSpawnedEvent): ToolCallComponent | undefined {
    const description = event.description ?? `Run ${event.subagentName} agent`;
    const toolCall: ToolCallBlockData = {
      id: event.parentToolCallId,
      name: 'Agent',
      args: {
        description,
        subagent_type: event.subagentName,
      },
      description,
      step: this.state.currentStep,
      turnId: this.state.currentTurnId,
    };
    this.onToolCallStart(toolCall);
    return this.state.pendingToolComponents.get(event.parentToolCallId);
  }

  /**
   * Locate the BPM `agent-*` task id whose `description` matches the
   * spawned subagent's recorded description. Used only for dedupe
   * between the BPM and subagent flows — best-effort: if there is no
   * unique match (e.g. multiple agent tasks with the same description)
   * the caller treats the dedupe as a miss, which is safe.
   */
  private findAgentTaskId(subagentId: string): string | undefined {
    const meta = this.state.backgroundAgentMetadata.get(subagentId);
    const description = meta?.description ?? meta?.agentName;
    if (description === undefined) return undefined;
    let match: string | undefined;
    for (const info of this.state.backgroundTasks.values()) {
      if (!info.taskId.startsWith('agent-')) continue;
      if (info.description !== description) continue;
      if (match !== undefined) return undefined; // ambiguous
      match = info.taskId;
    }
    return match;
  }

  // Builds transcript metadata for a background subagent.
  private buildBackgroundAgentMetadata(event: SubagentSpawnedEvent): BackgroundAgentMetadata {
    const parent = this.state.activeToolCalls.get(event.parentToolCallId);
    const description = parent?.args['description'] ?? event.description;
    return {
      agentId: event.subagentId,
      parentToolCallId: event.parentToolCallId,
      agentName: event.subagentName,
      description: typeof description === 'string' ? description : undefined,
    };
  }

  // Appends a background-agent status row to the transcript.
  private appendBackgroundAgentEntry(
    phase: 'started' | 'completed' | 'failed',
    meta: BackgroundAgentMetadata,
    extras: { resultSummary?: string; error?: string } | undefined = undefined,
  ): void {
    const status = formatBackgroundAgentTranscript(phase, meta, extras);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.state.currentTurnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.appendTranscriptEntry(entry);
  }

  // Updates the footer badge for active background agents.
  private syncBackgroundAgentBadge(): void {
    this.syncBackgroundTaskBadge();
  }

  // =========================================================================
  // Background task lifecycle (BPM-derived, covers both bash + agent tasks)
  // =========================================================================

  private handleBackgroundTaskEvent(
    event: BackgroundTaskStartedEvent | BackgroundTaskUpdatedEvent | BackgroundTaskTerminatedEvent,
  ): void {
    const { info } = event;
    const previous = this.state.backgroundTasks.get(info.taskId);
    this.state.backgroundTasks.set(info.taskId, info);

    // If the user is currently viewing this task's output, nudge a
    // refresh immediately so they see new content without waiting for
    // the 1s poll. Same dedupe-by-output-equality applies inside.
    const viewer = this.state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.refreshTaskOutputViewer({ silent: true });
    }

    const isTerminal =
      info.status === 'completed' ||
      info.status === 'failed' ||
      info.status === 'killed' ||
      info.status === 'lost';

    if (event.type === 'background.task.started') {
      // For agent-* tasks, the legacy subagent.spawned flow already
      // pushed a 'started' transcript card; skip to avoid duplicates.
      if (info.taskId.startsWith('agent-')) {
        this.syncBackgroundTaskBadge();
        this.repaintTasksBrowser();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.repaintTasksBrowser();
      return;
    }

    if (event.type === 'background.task.terminated' && isTerminal) {
      if (!this.state.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        // For agent-* tasks, the older subagent.completed/failed flow
        // may also produce a terminal card; whoever wins records the
        // dedupe marker first. See handleSubagentCompleted/Failed.
        if (info.taskId.startsWith('bash-')) {
          this.appendBackgroundTaskEntry(info);
        }
        this.state.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.repaintTasksBrowser();
      return;
    }

    // updated: status flipped between running and awaiting_approval.
    // No transcript card — just sync the badge if the active count
    // changed (awaiting_approval still counts as active).
    if (previous?.status !== info.status) {
      this.syncBackgroundTaskBadge();
    }
    this.repaintTasksBrowser();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.state.currentTurnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.appendTranscriptEntry(entry);
  }

  // Footer counts are BPM-derived: every task that is not terminal,
  // split by id prefix so bash and agent badges render independently.
  // awaiting_approval still counts as active; lost/killed/completed/
  // failed do not.
  private syncBackgroundTaskBadge(): void {
    let bashTasks = 0;
    let agentTasks = 0;
    for (const info of this.state.backgroundTasks.values()) {
      if (
        info.status === 'completed' ||
        info.status === 'failed' ||
        info.status === 'killed' ||
        info.status === 'lost'
      ) {
        continue;
      }
      if (info.taskId.startsWith('agent-')) {
        agentTasks += 1;
      } else {
        bashTasks += 1;
      }
    }
    this.state.footer.setBackgroundCounts({ bashTasks, agentTasks });
    this.state.ui.requestRender();
  }

  // =========================================================================
  // Live Render Hooks
  // =========================================================================

  // Creates the live assistant transcript component.
  private onStreamingTextStart(): void {
    this.state.pendingAgentGroup = null;
    this.state.pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: this.state.currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
    };
    this.state.streamingComponent = new AssistantMessageComponent(
      this.state.theme.markdownTheme,
      this.state.theme.colors,
    );
    this.state.streamingTranscriptEntry = entry;
    this.state.transcriptEntries.push(entry);
    this.state.transcriptContainer.addChild(this.state.streamingComponent);
    this.state.ui.requestRender();
  }

  // Updates the live assistant transcript component.
  private onStreamingTextUpdate(fullText: string): void {
    if (this.state.streamingTranscriptEntry !== undefined) {
      this.state.streamingTranscriptEntry.content = fullText;
    }
    if (this.state.streamingComponent) {
      this.state.streamingComponent.updateContent(fullText);
      this.state.ui.requestRender();
    }
  }

  // Clears live assistant component references after streaming ends.
  private onStreamingTextEnd(): void {
    this.state.streamingComponent = undefined;
    this.state.streamingTranscriptEntry = undefined;
  }

  // Creates or updates the live thinking transcript component.
  private onThinkingUpdate(fullText: string): void {
    // Avoid creating a component whose spinner will never stop when the text
    // is empty and there is no existing component to update.
    if (fullText.length === 0 && this.state.activeThinkingComponent === undefined) return;
    if (this.state.activeThinkingComponent === undefined) {
      this.state.pendingAgentGroup = null;
      this.state.pendingReadGroup = null;
      this.state.activeThinkingComponent = new ThinkingComponent(
        fullText,
        this.state.theme.colors,
        true,
        'live',
        this.state.ui,
      );
      if (this.state.toolOutputExpanded) this.state.activeThinkingComponent.setExpanded(true);
      this.state.transcriptContainer.addChild(this.state.activeThinkingComponent);
    } else {
      this.state.activeThinkingComponent.setText(fullText);
    }
    this.state.ui.requestRender();
  }

  // Finalizes the live thinking transcript component.
  private onThinkingEnd(): void {
    if (this.state.activeThinkingComponent === undefined) return;
    this.state.activeThinkingComponent.finalize();
    this.state.activeThinkingComponent = undefined;
    this.state.ui.requestRender();
  }

  // Creates and mounts a live tool-call component.
  private onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      this.state.theme.colors,
      this.state.ui,
      this.state.theme.markdownTheme,
      this.state.appState.workDir,
    );
    if (this.state.toolOutputExpanded) tc.setExpanded(true);
    if (this.state.planExpanded) tc.setPlanExpanded(true);
    this.state.pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Agent') this.state.pendingAgentGroup = null;
    if (toolCall.name !== 'Read') this.state.pendingReadGroup = null;

    let handled = this.tryAttachAgentToolCall(toolCall, tc);
    if (!handled) handled = this.tryAttachReadToolCall(toolCall, tc);
    if (!handled) {
      this.state.transcriptContainer.addChild(tc);
      this.state.ui.requestRender();
    }

    if (toolCall.name === 'ExitPlanMode' && typeof toolCall.args['plan'] !== 'string') {
      const session = this.requireSession();
      void (async () => {
        try {
          const plan = await session.getPlan();
          tc.setPlanInfo(plan === null ? {} : { plan: plan.content, path: plan.path });
        } catch {
          tc.setPlanInfo({});
        }
      })();
    }
  }

  // Applies a tool result to a live or completed tool-call component.
  private onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const matchedCall = this.state.activeToolCalls.get(toolCallId);
    const tc = this.state.pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this.state.pendingToolComponents.delete(toolCallId);
      this.state.ui.requestRender();
      return;
    }

    if (matchedCall?.name === 'AskUserQuestion') {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        this.state.theme.colors,
        this.state.ui,
        this.state.theme.markdownTheme,
        this.state.appState.workDir,
      );
      if (this.state.toolOutputExpanded) completed.setExpanded(true);
      if (this.state.planExpanded) completed.setPlanExpanded(true);
      this.state.transcriptContainer.addChild(completed);
      this.state.ui.requestRender();
    }
  }

  // Replaces the visible todo list panel.
  private setTodoList(todos: readonly TodoItem[]): void {
    this.state.todoPanel.setTodos(todos);
    this.state.todoPanelContainer.clear();
    if (!this.state.todoPanel.isEmpty()) {
      this.state.todoPanelContainer.addChild(this.state.todoPanel);
    }
    this.state.ui.requestRender();
  }

  // Renders a compaction block in the transcript.
  private beginCompaction(instruction?: string): void {
    if (this.state.activeCompactionBlock !== undefined) {
      this.state.activeCompactionBlock.markDone();
      this.state.activeCompactionBlock = undefined;
    }
    const block = new CompactionComponent(this.state.theme.colors, this.state.ui, instruction);
    this.state.activeCompactionBlock = block;
    this.state.transcriptContainer.addChild(block);
    this.state.ui.requestRender();
  }

  // Marks the active compaction block complete.
  private endCompaction(tokensBefore?: number, tokensAfter?: number): void {
    const block = this.state.activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter);
    this.state.activeCompactionBlock = undefined;
    this.state.ui.requestRender();
  }

  private cancelCompactionBlock(): void {
    const block = this.state.activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this.state.activeCompactionBlock = undefined;
    this.state.ui.requestRender();
  }

  // Groups Agent tool calls that belong to the same turn step.
  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    if (toolCall.name !== 'Agent') {
      this.state.pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? this.state.currentStep;
    const turnId = toolCall.turnId ?? this.state.currentTurnId;
    const pending = this.state.pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this.state.pendingAgentGroup = null;
    }

    const cur = this.state.pendingAgentGroup;
    if (cur === null) {
      this.state.pendingAgentGroup = { step, turnId, solo: tc };
      this.state.transcriptContainer.addChild(tc);
      this.state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this.state.pendingAgentGroup = { step, turnId, solo: tc };
      this.state.transcriptContainer.addChild(tc);
      this.state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    this.state.pendingAgentGroup = { step, turnId, group };
    this.state.ui.requestRender();
    return true;
  }

  // Replaces a single Agent tool call with an Agent group component.
  private upgradeSoloAgentToGroup(solo: ToolCallComponent): AgentGroupComponent {
    const group = new AgentGroupComponent(this.state.theme.colors, this.state.ui);
    const children = this.state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
      this.state.transcriptContainer.invalidate();
    } else {
      this.state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }

  // Groups Read tool calls that belong to the same turn step.
  private tryAttachReadToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    if (toolCall.name !== 'Read') {
      this.state.pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this.state.currentStep;
    const turnId = toolCall.turnId ?? this.state.currentTurnId;
    const pending = this.state.pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this.state.pendingReadGroup = null;
    }

    const cur = this.state.pendingReadGroup;
    if (cur === null) {
      this.state.pendingReadGroup = { step, turnId, solo: tc };
      this.state.transcriptContainer.addChild(tc);
      this.state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this.state.pendingReadGroup = { step, turnId, solo: tc };
      this.state.transcriptContainer.addChild(tc);
      this.state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this.state.pendingReadGroup = { step, turnId, group };
    this.state.ui.requestRender();
    return true;
  }

  // Replaces a single Read tool call with a Read group component.
  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const group = new ReadGroupComponent(this.state.theme.colors, this.state.ui);
    const children = this.state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
      this.state.transcriptContainer.invalidate();
    } else {
      this.state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  // Creates the pi-tui component that renders a transcript entry.
  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(
        this.state.theme.colors,
        this.state.ui,
        data.instruction,
      );
      block.markDone(data.tokensBefore, data.tokensAfter);
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        return new UserMessageComponent(entry.content, this.state.theme.colors, images);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          this.state.theme.colors,
        );
      case 'assistant': {
        const component = new AssistantMessageComponent(
          this.state.theme.markdownTheme,
          this.state.theme.colors,
        );
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, this.state.theme.colors, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.theme.colors,
            this.state.ui,
            this.state.theme.markdownTheme,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          if (this.state.planExpanded) tc.setPlanExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            this.state.theme.colors,
          );
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail, this.state.theme.colors)
          : new StatusMessageComponent(entry.content, this.state.theme.colors, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(
            entry.backgroundAgentStatus,
            this.state.theme.colors,
          );
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail, this.state.theme.colors)
          : new StatusMessageComponent(entry.content, this.state.theme.colors, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  // Stores a transcript entry and mounts its component if renderable.
  private appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      this.state.transcriptContainer.addChild(component);
      this.state.ui.requestRender();
    }
  }

  // Appends an approval-result entry to the transcript.
  private appendApprovalTranscriptEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    if (request.toolName === 'ExitPlanMode' || request.display.kind === 'plan_review') return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(response.scope === 'session' ? 'Approved for session' : 'Approved');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  // Adds the welcome component to the transcript.
  private renderWelcome(): void {
    const welcome = new WelcomeComponent(this.state.appState, this.state.theme.colors);
    this.state.transcriptContainer.addChild(welcome);
  }

  // Disposes the active compaction component if one is mounted.
  private disposeActiveCompactionBlock(): void {
    if (this.state.activeCompactionBlock !== undefined) {
      this.state.activeCompactionBlock.dispose();
      this.state.activeCompactionBlock = undefined;
    }
  }

  // Disposes the active thinking component if one is mounted.
  private disposeActiveThinkingComponent(): void {
    if (this.state.activeThinkingComponent !== undefined) {
      this.state.activeThinkingComponent.dispose();
      this.state.activeThinkingComponent = undefined;
    }
  }

  // Disposes and forgets all pending live tool-call components.
  private disposeAndClearPendingToolComponents(): void {
    for (const component of this.state.pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this.state.pendingToolComponents.clear();
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  // Clears transcript-related state and redraws the welcome view.
  private clearTranscriptAndRedraw(): void {
    this.discardPendingStreamingUiUpdates();
    this.state.transcriptEntries = [];
    this.disposeActiveCompactionBlock();
    this.resetLiveTextRuntime();
    this.resetLiveToolUiState();
    this.stopAllMcpServerStatusSpinners();
    this.state.transcriptContainer.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    this.imageStore.clear();
    this.renderWelcome();
  }

  // Appends a status message to the transcript.
  private showStatus(message: string, color?: string): void {
    this.state.transcriptContainer.addChild(
      new StatusMessageComponent(message, this.state.theme.colors, color),
    );
    this.state.ui.requestRender();
  }

  // Appends a notice message to the transcript.
  private showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(
      new NoticeMessageComponent(title, detail, this.state.theme.colors),
    );
    this.state.ui.requestRender();
  }

  // Appends an error status message to the transcript.
  private showError(message: string): void {
    this.showStatus(`Error: ${message}`, this.state.theme.colors.error);
  }

  // Adds an animated login progress row to the transcript.
  private showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => chalk.hex(this.state.theme.colors.primary)(s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? this.state.theme.colors.success : this.state.theme.colors.error;
        const symbol = ok ? '✓' : '✗';
        spinner.setText(chalk.hex(tone)(`${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
    };
  }

  // Opens the device-code URL and renders the login authorization prompt.
  private showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: 'Sign in to Kimi Code',
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: 'Press Ctrl-C to cancel',
        colors: this.state.theme.colors,
      }),
    );
    this.state.ui.requestRender();
    return this.showLoginProgressSpinner('Waiting for authorization…');
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  // Rebuilds the activity pane for the current live and streaming state.
  private updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));

    if (
      effectiveMode === this.state.lastActivityMode &&
      (effectiveMode === 'waiting' || effectiveMode === 'thinking' || effectiveMode === 'tool')
    ) {
      return;
    }

    this.state.lastActivityMode = effectiveMode;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.state.ui.requestRender();
        return;
      case 'waiting': {
        const spinner = this.ensureActivitySpinner('moon');
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
          }),
        );
        break;
      }
      case 'thinking': {
        this.stopActivitySpinner();
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'working...', (s) =>
          chalk.hex(this.state.theme.colors.primary)(s),
        );
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        break;
      }
    }
    this.state.ui.requestRender();
  }

  // Computes the effective activity-pane mode from modal and streaming state.
  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.showingSessionPicker) return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';

    const streamingPhase = this.state.appState.streamingPhase;
    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  // Re-renders the queued-message pane.
  private updateQueueDisplay(): void {
    this.state.queueContainer.clear();
    const queued = this.state.queuedMessages;
    if (queued.length === 0) return;

    this.state.queueContainer.addChild(
      new QueuePaneComponent({
        messages: queued,
        colors: this.state.theme.colors,
        isCompacting: this.state.appState.isCompacting,
        isStreaming: this.state.appState.isStreaming,
        canSteerImmediately: !this.deferUserMessages,
      }),
    );
  }

  // Toggles expansion for all expandable tool-output components.
  private toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    for (const child of this.state.transcriptContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(this.state.toolOutputExpanded);
      }
    }
    this.state.ui.requestRender();
  }

  // Toggles expansion for plan-preview cards (ExitPlanMode). Returns true
  // iff at least one plan card was actually toggled so the caller can decide
  // whether to consume the keystroke vs. let pi-tui's default end-of-line run.
  private togglePlanExpansion(): boolean {
    const next = !this.state.planExpanded;
    let toggled = false;
    for (const child of this.state.transcriptContainer.children) {
      if (isPlanExpandable(child) && child.setPlanExpanded(next)) {
        toggled = true;
      }
    }
    if (!toggled) return false;
    this.state.planExpanded = next;
    this.state.ui.requestRender();
    return true;
  }

  // Updates the editor border color for slash command and plan-mode context.
  private updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const colorToken =
      this.state.appState.planMode || trimmed.startsWith('/')
        ? this.state.theme.colors.primary
        : this.state.theme.colors.border;
    this.state.editor.borderColor = (s: string) => chalk.hex(colorToken)(s);
    this.state.ui.requestRender();
  }

  // Applies a theme bundle to all stateful UI theme references.
  private applyTheme(theme: Theme, resolved?: ResolvedTheme): void {
    const nextTheme = createKimiTUIThemeBundle(theme, resolved);
    Object.assign(this.state.theme.colors, nextTheme.colors);
    this.state.theme.resolvedTheme = nextTheme.resolvedTheme;
    this.state.theme.styles = nextTheme.styles;
    this.state.theme.markdownTheme = nextTheme.markdownTheme;
    this.setAppState({ theme });
    this.updateEditorBorderHighlight();
    this.state.ui.requestRender(true);
  }

  // Starts or stops terminal theme notifications according to the user preference.
  private refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    if (this.state.appState.theme !== 'auto') return;

    this.terminalThemeTrackingDispose = installTerminalThemeTracking(this.state, (resolved) => {
      this.applyResolvedAutoTheme(resolved);
    });
  }

  // Stops terminal theme notifications if they were enabled for auto mode.
  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  // Applies a concrete terminal-reported theme while keeping the preference as auto.
  private applyResolvedAutoTheme(resolved: ResolvedTheme): void {
    if (this.state.appState.theme !== 'auto') return;
    if (this.state.theme.resolvedTheme === resolved) return;
    this.applyTheme('auto', resolved);
  }

  // Determines whether the terminal should expose progress state.
  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  // Syncs terminal progress only when the active flag changes.
  private syncTerminalProgress(active: boolean): void {
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  // Returns an activity spinner with the requested style and presentation.
  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinnerStyle !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === undefined) {
      this.state.activitySpinner = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinnerStyle = style;
      return this.state.activitySpinner;
    }

    this.state.activitySpinner.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.setColorFn(colorFn);
    }
    return this.state.activitySpinner;
  }

  // Stops and clears the activity spinner.
  private stopActivitySpinner(): void {
    if (this.state.activitySpinner) {
      this.state.activitySpinner.stop();
      this.state.activitySpinner = undefined;
    }
    this.state.activitySpinnerStyle = undefined;
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  // Replaces the editor with a focusable dialog or selector panel.
  private mountEditorReplacement(panel: Component & Focusable): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
  }

  // Restores the main editor after a dialog or selector closes.
  private restoreEditor(): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.state.ui.requestRender();
  }

  // Runs the first-launch migration screen, if a plan was detected pre-TUI.
  // Resolves with the screen's result when the user dismisses it; the editor
  // is then restored.
  private async runMigrationScreen(plan: MigrationPlan): Promise<MigrationScreenResult> {
    const result = await new Promise<MigrationScreenResult>((resolve) => {
      const screen = new MigrationScreenComponent({
        plan,
        // Reuse the source path detection already resolved — the single source
        // of truth — rather than re-deriving it here.
        sourceHome: plan.sourceHome,
        targetHome: this.harness.homeDir,
        colors: this.state.theme.colors,
        skipDecisionStep: this.migrateOnly,
        requestRender: () => {
          this.state.ui.requestRender();
        },
        onComplete: (r) => {
          resolve(r);
        },
      });
      this.mountEditorReplacement(screen);
    });
    this.restoreEditor();
    if (result.decision === 'never') {
      // Persist the skip marker `detectPendingMigration` checks, so "Never ask
      // again" actually stops the prompt from reappearing every launch.
      try {
        writeFileSync(
          join(this.harness.homeDir, '.skip-migration-from-kimi-cli'),
          '',
          'utf-8',
        );
      } catch {
        // Non-blocking: a failed marker write must never crash startup.
      }
    }
    return result;
  }

  // Shows the help panel with the current slash command list.
  private showHelpPanel(): void {
    this.state.showingHelpPanel = true;
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.getSlashCommands(),
        colors: this.state.theme.colors,
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  // Hides the help panel and returns focus to the editor.
  private hideHelpPanel(): void {
    this.state.showingHelpPanel = false;
    this.restoreEditor();
  }

  // Loads sessions and shows the session picker.
  private async showSessionPicker(): Promise<void> {
    await this.fetchSessions();
    this.mountSessionPicker(() => {
      this.hideSessionPicker();
    });
  }

  // Shows the startup session picker and exits when it is cancelled.
  private async bootstrapFromPicker(): Promise<void> {
    await this.fetchSessions();
    this.mountSessionPicker(() => {
      this.hideSessionPicker();
      void this.stop();
    });
  }

  // Hides the session picker and restores the editor.
  private hideSessionPicker(): void {
    this.state.showingSessionPicker = false;
    this.restoreEditor();
  }

  // Mounts a session picker with shared selection behavior.
  private mountSessionPicker(onCancel: () => void): void {
    this.state.showingSessionPicker = true;
    this.mountEditorReplacement(
      new SessionPickerComponent({
        sessions: this.state.sessions,
        loading: this.state.loadingSessions,
        currentSessionId: this.state.appState.sessionId,
        colors: this.state.theme.colors,
        onSelect: (sessionId: string) => {
          void this.resumeSession(sessionId).then((switched) => {
            if (switched) {
              this.hideSessionPicker();
            }
          });
        },
        onCancel,
      }),
    );
  }

  // =========================================================================
  // Background tasks browser (`/tasks`)
  // =========================================================================

  /**
   * Open the `/tasks` overlay. Idempotent: a second `/tasks` while the
   * panel is already open is a no-op (the focus stays on the existing
   * overlay) — prevents accidental stacking.
   */
  private async showTasksBrowser(): Promise<void> {
    if (this.state.tasksBrowser !== undefined) return;
    const session = this.session;
    if (session === undefined) {
      this.showError('No active session.');
      return;
    }

    let tasks: readonly BackgroundTaskInfo[] = [];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      this.showError(
        `Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // Race: panel might have been opened then immediately closed by
    // another path while the await above was in flight. Bail out then.
    if (this.state.tasksBrowser !== undefined) return;

    const filter: TasksFilter = 'all';
    const selectedTaskId = this.pickInitialSelection(tasks, filter);
    const component = new TasksBrowserApp(
      {
        tasks,
        filter,
        selectedTaskId,
        tailOutput: undefined,
        tailLoading: false,
        flashMessage: undefined,
        colors: this.state.theme.colors,
        ...this.buildTasksBrowserCallbacks(),
      },
      this.state.terminal,
    );

    // Alt-screen takeover: save the main TUI's children, then replace
    // them with this single full-screen component. `closeTasksBrowser`
    // restores the original layout. Mirrors the Python `Application(
    // full_screen=True, erase_when_done=True)` pattern.
    const savedChildren = [...this.state.ui.children];
    this.state.ui.clear();
    this.state.ui.addChild(component);
    this.state.ui.setFocus(component);
    this.state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshTasksBrowser({ silent: true });
    }, 1000);

    this.state.tasksBrowser = {
      component,
      savedChildren,
      filter,
      selectedTaskId,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
      viewer: undefined,
    };

    if (selectedTaskId !== undefined) {
      this.loadTasksBrowserTail(selectedTaskId);
    }
  }

  private pickInitialSelection(
    tasks: readonly BackgroundTaskInfo[],
    filter: TasksFilter,
  ): string | undefined {
    const candidates =
      filter === 'all'
        ? tasks
        : tasks.filter(
            (t) =>
              t.status !== 'completed' &&
              t.status !== 'failed' &&
              t.status !== 'killed' &&
              t.status !== 'lost',
          );
    if (candidates.length === 0) return undefined;
    // Prefer the first non-terminal task; fall back to the first one.
    return (
      candidates.find(
        (t) => t.status === 'running' || t.status === 'awaiting_approval',
      )?.taskId ?? candidates[0]!.taskId
    );
  }

  private async refreshTasksBrowser(opts: { silent?: boolean } = {}): Promise<void> {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    const session = this.session;
    if (session === undefined) return;

    let tasks: readonly BackgroundTaskInfo[];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      if (!opts.silent) {
        this.flashTasksBrowser(
          `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (this.state.tasksBrowser !== browser) return;
    this.pushTasksBrowserProps(tasks);
  }

  private pushTasksBrowserProps(tasks: readonly BackgroundTaskInfo[]): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    browser.component.setProps({
      tasks,
      filter: browser.filter,
      selectedTaskId: browser.selectedTaskId,
      tailOutput: browser.tailOutput,
      tailLoading: browser.tailLoading,
      flashMessage: browser.flashMessage,
      colors: this.state.theme.colors,
      ...this.buildTasksBrowserCallbacks(),
    });
    this.state.ui.requestRender();
  }

  /** Callback bundle for `TasksBrowserComponent`. Single source of truth. */
  private buildTasksBrowserCallbacks(): {
    onSelect: (taskId: string) => void;
    onToggleFilter: () => void;
    onRefresh: () => void;
    onCancel: () => void;
    onStopConfirmed: (taskId: string) => void;
    onOpenOutput: (taskId: string) => void;
    onStopIgnored: (taskId: string, reason: 'terminal') => void;
  } {
    return {
      onSelect: (taskId) => {
        this.handleTasksBrowserSelect(taskId);
      },
      onToggleFilter: () => {
        this.handleTasksBrowserToggleFilter();
      },
      onRefresh: () => {
        this.handleTasksBrowserRefresh();
      },
      onCancel: () => {
        this.closeTasksBrowser();
      },
      onStopConfirmed: (taskId) => {
        void this.handleTasksBrowserStop(taskId);
      },
      onOpenOutput: (taskId) => {
        void this.handleTasksBrowserOpenOutput(taskId);
      },
      onStopIgnored: (taskId, reason) => {
        if (reason === 'terminal') {
          this.flashTasksBrowser(`${taskId} is already terminal — nothing to stop.`);
        }
      },
    };
  }

  private handleTasksBrowserSelect(taskId: string): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.tailOutput = undefined;
    browser.tailLoading = true;
    this.repaintTasksBrowser();
    this.loadTasksBrowserTail(taskId);
  }

  private handleTasksBrowserToggleFilter(): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    browser.filter = browser.filter === 'all' ? 'active' : 'all';
    this.repaintTasksBrowser();
  }

  private handleTasksBrowserRefresh(): void {
    this.flashTasksBrowser('Refreshing…', 600);
    void this.refreshTasksBrowser();
  }

  /**
   * Re-render the `/tasks` panel from the in-memory BPM store (no RPC
   * fetch). Safe to call when the panel is closed (no-op). Use this
   * after any local state change — selection, filter, flash message,
   * or an incoming `background.task.*` event — so the UI stays in sync.
   * Use `refreshTasksBrowser` instead when you also want fresh data
   * from the agent (e.g. a manual `R refresh`).
   */
  private repaintTasksBrowser(): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    const tasks = [...this.state.backgroundTasks.values()];
    this.pushTasksBrowserProps(tasks);
  }

  private loadTasksBrowserTail(taskId: string): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    const session = this.session;
    if (session === undefined) {
      browser.tailLoading = false;
      this.repaintTasksBrowser();
      return;
    }
    const requestId = ++browser.tailRequestId;
    void session
      .getBackgroundTaskOutput(taskId, { tail: 4000 })
      .then((output) => {
        const current = this.state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = output;
        current.tailLoading = false;
        this.repaintTasksBrowser();
      })
      .catch(() => {
        const current = this.state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = '';
        current.tailLoading = false;
        this.repaintTasksBrowser();
      });
  }

  private flashTasksBrowser(message: string, durationMs = 2500): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.state.tasksBrowser;
      if (current !== browser) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.repaintTasksBrowser();
    }, durationMs);
    this.repaintTasksBrowser();
  }

  private async handleTasksBrowserStop(taskId: string): Promise<void> {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    const session = this.session;
    if (session === undefined) {
      this.flashTasksBrowser('No active session.');
      return;
    }
    this.flashTasksBrowser(`Stopping ${taskId}…`, 1500);
    try {
      await session.stopBackgroundTask(taskId, { reason: 'stopped from /tasks' });
      // Force a refresh so the row flips to `killed` immediately. The
      // `background.task.terminated` event will repaint again shortly.
      await this.refreshTasksBrowser({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flashTasksBrowser(`Stop failed: ${message}`);
    }
  }

  private async handleTasksBrowserOpenOutput(taskId: string): Promise<void> {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) return; // already viewing
    const session = this.session;
    if (session === undefined) {
      this.flashTasksBrowser('No active session.');
      return;
    }

    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flashTasksBrowser(`Cannot open output: ${message}`);
      return;
    }
    // Race: panel might have been closed while the await was in flight.
    const current = this.state.tasksBrowser;
    if (current === undefined || current !== browser) return;

    const info = this.state.backgroundTasks.get(taskId);
    const viewer = new TaskOutputViewer(
      {
        taskId,
        info,
        output,
        colors: this.state.theme.colors,
        onClose: () => {
          this.closeTaskOutputViewer();
        },
      },
      this.state.terminal,
    );

    // Nested takeover: save the TasksBrowser layer (which itself is a
    // single-child swap of the main TUI), then put the viewer in its
    // place. `closeTaskOutputViewer` reverses this without touching the
    // outer "main TUI ↔ TasksBrowser" swap state.
    const savedBrowserChildren = [...this.state.ui.children];
    this.state.ui.clear();
    this.state.ui.addChild(viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);

    // Live-tail: keep re-fetching the output every second so the viewer
    // shows new content as the task writes it. The viewer itself decides
    // whether to follow the tail or preserve scroll position.
    const pollTimer = setInterval(() => {
      void this.refreshTaskOutputViewer({ silent: true });
    }, 1000);

    browser.viewer = {
      component: viewer,
      savedChildren: savedBrowserChildren,
      taskId,
      output,
      refreshId: 0,
      pollTimer,
    };
  }

  /**
   * Re-fetch the current viewer task's output and push it into the
   * component. Safe to call when the viewer is closed (no-op). Stale
   * responses (issued before a more recent call) are discarded via the
   * monotonically-increasing `refreshId`.
   */
  private async refreshTaskOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const browser = this.state.tasksBrowser;
    const viewer = browser?.viewer;
    if (browser === undefined || viewer === undefined) return;
    const session = this.session;
    if (session === undefined) return;

    const myRefreshId = ++viewer.refreshId;
    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(viewer.taskId);
    } catch (error) {
      if (!opts.silent) {
        const message = error instanceof Error ? error.message : String(error);
        this.flashTasksBrowser(`Output refresh failed: ${message}`);
      }
      return;
    }
    // If the viewer was closed or another refresh raced ahead, drop this result.
    const current = this.state.tasksBrowser?.viewer;
    if (current === undefined || current !== viewer || current.refreshId !== myRefreshId) {
      return;
    }
    // Skip the setProps round-trip when nothing changed — keeps the
    // differential renderer from re-emitting the same frame.
    if (output === viewer.output) return;
    viewer.output = output;
    const info = this.state.backgroundTasks.get(viewer.taskId);
    viewer.component.setProps({
      taskId: viewer.taskId,
      info,
      output,
      colors: this.state.theme.colors,
      onClose: () => {
        this.closeTaskOutputViewer();
      },
    });
    this.state.ui.requestRender();
  }

  private closeTaskOutputViewer(): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined || browser.viewer === undefined) return;
    const viewer = browser.viewer;
    clearInterval(viewer.pollTimer);
    browser.viewer = undefined;
    this.state.ui.clear();
    for (const child of viewer.savedChildren) {
      this.state.ui.addChild(child);
    }
    this.state.ui.setFocus(browser.component);
    this.state.ui.requestRender(true);
  }

  private closeTasksBrowser(): void {
    const browser = this.state.tasksBrowser;
    if (browser === undefined) return;
    // If the output viewer is open, fold it back before tearing down
    // the browser so the saved-children stack stays consistent.
    if (browser.viewer !== undefined) this.closeTaskOutputViewer();
    if (browser.pollTimer !== undefined) clearInterval(browser.pollTimer);
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);

    // Restore the main TUI's children we saved when opening. After
    // clearing, re-add in original order, then return focus to the
    // editor so the user is back at the prompt.
    this.state.ui.clear();
    for (const child of browser.savedChildren) {
      this.state.ui.addChild(child);
    }
    this.state.tasksBrowser = undefined;
    this.state.ui.setFocus(this.state.editor);
    this.state.ui.requestRender(true);
  }

  // Shows the editor command selector.
  private showEditorPicker(): void {
    const currentValue = this.state.appState.editorCommand ?? '';
    this.mountEditorReplacement(
      new EditorSelectorComponent({
        currentValue,
        colors: this.state.theme.colors,
        onSelect: (value) => {
          this.restoreEditor();
          void this.applyEditorChoice(value);
        },
        onCancel: () => {
          this.restoreEditor();
        },
      }),
    );
  }

  // Persists and applies the selected external editor command.
  private async applyEditorChoice(value: string): Promise<void> {
    const previous = this.state.appState.editorCommand ?? '';
    if (value === previous && value.length > 0) {
      this.showStatus(`Editor unchanged: ${value.length > 0 ? value : 'auto-detect'}`);
      return;
    }

    const editorCommand = value.length > 0 ? value : null;
    try {
      await saveTuiConfig({
        theme: this.state.appState.theme,
        editorCommand,
        notifications: this.state.appState.notifications,
      });
    } catch (error) {
      this.showStatus(
        `Failed to save editor: ${formatErrorMessage(error)}`,
        this.state.theme.colors.error,
      );
      return;
    }

    this.setAppState({ editorCommand });
    this.showStatus(
      value.length > 0
        ? `Editor set to "${value}".`
        : 'Editor set to auto-detect ($VISUAL / $EDITOR).',
    );
  }

  // Shows the model selector when models are available.
  private showModelPicker(selectedValue: string = this.state.appState.model): void {
    const entries = Object.entries(this.state.appState.availableModels);
    if (entries.length === 0) {
      this.showNotice(
        'No models configured',
        'Run /login to sign in to Kimi, or /connect to add another provider from a model catalog.',
      );
      return;
    }
    this.mountEditorReplacement(
      new ModelSelectorComponent({
        models: this.state.appState.availableModels,
        currentValue: this.state.appState.model,
        selectedValue,
        currentThinking: this.state.appState.thinking,
        colors: this.state.theme.colors,
        searchable: true,
        onSelect: ({ alias, thinking }) => {
          this.restoreEditor();
          void this.performModelSwitch(alias, thinking);
        },
        onCancel: () => {
          this.restoreEditor();
        },
      }),
    );
  }

  // Applies model and thinking changes to the active or newly created session.
  private async performModelSwitch(alias: string, thinking: boolean): Promise<void> {
    if (this.state.appState.isStreaming) {
      this.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
      return;
    }

    const level = thinking ? 'on' : 'off';
    const prevModel = this.state.appState.model;
    const prevThinking = this.state.appState.thinking;
    const runtimeChanged = alias !== prevModel || thinking !== prevThinking;

    const session = this.session;
    try {
      if (session === undefined && runtimeChanged) {
        await this.activateModelAfterLogin(alias, thinking);
      } else if (session !== undefined) {
        if (alias !== prevModel) {
          await session.setModel(alias);
        }
        if (thinking !== prevThinking) {
          await session.setThinking(level);
        }
      }
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to switch model: ${msg}`);
      return;
    }

    this.setAppState({ model: alias, thinking });
    if (session === undefined && runtimeChanged) {
      if (alias !== prevModel) {
        this.track('model_switch', { model: alias });
      }
      if (thinking !== prevThinking) {
        this.track('thinking_toggle', { enabled: thinking });
      }
    }

    let persisted = false;
    try {
      persisted = await this.persistModelSelection(alias, thinking);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Switched to ${alias}, but failed to save default: ${msg}`);
      return;
    }

    const status = runtimeChanged
      ? `Switched to ${alias} with thinking ${level}.`
      : persisted
        ? `Saved ${alias} with thinking ${level} as default.`
        : `Already using ${alias} with thinking ${level}.`;
    this.showStatus(status, this.state.theme.colors.success);
  }

  // Persists the selected model and thinking state as the startup defaults.
  private async persistModelSelection(alias: string, thinking: boolean): Promise<boolean> {
    const config = await this.harness.getConfig({ reload: true });
    if (config.defaultModel === alias && config.defaultThinking === thinking) {
      return false;
    }
    await this.harness.setConfig({
      defaultModel: alias,
      defaultThinking: thinking,
    });
    return true;
  }

  // Shows the theme selector.
  private showThemePicker(): void {
    this.mountEditorReplacement(
      new ThemeSelectorComponent({
        currentValue: this.state.appState.theme,
        colors: this.state.theme.colors,
        onSelect: (value) => {
          this.restoreEditor();
          void this.applyThemeChoice(value);
        },
        onCancel: () => {
          this.restoreEditor();
        },
      }),
    );
  }

  // Shows the permission mode selector.
  private showPermissionPicker(): void {
    this.mountEditorReplacement(
      new PermissionSelectorComponent({
        currentValue: this.state.appState.permissionMode,
        colors: this.state.theme.colors,
        onSelect: (value) => {
          this.restoreEditor();
          void this.applyPermissionChoice(value);
        },
        onCancel: () => {
          this.restoreEditor();
        },
      }),
    );
  }

  // Shows the settings selector entry point.
  private showSettingsSelector(): void {
    this.mountEditorReplacement(
      new SettingsSelectorComponent({
        colors: this.state.theme.colors,
        onSelect: (value) => {
          this.handleSettingsSelection(value);
        },
        onCancel: () => {
          this.restoreEditor();
        },
      }),
    );
  }

  // Routes a settings selection to the matching selector or panel.
  private handleSettingsSelection(value: SettingsSelection): void {
    this.restoreEditor();
    switch (value) {
      case 'model':
        this.showModelPicker();
        return;
      case 'permission':
        this.showPermissionPicker();
        return;
      case 'theme':
        this.showThemePicker();
        return;
      case 'editor':
        this.showEditorPicker();
        return;
      case 'usage':
        void this.showUsage();
        return;
    }
  }

  // Shows the plugin manager entry point.
  private async showPluginsPicker(options?: {
    readonly selectedId?: string;
    readonly pluginHint?: {
      readonly id: string;
      readonly text: string;
    };
  }): Promise<void> {
    let plugins: readonly PluginSummary[];
    try {
      plugins = await this.requireSession().listPlugins();
    } catch (error) {
      this.showError(`Failed to load plugins: ${formatErrorMessage(error)}`);
      return;
    }

    this.mountEditorReplacement(
      new PluginsOverviewSelectorComponent({
        plugins,
        selectedId: options?.selectedId,
        pluginHint: options?.pluginHint,
        colors: this.state.theme.colors,
        onSelect: (selection) => {
          this.restoreEditor();
          void this.handlePluginsOverviewSelection(selection).catch((error: unknown) => {
            this.showError(`/plugins failed: ${formatErrorMessage(error)}`);
          });
        },
        onCancel: () => {
          this.restoreEditor();
        },
      }),
    );
  }

  // Loads official marketplace metadata and shows installable plugins.
  private async showPluginMarketplacePicker(source?: string): Promise<void> {
    try {
      const [marketplace, installed] = await Promise.all([
        loadPluginMarketplace({ workDir: this.state.appState.workDir, source }),
        this.requireSession().listPlugins(),
      ]);
      this.mountEditorReplacement(
        new PluginMarketplaceSelectorComponent({
          entries: marketplace.plugins,
          installedIds: new Set(installed.map((plugin) => plugin.id)),
          source: marketplace.source,
          colors: this.state.theme.colors,
          onSelect: (selection) => {
            this.restoreEditor();
            void this.handlePluginMarketplaceSelection(selection).catch((error: unknown) => {
              this.showError(`/plugins marketplace failed: ${formatErrorMessage(error)}`);
            });
          },
          onCancel: () => {
            this.restoreEditor();
            void this.showPluginsPicker();
          },
        }),
      );
    } catch (error) {
      this.showError(`Failed to load plugin marketplace: ${formatErrorMessage(error)}`);
    }
  }

  private async showPluginMcpPicker(id: string): Promise<void> {
    let info: PluginInfo;
    try {
      info = await this.requireSession().getPluginInfo(id);
    } catch (error) {
      this.showError(`Failed to load plugin MCP servers: ${formatErrorMessage(error)}`);
      return;
    }

    this.mountEditorReplacement(
      new PluginMcpSelectorComponent({
        info,
        colors: this.state.theme.colors,
        onSelect: (selection) => {
          this.restoreEditor();
          void this.handlePluginMcpSelection(selection).catch((error: unknown) => {
            this.showError(`/plugins mcp failed: ${formatErrorMessage(error)}`);
          });
        },
        onCancel: () => {
          this.restoreEditor();
          void this.showPluginsPicker({ selectedId: id });
        },
      }),
    );
  }

  private async confirmRemovePlugin(id: string): Promise<boolean> {
    let displayName = id;
    try {
      displayName = (await this.requireSession().getPluginInfo(id)).displayName;
    } catch {
      // Keep the confirmation available even when plugin details cannot be loaded.
    }

    return new Promise((resolveConfirmed) => {
      this.mountEditorReplacement(
        new PluginRemoveConfirmComponent({
          id,
          displayName,
          colors: this.state.theme.colors,
          onDone: (result: PluginRemoveConfirmResult) => {
            this.restoreEditor();
            resolveConfirmed(result.kind === 'confirm');
          },
        }),
      );
    });
  }

  // Applies a permission mode choice to the active session and app state.
  private async applyPermissionChoice(mode: PermissionMode): Promise<void> {
    if (mode === this.state.appState.permissionMode) {
      this.showStatus(`Permission mode unchanged: ${mode}.`);
      return;
    }

    try {
      await this.requireSession().setPermission(mode);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to set permission mode: ${msg}`);
      return;
    }

    this.setAppState({ permissionMode: mode, yolo: mode === 'yolo' });
    this.showNotice(`Permission mode: ${mode}`);
  }

  // Persists and applies a theme choice.
  private async applyThemeChoice(theme: Theme): Promise<void> {
    if (theme === this.state.appState.theme) {
      if (theme === 'auto') this.refreshTerminalThemeTracking();
      this.showStatus(`Theme unchanged: "${theme}".`);
      return;
    }

    try {
      await saveTuiConfig({
        theme,
        editorCommand: this.state.appState.editorCommand,
        notifications: this.state.appState.notifications,
      });
    } catch (error) {
      this.showStatus(
        `Failed to save theme: ${formatErrorMessage(error)}`,
        this.state.theme.colors.error,
      );
      return;
    }

    const resolved = theme === 'auto' ? this.state.theme.resolvedTheme : theme;
    this.applyTheme(theme, resolved);
    this.refreshTerminalThemeTracking();
    this.track('theme_switch', { theme });
    const detail = theme === 'auto' ? ` (tracking terminal; current: ${resolved})` : '';
    this.showStatus(`Theme set to "${theme}"${detail}.`);
  }

  // Loads and renders current usage information.
  private async showUsage(): Promise<void> {
    const sessionUsage = await this.loadSessionUsageReport();
    const managedUsage = await this.loadManagedUsageReport();
    const lines = buildUsageReportLines({
      colors: this.state.theme.colors,
      sessionUsage: sessionUsage.usage,
      sessionUsageError: sessionUsage.error,
      contextUsage: this.state.appState.contextUsage,
      contextTokens: this.state.appState.contextTokens,
      maxContextTokens: this.state.appState.maxContextTokens,
      managedUsage: managedUsage?.usage,
      managedUsageError: managedUsage?.error,
    });
    const panel = new UsagePanelComponent(lines, this.state.theme.colors.primary);
    this.state.transcriptContainer.addChild(panel);
    this.state.ui.requestRender();
  }

  // Loads and renders current runtime status.
  private async showStatusReport(): Promise<void> {
    const [runtimeStatus, managedUsage] = await Promise.all([
      this.loadRuntimeStatusReport(),
      this.loadManagedUsageReport(),
    ]);
    const appState = this.state.appState;
    const lines = buildStatusReportLines({
      colors: this.state.theme.colors,
      version: appState.version,
      model: appState.model,
      workDir: appState.workDir,
      sessionId: appState.sessionId,
      sessionTitle: appState.sessionTitle,
      thinking: appState.thinking,
      permissionMode: appState.permissionMode,
      planMode: appState.planMode,
      contextUsage: appState.contextUsage,
      contextTokens: appState.contextTokens,
      maxContextTokens: appState.maxContextTokens,
      availableModels: appState.availableModels,
      status: runtimeStatus.status,
      statusError: runtimeStatus.error,
      managedUsage: managedUsage?.usage,
      managedUsageError: managedUsage?.error,
    });
    const panel = new UsagePanelComponent(lines, this.state.theme.colors.primary, ' Status ');
    this.state.transcriptContainer.addChild(panel);
    this.state.ui.requestRender();
  }

  private async handlePluginsCommand(rawArgs: string): Promise<void> {
    const args = rawArgs.trim().split(/\s+/).filter((part) => part.length > 0);
    const sub = args[0];
    const rest = args.slice(1);
    const session = this.requireSession();

    try {
      if (sub === undefined) {
        await this.showPluginsPicker();
        return;
      }
      if (sub === 'list') {
        await this.renderPluginsList();
        return;
      }
      if (sub === 'install') {
        const source = rest.join(' ').trim();
        if (source.length === 0) {
          this.showError('Usage: /plugins install <local-path-or-zip-url>');
          return;
        }
        await this.installPluginFromSource(source);
        return;
      }
      if (sub === 'marketplace') {
        await this.showPluginMarketplacePicker(rest.join(' ').trim() || undefined);
        return;
      }
      if (sub === 'info') {
        const id = rest[0];
        if (id === undefined) {
          await this.showPluginsPicker();
          return;
        }
        await this.renderPluginInfo(id);
        return;
      }
      if (sub === 'mcp') {
        const action = rest[0];
        const id = rest[1];
        const server = rest[2];
        if ((action !== 'enable' && action !== 'disable') || id === undefined || server === undefined) {
          this.showError('Usage: /plugins mcp enable|disable <id> <server>');
          return;
        }
        await session.setPluginMcpServerEnabled(id, server, action === 'enable');
        this.showStatus(
          `${action === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${server} for ${id}. Run /new to apply.`,
        );
        return;
      }
      if (sub === 'enable' || sub === 'disable') {
        const id = rest[0];
        if (id === undefined) {
          await this.showPluginsPicker();
          return;
        }
        await this.applyPluginEnabled(id, sub === 'enable');
        return;
      }
      if (sub === 'remove') {
        const id = rest[0];
        if (id === undefined) {
          this.showError('Usage: /plugins remove <id>');
          return;
        }
        if (!(await this.confirmRemovePlugin(id))) {
          this.showStatus(`Remove cancelled: ${id}.`);
          return;
        }
        await session.removePlugin(id);
        this.showStatus(`Removed ${id} (plugin files left in place).`);
        return;
      }
      if (sub === 'reload') {
        await this.reloadPlugins();
        return;
      }
      const plugins = await session.listPlugins();
      if (plugins.some((plugin) => plugin.id === sub)) {
        await this.renderPluginInfo(sub);
        return;
      }
      this.showError(`Unknown /plugins action: ${sub}. Run /plugins to choose interactively.`);
    } catch (error) {
      this.showError(`/plugins ${sub ?? ''} failed: ${formatErrorMessage(error)}`);
    }
  }

  // Toggles a plugin's enabled state and surfaces the MCP opt-in hint when relevant.
  private async applyPluginEnabled(id: string, enabled: boolean): Promise<void> {
    const session = this.requireSession();
    await session.setPluginEnabled(id, enabled);
    let info: PluginInfo | undefined;
    try {
      info = await session.getPluginInfo(id);
    } catch {
      info = undefined;
    }
    const mcpHint =
      enabled && info !== undefined && info.mcpServerCount > info.enabledMcpServerCount
        ? ` Some MCP servers are disabled; re-enable with /plugins mcp enable ${id} <server>.`
        : '';
    this.showStatus(`${enabled ? 'Enabled' : 'Disabled'} ${id}. Run /new to apply.${mcpHint}`);
  }

  private async handlePluginsOverviewSelection(
    selection: PluginsOverviewSelection,
  ): Promise<void> {
    const session = this.requireSession();
    switch (selection.kind) {
      case 'marketplace':
        await this.showPluginMarketplacePicker();
        return;
      case 'reload':
        await this.reloadPlugins();
        await this.showPluginsPicker();
        return;
      case 'show-list':
        await this.renderPluginsList();
        return;
      case 'toggle':
        await this.applyPluginEnabled(selection.id, selection.enabled);
        await this.showPluginsPicker({
          selectedId: selection.id,
          pluginHint: { id: selection.id, text: 'saved · /new to apply' },
        });
        return;
      case 'mcp':
        await this.showPluginMcpPicker(selection.id);
        return;
      case 'remove':
        if (!(await this.confirmRemovePlugin(selection.id))) {
          this.showStatus(`Remove cancelled: ${selection.id}.`);
          await this.showPluginsPicker({ selectedId: selection.id });
          return;
        }
        await session.removePlugin(selection.id);
        this.showStatus(`Removed ${selection.id} (plugin files left in place).`);
        await this.showPluginsPicker();
        return;
      case 'info':
        await this.renderPluginInfo(selection.id);
        return;
    }
  }

  private async handlePluginMcpSelection(selection: PluginMcpSelection): Promise<void> {
    switch (selection.kind) {
      case 'toggle':
        await this.requireSession().setPluginMcpServerEnabled(
          selection.pluginId,
          selection.server,
          selection.enabled,
        );
        this.showStatus(
          `${selection.enabled ? 'Enabled' : 'Disabled'} MCP server ${selection.server} for ${selection.pluginId}. Run /new to apply.`,
        );
        await this.showPluginMcpPicker(selection.pluginId);
        return;
      case 'back':
        await this.showPluginsPicker({ selectedId: selection.pluginId });
        return;
    }
  }

  private async handlePluginMarketplaceSelection(
    selection: PluginMarketplaceSelection,
  ): Promise<void> {
    switch (selection.kind) {
      case 'install':
        this.showStatus(`Installing or updating ${selection.entry.displayName} from marketplace...`);
        await this.installPluginFromSource(selection.entry.source, {
          successNotice: 'marketplace',
        });
        await this.showPluginsPicker({ selectedId: selection.entry.id });
        return;
      case 'back':
        await this.showPluginsPicker();
        return;
    }
  }

  private async renderPluginsList(plugins?: readonly PluginSummary[]): Promise<void> {
    const currentPlugins = plugins ?? (await this.requireSession().listPlugins());
    const lines = buildPluginsListLines({
      colors: this.state.theme.colors,
      plugins: currentPlugins,
    });
    const title = ` Plugins (${currentPlugins.length}) `;
    const panel = new UsagePanelComponent(lines, this.state.theme.colors.primary, title);
    this.state.transcriptContainer.addChild(panel);
    this.state.ui.requestRender();
  }

  private async renderPluginInfo(id: string): Promise<void> {
    const info = await this.requireSession().getPluginInfo(id);
    const lines = buildPluginsInfoLines({ colors: this.state.theme.colors, info });
    const panel = new UsagePanelComponent(lines, this.state.theme.colors.primary, ` ${info.id} `);
    this.state.transcriptContainer.addChild(panel);
    this.state.ui.requestRender();
  }

  private async installPluginFromSource(
    source: string,
    options?: { readonly successNotice?: 'marketplace' },
  ): Promise<void> {
    const summary = await this.requireSession().installPlugin(
      resolvePluginInstallSource(source, this.state.appState.workDir),
    );
    const serverWord = summary.mcpServerCount === 1 ? 'server' : 'servers';
    const mcpHint =
      summary.mcpServerCount > 0
        ? ` Declares ${summary.mcpServerCount} MCP ${serverWord}; enabled by default and configurable from /plugins.`
        : '';
    const installVerb = options?.successNotice === 'marketplace' ? 'Installed or updated' : 'Installed';
    this.showStatus(
      `${installVerb} ${summary.displayName} (${summary.id}).${mcpHint} Run /new to apply plugin changes.`,
    );
    if (options?.successNotice === 'marketplace') {
      this.showNotice(
        `Installed or updated ${summary.displayName}`,
        `Marketplace install or update succeeded for ${summary.id}. Run /new to apply plugin changes.`,
      );
    }
  }

  private async reloadPlugins(): Promise<void> {
    const summary = await this.requireSession().reloadPlugins();
    const line = `Reload: +${summary.added.length} -${summary.removed.length}` +
      (summary.errors.length > 0 ? ` (${summary.errors.length} errors)` : '');
    this.showStatus(line);
  }

  // Loads and renders current MCP server status.
  private async showMcpServers(): Promise<void> {
    let servers: readonly McpServerInfo[];
    try {
      servers = await this.requireSession().listMcpServers();
    } catch (error) {
      this.showError(`Failed to load MCP servers: ${formatErrorMessage(error)}`);
      return;
    }

    const lines = buildMcpStatusReportLines({
      colors: this.state.theme.colors,
      servers,
    });
    const title = servers.length > 0 ? ` MCP (${servers.length}) ` : ' MCP ';
    const panel = new UsagePanelComponent(lines, this.state.theme.colors.primary, title);
    this.state.transcriptContainer.addChild(panel);
    this.state.ui.requestRender();
  }

  // Loads per-session usage and captures displayable errors.
  private async loadSessionUsageReport(): Promise<SessionUsageResult> {
    try {
      return { usage: await this.requireSession().getUsage() };
    } catch (error) {
      return { error: formatErrorMessage(error) };
    }
  }

  // Loads per-session runtime status and captures displayable errors.
  private async loadRuntimeStatusReport(): Promise<RuntimeStatusResult> {
    try {
      return { status: await this.requireSession().getStatus() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Loads managed-provider usage when the active model supports it.
  private async loadManagedUsageReport(): Promise<ManagedUsageResult | undefined> {
    const alias = this.state.appState.model;
    const providerKey = this.state.appState.availableModels[alias]?.provider;
    if (!isManagedUsageProvider(providerKey)) return undefined;

    let res;
    try {
      res = await this.harness.auth.getManagedUsage(providerKey);
    } catch (error) {
      return { error: formatErrorMessage(error) };
    }
    if (res.kind === 'error') {
      return { error: res.message };
    }
    return { usage: { summary: res.summary, limits: res.limits } };
  }

  // Shows an approval panel and connects its response callback.
  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: 'Kimi Code approval required',
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      this.state.theme.colors,
      () => {
        this.toggleToolOutputExpansion();
      },
      () => {
        this.togglePlanExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel);
  }

  // Hides the active approval panel.
  private hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
  }

  // Mounts the full-screen approval preview viewer on top of the current
  // approval panel. Uses the same nested-takeover pattern as
  // openTaskOutputViewer: we snapshot the root container's children, swap
  // in the viewer, and restore on close. The approval panel instance is
  // kept around in `activeApprovalPanel` so its selection state survives.
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const savedChildren = [...this.state.ui.children];
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        colors: this.state.theme.colors,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    this.state.ui.clear();
    this.state.ui.addChild(viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, savedChildren, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    this.state.ui.clear();
    for (const child of preview.savedChildren) {
      this.state.ui.addChild(child);
    }
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  // Shows a question dialog and connects its response callback.
  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: 'Kimi Code needs your answer',
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      this.state.theme.colors,
      undefined,
      () => {
        this.toggleToolOutputExpansion();
      },
      () => {
        this.togglePlanExpansion();
      },
    );
    this.mountEditorReplacement(dialog);
  }

  // Hides the active question dialog.
  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
    this.restoreEditor();
  }

  // =========================================================================
  // Slash Command Handlers
  // =========================================================================

  // Applies plan mode through the session and mirrors it into UI state.
  private async applyPlanMode(session: Session, enabled: boolean): Promise<void> {
    try {
      await session.setPlanMode(enabled);
      this.setAppState({ planMode: enabled });
      if (enabled) {
        const plan = await session.getPlan().catch(() => null);
        this.showNotice(
          'Plan mode: ON',
          plan?.path !== undefined ? `Plan will be created here: ${plan.path}` : undefined,
        );
        return;
      }
      this.showNotice('Plan mode: OFF');
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to set plan mode: ${msg}`);
    }
  }

  // Handles the /editor command.
  private async handleEditorCommand(args: string, _eCtx: {}): Promise<void> {
    const command = args.trim();
    if (command.length === 0) {
      this.showEditorPicker();
      return;
    }
    await this.applyEditorChoice(command);
  }

  // Handles the /theme command.
  private async handleThemeCommand(args: string): Promise<void> {
    const theme = args.trim();
    if (theme.length === 0) {
      this.showThemePicker();
      return;
    }
    if (!isTheme(theme)) {
      this.showError(`Unknown theme: ${theme}`);
      return;
    }
    await this.applyThemeChoice(theme);
  }

  // Handles the /model command.
  private handleModelCommand(args: string): void {
    const alias = args.trim();
    if (alias.length === 0) {
      this.showModelPicker();
      return;
    }
    if (this.state.appState.availableModels[alias] === undefined) {
      this.showError(`Unknown model alias: ${alias}`);
      return;
    }
    this.showModelPicker(alias);
  }

  // Handles the /title command.
  private async handleTitleCommand(args: string): Promise<void> {
    const title = args.trim();
    if (title.length === 0) {
      const current = this.state.appState.sessionTitle;
      this.showStatus(
        current !== null && current.length > 0
          ? `Session title: ${current}`
          : `Session title: (not set) — id: ${this.state.appState.sessionId}`,
      );
      return;
    }

    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    const newTitle = title.slice(0, 200);
    try {
      await this.harness.renameSession({ id: session.id, title: newTitle });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to set title: ${msg}`);
      return;
    }
    this.showStatus(`Session title set to: ${newTitle}`);
  }

  // Handles the /fork command.
  private async handleForkCommand(args: string): Promise<void> {
    void args;

    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    const sourceTitle = this.forkSourceTitle(session);
    let forked: Session;
    try {
      forked = await this.harness.forkSession({
        id: session.id,
        title: `Fork: ${sourceTitle}`,
      });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to fork session: ${msg}`);
      return;
    }

    try {
      await this.switchToSession(
        forked,
        `Session forked (${forked.id}). To return to the original session: kimi -r ${session.id}`,
      );
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to switch to forked session: ${msg}`);
    }
  }

  private async handleExportMdCommand(args: string): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    this.showStatus('Exporting session as Markdown…');
    try {
      const context = await session.getContext();
      if (context.history.length === 0) {
        this.showError('No messages to export.');
        return;
      }

      const now = new Date();
      const shortId = session.id.slice(0, 8);
      const timestamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/T/, '-').slice(0, 15);
      const defaultName = `kimi-export-${shortId}-${timestamp}.md`;

      const trimmedArgs = args.trim();
      const outputPath = trimmedArgs.length > 0
        ? resolve(trimmedArgs)
        : resolve(this.state.appState.workDir, defaultName);

      const md = buildExportMarkdown({
        sessionId: session.id,
        workDir: this.state.appState.workDir,
        history: context.history,
        tokenCount: context.tokenCount,
        now,
      });

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, md, 'utf-8');

      const linked = toTerminalHyperlink(outputPath, pathToFileURL(outputPath).href);
      this.showNotice(`Exported ${String(context.history.length)} messages`, linked);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to export session: ${msg}`);
    }
  }

  private async handleExportDebugZipCommand(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    this.showStatus('Exporting session…');
    try {
      const installSource = await detectInstallSource();
      const shellEnv = detectShellEnvironment();
      const result = await this.harness.exportSession({
        id: session.id,
        version: this.state.appState.version,
        installSource,
        shellEnv,
        includeGlobalLog: true,
      });
      const linked = toTerminalHyperlink(result.zipPath, pathToFileURL(result.zipPath).href);
      this.showNotice('Export complete', linked);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to export session: ${msg}`);
    }
  }

  private forkSourceTitle(session: Session): string {
    const currentTitle = this.state.appState.sessionTitle?.trim();
    if (currentTitle !== undefined && currentTitle.length > 0) return currentTitle;

    const summaryTitle =
      typeof session.summary?.title === 'string' ? session.summary.title.trim() : '';
    return summaryTitle.length > 0 ? summaryTitle : session.id;
  }

  // Handles the /yolo command.
  private async handleYoloCommand(args: string): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    let enabled: boolean;
    if (args === 'on') enabled = true;
    else if (args === 'off') enabled = false;
    else enabled = !this.state.appState.yolo;

    await session.setPermission(enabled ? 'yolo' : 'manual');
    this.setAppState({ yolo: enabled, permissionMode: enabled ? 'yolo' : 'manual' });
    if (enabled) {
      this.showNotice(
        'YOLO mode: ON',
        'All actions will be approved automatically. Use with caution.',
      );
      return;
    }
    this.showNotice('YOLO mode: OFF');
  }

  // Handles the /plan command.
  private async handlePlanCommand(args: string): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    const subcmd = args.trim().toLowerCase();
    if (subcmd === 'clear') {
      await session.clearPlan();
      this.showNotice('Plan cleared');
      return;
    }

    let enabled: boolean;
    if (subcmd.length === 0) enabled = !this.state.appState.planMode;
    else if (subcmd === 'on') enabled = true;
    else if (subcmd === 'off') enabled = false;
    else {
      this.showError(`Unknown plan subcommand: ${subcmd}`);
      return;
    }

    await this.applyPlanMode(session, enabled);
  }

  // Handles the /compact command.
  private async handleCompactCommand(args: string): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    const customInstruction = args.trim() || undefined;
    await session.compact({ instruction: customInstruction });
  }

  // Handles the /init command.
  private async handleInitCommand(): Promise<void> {
    const session = this.session;
    if (this.state.appState.model.trim().length === 0 || session === undefined) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }

    this.deferUserMessages = true;
    this.beginSessionRequest();
    try {
      await session.init();
      this.track('init_complete');
      this.finalizeTurn((item) => {
        this.sendQueuedMessage(session, item);
      });
    } catch (error) {
      if (isAbortError(error)) {
        this.setAppState({ isStreaming: false, streamingPhase: 'idle' });
        this.resetLivePane();
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.failSessionRequest(`Init failed: ${msg}`);
    } finally {
      this.deferUserMessages = false;
    }
  }

  // Handles the /login command.
  private async handleLoginCommand(): Promise<void> {
    const platformId = await this.promptPlatformSelection();
    if (platformId === undefined) return;

    if (platformId === 'kimi-code') {
      await this.handleKimiCodeOAuthLogin();
      return;
    }

    const platform = getOpenPlatformById(platformId);
    if (platform === undefined) return;
    await this.handleOpenPlatformLogin(platform);
  }

  // Kimi Code OAuth login flow.
  private async handleKimiCodeOAuthLogin(): Promise<void> {
    const status = await this.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
    const alreadyLoggedIn = status.providers.some(
      (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
    );

    let spinner: LoginProgressSpinnerHandle | undefined;
    const controller = new AbortController();
    const cancelLogin = (): void => {
      controller.abort();
    };
    this.cancelInFlight = cancelLogin;
    try {
      await this.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
        signal: controller.signal,
        onDeviceCode: (data) => {
          spinner = this.showLoginAuthorizationPrompt(data);
        },
      });
      spinner?.stop({ ok: true, label: 'Logged in.' });
      spinner = undefined;
      try {
        await this.refreshConfigAfterLogin();
      } catch (refreshError) {
        const message = formatErrorMessage(refreshError);
        this.showError(`Authentication successful, but failed to refresh config: ${message}`);
        return;
      }
      this.track('login', {
        provider: DEFAULT_OAUTH_PROVIDER_NAME,
        already_logged_in: alreadyLoggedIn,
      });
      if (alreadyLoggedIn) {
        this.showStatus('Already logged in. Model configuration refreshed.');
      }
    } catch (error) {
      const cancelled = controller.signal.aborted;
      spinner?.stop({
        ok: false,
        label: cancelled ? 'Login cancelled.' : 'Login failed.',
      });
      spinner = undefined;
      if (cancelled) return;
      log.warn('login failed', {
        providerName: DEFAULT_OAUTH_PROVIDER_NAME,
        alreadyLoggedIn,
        sessionId: this.session?.id,
        error,
      });
      const message = formatErrorMessage(error);
      this.showError(`Login failed: ${message}`);
    } finally {
      if (this.cancelInFlight === cancelLogin) {
        this.cancelInFlight = undefined;
      }
    }
  }

  // Open platform API key login flow.
  private async handleOpenPlatformLogin(
    platform: OpenPlatformDefinition,
  ): Promise<void> {
    const apiKey = await this.promptApiKey(platform.name);
    if (apiKey === undefined) return;

    const controller = new AbortController();
    const cancelLogin = (): void => {
      controller.abort();
    };
    this.cancelInFlight = cancelLogin;

    let models: ManagedKimiCodeModelInfo[];
    try {
      models = await fetchOpenPlatformModels(platform, apiKey, fetch, controller.signal);
      models = filterModelsByPrefix(models, platform);
    } catch (error) {
      if (controller.signal.aborted) return;
      const msg = formatErrorMessage(error);
      this.showError(`Failed to verify API key: ${msg}`);
      if (
        error instanceof OpenPlatformApiError &&
        error.status === 401
      ) {
        this.showStatus(
          'Hint: If your API key was obtained from Kimi Code, please select "Kimi Code" instead.',
        );
      }
      return;
    } finally {
      if (this.cancelInFlight === cancelLogin) {
        this.cancelInFlight = undefined;
      }
    }

    if (models.length === 0) {
      this.showError('No models available for this platform.');
      return;
    }

    const selection = await this.promptModelSelectionForOpenPlatform(models, platform);
    if (selection === undefined) return;

    // Remove stale provider config first so old model aliases are fully
    // cleared (setConfig patch merge cannot delete nested keys).
    const existingConfig = await this.harness.getConfig();
    if (existingConfig.providers[platform.id] !== undefined) {
      await this.harness.removeProvider(platform.id);
    }

    const config = await this.harness.getConfig();
    applyOpenPlatformConfig(config as ManagedKimiConfigShape, {
      platform,
      models,
      selectedModel: selection.model,
      thinking: selection.thinking,
      apiKey,
    });

    await this.harness.setConfig({
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      defaultThinking: config.defaultThinking,
    });

    await this.refreshConfigAfterLogin();
    this.track('login', { provider: platform.id, method: 'api_key' });
    this.showStatus(`Setup complete: ${platform.name} · ${selection.model.id}`);
  }

  // Handles the /connect command — fetches a model catalog (default
  // models.dev), lets the user pick a provider + model, prompts for an API
  // key, then writes the provider config + model aliases. Model metadata
  // (context size, capabilities) comes from the catalog, so users do not
  // hand-write it.
  private async handleConnectCommand(args: string): Promise<void> {
    const resolution = resolveConnectCatalogRequest(args);
    if (resolution.kind === 'error') {
      this.showError(resolution.message);
      return;
    }
    const { url, preferBuiltIn, allowBuiltInFallback } = resolution.request;

    let catalog: Catalog | undefined;

    // Default path: serve the bundled catalog so /connect works without a
    // live network and is not gated by models.dev availability. The source
    // placeholder is undefined in dev builds, so dev falls through to fetch.
    if (preferBuiltIn) {
      const builtIn = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
      if (builtIn !== undefined) {
        this.showStatus('Loaded built-in catalog. Run /connect refresh for the latest.');
        catalog = builtIn;
      }
    }

    if (catalog === undefined) {
      const controller = new AbortController();
      const cancel = (): void => {
        controller.abort();
      };
      this.cancelInFlight = cancel;

      const spinner = this.showLoginProgressSpinner(`Fetching catalog from ${url}`);
      try {
        catalog = await fetchCatalog(url, controller.signal);
        spinner.stop({ ok: true, label: 'Catalog loaded.' });
      } catch (error) {
        if (controller.signal.aborted) {
          spinner.stop({ ok: false, label: 'Aborted.' });
        } else {
          const hint = error instanceof CatalogFetchError ? ` (HTTP ${error.status})` : '';
          if (!allowBuiltInFallback) {
            spinner.stop({ ok: false, label: 'Failed to load catalog.' });
            this.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
          } else {
            const fallback = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
            if (fallback !== undefined) {
              spinner.stop({ ok: true, label: 'Using built-in catalog (offline mode).' });
              catalog = fallback;
            } else {
              spinner.stop({ ok: false, label: 'Failed to load catalog.' });
              this.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
            }
          }
        }
      } finally {
        if (this.cancelInFlight === cancel) this.cancelInFlight = undefined;
      }
    }

    if (catalog === undefined) return;

    const providerId = await this.promptCatalogProviderSelection(catalog);
    if (providerId === undefined) return;
    const entry = catalog[providerId];
    if (entry === undefined) return;

    const models = catalogProviderModels(entry);
    if (models.length === 0) {
      this.showError(`Provider "${providerId}" has no usable models in this catalog.`);
      return;
    }

    const selection = await this.promptModelSelectionForCatalog(providerId, models);
    if (selection === undefined) return;

    const apiKey = await this.promptApiKey(entry.name ?? providerId);
    if (apiKey === undefined) return;

    const wire = inferWireType(entry);
    if (wire === undefined) return;
    const baseUrl = catalogBaseUrl(entry, wire);

    // Remove stale provider config first: setConfig is a deep-merge patch that
    // cannot delete keys, and applyCatalogProvider's in-memory cleanup below
    // does not survive that merge — removeProvider is the only step that
    // actually drops old model aliases from disk.
    const existingConfig = await this.harness.getConfig();
    if (existingConfig.providers[providerId] !== undefined) {
      await this.harness.removeProvider(providerId);
    }

    const config = await this.harness.getConfig();
    applyCatalogProvider(config, {
      providerId,
      wire,
      baseUrl,
      apiKey,
      models,
      selectedModelId: selection.model.id,
      thinking: selection.thinking,
    });

    await this.harness.setConfig({
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      defaultThinking: config.defaultThinking,
    });

    await this.refreshConfigAfterLogin();
    this.track('connect', { provider: providerId, model: selection.model.id });
    this.showStatus(`Connected: ${entry.name ?? providerId} · ${selection.model.id}`);
  }

  // Handles the /feedback command — opens an inline input dialog and POSTs
  // the result to the managed Kimi Code platform. Falls back to the GitHub
  // Issues page when the user is not signed in or the request fails.
  private async handleFeedbackCommand(): Promise<void> {
    const fallback = (reason: string): void => {
      this.showStatus(reason);
      this.showStatus(FEEDBACK_ISSUE_URL);
      openUrl(FEEDBACK_ISSUE_URL);
    };

    const providerKey = this.state.appState.availableModels[this.state.appState.model]?.provider;
    if (!isManagedUsageProvider(providerKey)) {
      fallback(FEEDBACK_STATUS_NOT_SIGNED_IN);
      return;
    }

    const content = await this.promptFeedbackInput();
    if (content === undefined) {
      this.showStatus(FEEDBACK_STATUS_CANCELLED);
      return;
    }

    const spinner = this.showLoginProgressSpinner(FEEDBACK_STATUS_SUBMITTING);
    const res = await this.harness.auth.submitFeedback({
      content,
      sessionId: this.state.appState.sessionId,
      version: withFeedbackVersionPrefix(this.state.appState.version),
      os: `${osType()} ${osRelease()}`,
      model: this.state.appState.model.length > 0 ? this.state.appState.model : null,
    });

    if (res.kind === 'ok') {
      spinner.stop({ ok: true, label: FEEDBACK_STATUS_SUCCESS });
      this.showStatus(feedbackSessionLine(this.state.appState.sessionId));
      this.track(FEEDBACK_TELEMETRY_EVENT);
      return;
    }

    spinner.stop({ ok: false, label: res.message });
    fallback(FEEDBACK_STATUS_FALLBACK);
  }

  // Mounts the feedback input dialog and resolves with the trimmed value
  // when submitted, or undefined when the user cancels.
  private promptFeedbackInput(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const dialog = new FeedbackInputDialogComponent((result: FeedbackInputDialogResult) => {
        this.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      }, this.state.theme.colors);
      this.mountEditorReplacement(dialog);
    });
  }

  // Handles the /logout command. Lists every credential currently held — the
  // Kimi Code OAuth token (or a stale config entry for it) plus each configured
  // API-key provider — and lets the user pick which one to drop. OAuth tokens
  // go through auth.logout for proper revocation, everything else through
  // removeProvider.
  private async handleLogoutCommand(): Promise<void> {
    const oauthStatus = await this.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
    const hasOAuthToken = oauthStatus.providers.some(
      (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
    );
    const config = await this.harness.getConfig();
    // Offer the managed provider whenever something points at it — either a
    // live OAuth token or a stale providers[] entry left over from a previous
    // login. auth.logout cleans the config regardless of whether the token
    // is still present, so this avoids leaving residue with no way to reach it.
    const hasManagedRemnant =
      hasOAuthToken || config.providers[DEFAULT_OAUTH_PROVIDER_NAME] !== undefined;
    const apiKeyProviderIds = Object.keys(config.providers ?? {})
      .filter((id) => id !== DEFAULT_OAUTH_PROVIDER_NAME)
      .toSorted();

    const options: ChoiceOption[] = [];
    if (hasManagedRemnant) {
      options.push({
        value: DEFAULT_OAUTH_PROVIDER_NAME,
        label: PRODUCT_NAME,
        description: 'OAuth login',
      });
    }
    for (const id of apiKeyProviderIds) {
      const baseUrl = config.providers[id]?.baseUrl;
      options.push({
        value: id,
        label: id,
        description: typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined,
      });
    }

    if (options.length === 0) {
      this.showStatus('Nothing to logout.');
      return;
    }

    const currentModel = this.state.appState.model.trim();
    const currentProvider = this.state.appState.availableModels[currentModel]?.provider;

    const target = await this.promptLogoutProviderSelection(options, currentProvider);
    if (target === undefined) return;

    if (target === DEFAULT_OAUTH_PROVIDER_NAME) {
      await this.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
    } else {
      await this.harness.removeProvider(target);
    }

    if (target === currentProvider) {
      // The active session is backed by the provider we just removed, so it
      // can no longer make requests — tear it down along with the model state.
      await this.refreshConfigAfterLogout();
      await this.clearActiveSessionAfterLogout();
    } else {
      // Refresh provider/model listings so the picker reflects the change,
      // but leave the user's current session running.
      const updated = await this.harness.getConfig({ reload: true });
      this.setAppState({
        availableModels: updated.models ?? {},
        availableProviders: updated.providers ?? {},
      });
    }

    this.track('logout', { provider: target });
    const label = target === DEFAULT_OAUTH_PROVIDER_NAME ? PRODUCT_NAME : target;
    this.showStatus(`Logged out from ${label}.`);
  }

  private promptLogoutProviderSelection(
    options: readonly ChoiceOption[],
    currentValue: string | undefined,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const picker = new ChoicePickerComponent({
        title: 'Select a provider to log out',
        options,
        currentValue,
        colors: this.state.theme.colors,
        onSelect: (value) => {
          this.restoreEditor();
          resolve(value);
        },
        onCancel: () => {
          this.restoreEditor();
          resolve(undefined);
        },
      });
      this.mountEditorReplacement(picker);
    });
  }

  // ---------------------------------------------------------------------------
  // Login / setup prompts
  // ---------------------------------------------------------------------------

  private promptPlatformSelection(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const selector = new PlatformSelectorComponent({
        colors: this.state.theme.colors,
        onSelect: (platformId) => {
          this.restoreEditor();
          resolve(platformId);
        },
        onCancel: () => {
          this.restoreEditor();
          resolve(undefined);
        },
      });
      this.mountEditorReplacement(selector);
    });
  }

  private promptCatalogProviderSelection(catalog: Catalog): Promise<string | undefined> {
    return new Promise((resolve) => {
      const options: ChoiceOption[] = Object.entries(catalog)
        .filter(([, entry]) => inferWireType(entry) !== undefined)
        .map(([id, entry]) => ({
          value: id,
          label: entry.name ?? id,
          description:
            typeof entry.api === 'string' && entry.api.length > 0 ? entry.api : undefined,
        }))
        .toSorted((a, b) => a.label.localeCompare(b.label));

      if (options.length === 0) {
        this.showError('Catalog has no providers with supported wire types.');
        resolve(undefined);
        return;
      }

      const picker = new ChoicePickerComponent({
        title: 'Select a provider',
        options,
        colors: this.state.theme.colors,
        searchable: true,
        onSelect: (value) => {
          this.restoreEditor();
          resolve(value);
        },
        onCancel: () => {
          this.restoreEditor();
          resolve(undefined);
        },
      });
      this.mountEditorReplacement(picker);
    });
  }

  private promptApiKey(platformName: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const dialog = new ApiKeyInputDialogComponent(
        platformName,
        (result: ApiKeyInputResult) => {
          this.restoreEditor();
          resolve(result.kind === 'ok' ? result.value : undefined);
        },
        this.state.theme.colors,
      );
      this.mountEditorReplacement(dialog);
    });
  }

  private async promptModelSelectionForOpenPlatform(
    models: ManagedKimiCodeModelInfo[],
    platform: OpenPlatformDefinition,
  ): Promise<{ model: ManagedKimiCodeModelInfo; thinking: boolean } | undefined> {
    const modelDict: Record<string, ModelAlias> = {};
    for (const m of models) {
      modelDict[`${platform.id}/${m.id}`] = {
        provider: platform.id,
        model: m.id,
        maxContextSize: m.contextLength,
        capabilities: capabilitiesForModel(m),
        displayName: m.displayName,
      };
    }
    const selection = await this.runModelSelector(modelDict);
    if (selection === undefined) return undefined;
    const model = models.find((m) => `${platform.id}/${m.id}` === selection.alias);
    return model ? { model, thinking: selection.thinking } : undefined;
  }

  private async promptModelSelectionForCatalog(
    providerId: string,
    models: CatalogModel[],
  ): Promise<{ model: CatalogModel; thinking: boolean } | undefined> {
    const modelDict: Record<string, ModelAlias> = {};
    for (const m of models) {
      modelDict[`${providerId}/${m.id}`] = catalogModelToAlias(providerId, m);
    }
    const selection = await this.runModelSelector(modelDict);
    if (selection === undefined) return undefined;
    const model = models.find((m) => `${providerId}/${m.id}` === selection.alias);
    return model ? { model, thinking: selection.thinking } : undefined;
  }

  private runModelSelector(
    modelDict: Record<string, ModelAlias>,
  ): Promise<{ alias: string; thinking: boolean } | undefined> {
    return new Promise((resolve) => {
      const firstAlias = Object.keys(modelDict)[0] ?? '';
      const caps = modelDict[firstAlias]?.capabilities ?? [];
      const initialThinking = caps.includes('always_thinking') || caps.includes('thinking');
      const selector = new ModelSelectorComponent({
        models: modelDict,
        currentValue: firstAlias,
        currentThinking: initialThinking,
        colors: this.state.theme.colors,
        searchable: true,
        onSelect: ({ alias, thinking }) => {
          this.restoreEditor();
          resolve({ alias, thinking });
        },
        onCancel: () => {
          this.restoreEditor();
          resolve(undefined);
        },
      });
      this.mountEditorReplacement(selector);
    });
  }
}

function resolvePluginInstallSource(source: string, workDir: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed === '~') return osHomedir();
  if (trimmed.startsWith('~/')) return join(osHomedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(workDir, trimmed);
}
