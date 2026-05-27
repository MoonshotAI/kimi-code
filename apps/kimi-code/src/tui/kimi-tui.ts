/**
 * KimiTUI owns the terminal UI shell for a Kimi Code session.
 *
 * It builds the pi-tui layout, tracks view state, wires editor shortcuts and
 * slash commands, drives session startup/switching, renders SDK events into the
 * transcript and live panes, and bridges approval, question, auth, and config
 * flows back to the harness.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CreateSessionOptions,
  Event,
  KimiHarness,
  PermissionMode,
  PromptPart,
  Session,
  SessionStatus,
  SessionUsage,
} from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import type { CLIOptions } from '#/cli/options';
import { MigrationScreenComponent, type MigrationScreenResult } from '#/migration/index';
import { ClipboardMediaError, readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import type { GitLsFilesCache } from '#/utils/git/git-ls-files';
import { createGitLsFilesCache } from '#/utils/git/git-ls-files';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { parseImageMeta } from '#/utils/image/image-mime';
import { getInputHistoryFile } from '#/utils/paths';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';
import { detectFdPath } from '#/utils/process/fd-detect';

import {
  BUILTIN_SLASH_COMMANDS,
  buildSkillSlashCommands,
  sortSlashCommands,
  type KimiSlashCommand,
  type SkillListSession,
} from './commands';
import { DeviceCodeBoxComponent } from './components/chrome/device-code-box';
import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import { CHROME_GUTTER } from './constant/rendering';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import { WelcomeComponent } from './components/chrome/welcome';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from './components/dialogs/approval-panel';
import { CompactionComponent } from './components/dialogs/compaction';
import { HelpPanelComponent } from './components/dialogs/help-panel';
import { QuestionDialogComponent } from './components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from './components/dialogs/session-picker';
import { AuthFlowController } from './controllers/auth-flow';
import { SessionEventHandler } from './controllers/session-event-handler';
import * as slashCommands from './controllers/slash-commands';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StreamingUIController } from './controllers/streaming-ui';
import { TasksBrowserController, type TasksBrowserState } from './controllers/tasks-browser';
import { CustomEditor } from './components/editor/custom-editor';
import { FileMentionProvider } from './components/editor/file-mention-provider';
import { AgentGroupComponent } from './components/messages/agent-group';
import { AssistantMessageComponent } from './components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from './components/messages/background-agent-status';
import { ReadGroupComponent } from './components/messages/read-group';
import { SkillActivationComponent } from './components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { ThinkingComponent } from './components/messages/thinking';
import { ToolCallComponent } from './components/messages/tool-call';
import type { ManagedUsageReport } from './components/messages/usage-panel';
import { UserMessageComponent } from './components/messages/user-message';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { TuiConfig } from './config';
import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  EXIT_CONFIRM_WINDOW_MS,
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  NO_ACTIVE_SESSION_MESSAGE,
  OAUTH_LOGIN_REQUIRED_CODE,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
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
  tasksBrowser: TasksBrowserState | undefined;
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

export interface LoginProgressSpinnerHandle {
  /** Stops the login progress row and replaces it with a final status. */
  stop(opts: { ok: boolean; label: string }): void;
}

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  state: TUIState;
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private skillCommands: readonly KimiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  private readonly fdPath: string | null = detectFdPath();
  private readonly gitLsFilesCache: GitLsFilesCache;
  sessionEventUnsubscribe: (() => void) | undefined;
  private pendingExit: PendingExit | null = null;
  cancelInFlight: (() => void) | undefined;
  // Queues editor messages instead of sending or steering them. Used by /init.
  deferUserMessages = false;
  aborted = false;
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
  readonly streamingUI: StreamingUIController;
  readonly authFlow: AuthFlowController;
  private readonly sessionEventHandler: SessionEventHandler;
  private readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;

  public onExit?: (exitCode?: number) => Promise<void>;

  track(
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
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
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
  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
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
    await this.authFlow.refreshAvailableModels();

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
      this.authFlow.enterLoginRequiredStartupState();
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
    this.streamingUI.discardPending();
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
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
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
      void slashCommands.handlePlanCommand(this, next ? 'on' : 'off');
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

  private handleUserInput(text: string): void {
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError('Cannot send input while session history is replaying.');
      return;
    }
    void this.persistInputHistory(text);
    slashCommands.dispatchInput(this, text);
  }

  // Sends regular user input after validating model and media support.
  sendNormalUserInput(text: string): void {
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
  beginSessionRequest(): void {
    this.state.currentTurnId = undefined;
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();

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
  failSessionRequest(message: string): void {
    this.setAppState({ isStreaming: false, streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  // Sends a queued message after restoring the agent target captured at enqueue time.
  sendQueuedMessage(session: Session, item: QueuedMessage): void {
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
  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void {
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

  // =========================================================================
  // State Helpers
  // =========================================================================

  // Applies app-state changes and refreshes dependent UI surfaces.
  setAppState(patch: Partial<AppState>): void {
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
  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  // Restores the live pane to its initial idle state.
  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  // =========================================================================
  // Session Runtime
  // =========================================================================

  // Returns the active session or raises the standard no-session error.
  requireSession(): Session {
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
  async setSession(session: Session): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    this.session = session;
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
  }

  // Pulls runtime session status into the app state.
  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
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
  async closeSession(reason: string): Promise<void> {
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
  async fetchSessions(): Promise<void> {
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
  refreshSessionTitle(): void {
    setProcessTitle(this.state.appState.sessionTitle, this.state.appState.sessionId);
  }

  // Resets turn, tool, queue, and background-agent state for a session switch.
  resetSessionRuntime(): void {
    this.aborted = false;
    this.streamingUI.discardPending();
    this.state.queuedMessages = [];
    this.harness.interactiveAgentId = MAIN_AGENT_ID;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.state.backgroundAgents.clear();
    this.state.backgroundAgentMetadata.clear();
    this.state.backgroundTasks.clear();
    this.state.backgroundTaskTranscriptedTerminal.clear();
    this.tasksBrowserController.close();
    this.state.subagentParentToolCallIds.clear();
    this.state.subagentNames.clear();
    this.state.renderedSkillActivationIds.clear();
    this.state.renderedMcpServerStatusKeys.clear();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.streamingUI.setTodoList([]);
    this.state.currentTurnId = undefined;
    this.state.currentStep = 0;
    this.streamingUI.resetLiveText();
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
  async switchToSession(session: Session, statusMessage: string): Promise<void> {
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
  async createNewSession(): Promise<void> {
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
  // Session Replay — delegated to SessionReplayRenderer
  // =========================================================================

  private hydrateTranscriptFromReplay(session: Session): Promise<boolean> {
    return this.sessionReplay.hydrateFromReplay(session);
  }

  // =========================================================================
  // Session Events — delegated to SessionEventHandler
  // =========================================================================

  startSessionEventSubscription(): void { this.sessionEventHandler.startSubscription(); }

  private handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    this.sessionEventHandler.handleEvent(event, sendQueued);
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
  appendTranscriptEntry(entry: TranscriptEntry): void {
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
  disposeActiveThinkingComponent(): void {
    if (this.state.activeThinkingComponent !== undefined) {
      this.state.activeThinkingComponent.dispose();
      this.state.activeThinkingComponent = undefined;
    }
  }

  // Disposes and forgets all pending live tool-call components.
  disposeAndClearPendingToolComponents(): void {
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
    this.streamingUI.discardPending();
    this.state.transcriptEntries = [];
    this.disposeActiveCompactionBlock();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.state.transcriptContainer.clear();
    this.clearTerminalInlineImages();
    this.state.todoPanel.clear();
    this.state.todoPanelContainer.clear();
    this.imageStore.clear();
    this.renderWelcome();
  }

  // Appends a status message to the transcript.
  showStatus(message: string, color?: string): void {
    this.state.transcriptContainer.addChild(
      new StatusMessageComponent(message, this.state.theme.colors, color),
    );
    this.state.ui.requestRender();
  }

  // Appends a notice message to the transcript.
  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(
      new NoticeMessageComponent(title, detail, this.state.theme.colors),
    );
    this.state.ui.requestRender();
  }

  // Appends an error status message to the transcript.
  showError(message: string): void {
    this.showStatus(`Error: ${message}`, this.state.theme.colors.error);
  }

  // Adds an animated login progress row to the transcript.
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
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
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
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
  updateActivityPane(): void {
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
  updateQueueDisplay(): void {
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
  applyTheme(theme: Theme, resolved?: ResolvedTheme): void {
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
  refreshTerminalThemeTracking(): void {
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
  mountEditorReplacement(panel: Component & Focusable): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(panel);
    this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
  }

  // Restores the main editor after a dialog or selector closes.
  restoreEditor(): void {
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
  showHelpPanel(): void {
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
  async showSessionPicker(): Promise<void> {
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
    );
    this.mountEditorReplacement(panel);
  }

  // Hides the active approval panel.
  private hideApprovalPanel(): void {
    this.patchLivePane({ pendingApproval: null });
    this.restoreEditor();
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
  // Slash Command Handlers — delegated to controllers/slash-commands.ts
  // =========================================================================

}
