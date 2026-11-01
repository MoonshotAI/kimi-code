import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import { ErrorCodes, log } from '@moonshot-ai/kimi-code-sdk';
import type {
  ApprovalRequest,
  ApprovalResponse,
  BackgroundTaskInfo,
  CompactionStartedEvent,
  CreateSessionOptions,
  KimiHarness,
  PermissionMode,
  PluginCommandDef,
  PromptPart,
  Session,
  SkillSummary,
  TokenUsage,
  TurnEndedEvent,
  TurnStartedEvent,
  Unsubscribe,
  WorkspaceTrustInfo,
} from '@moonshot-ai/kimi-code-sdk';
import { isTelemetryDisabledByEnv } from '@moonshot-ai/kimi-telemetry';
import type { MigrationPlan } from '@moonshot-ai/migration-legacy';
import {
  deleteAllKittyImages,
  type Component,
  type Focusable,
  getCapabilities,
  Key,
  matchesKey,
  Spacer,
  TuiAltScreen,
  TuiMainScreen,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import { resolve } from 'pathe';

import type { CLIOptions } from '#/cli/options';
import { MigrationScreenComponent, type MigrationScreenResult } from '#/migration/index';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { openUrl } from '#/utils/open-url';
import { getInputHistoryFile } from '#/utils/paths';
import { refreshModelSwitchConfirmConfig } from '#/utils/model-switch-confirm-config';
import { applyRecommendedEffort } from '#/utils/recommended-effort';
import { getRecommendedEffortConfig } from '#/utils/recommended-effort-config';
import { migrateLegacySurveySetting } from '#/utils/survey-setting';
import { detectFdPath, ensureFdPath } from '#/utils/process/fd-detect';
import { quoteShellArg } from '#/utils/shell-quote';
import { restoreTerminalModes } from '#/utils/terminal-restore';

import { BannerProvider } from './banner/banner-provider';
import { resolveBannerAudienceContext, type BannerAudienceContext } from './banner/audience';
import { readBannerDisplayState, writeBannerDisplayState } from './banner/state';
import {
  BUILTIN_SLASH_COMMANDS,
  buildPluginSlashCommands,
  buildSkillSlashCommands,
  goalObjectiveLengthWarning,
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
  sortSlashCommands,
  type KimiSlashCommand,
  type SkillListSession,
} from './commands';
import * as slashCommands from './commands/dispatch';
import { promptSshPassword } from './commands/prompts';
import { CacheHintController } from './controllers/cache-hint-controller';
import { BannerComponent } from './components/chrome/banner';
import { DeviceCodeBoxComponent } from './components/chrome/device-code-box';
import { GutterContainer } from './components/chrome/gutter-container';
import { MoonLoader, type SpinnerStyle } from './components/chrome/moon-loader';
import { WelcomeComponent } from './components/chrome/welcome';
import { pickRandomWorkingTip } from './components/chrome/working-tips';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from './components/dialogs/approval-panel';
import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from './components/dialogs/approval-preview';
import { CompactionComponent } from './components/dialogs/compaction';
import { HelpPanelComponent } from './components/dialogs/help-panel';
import { QuestionDialogComponent } from './components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from './components/dialogs/session-picker';
import { TrustPromptComponent, type TrustPromptChoice } from './components/dialogs/trust-prompt';
import {
  FileMentionProvider,
  resolveMentionDirectory,
  type SlashAutocompleteCommand,
} from './components/editor/file-mention-provider';
import { AssistantMessageComponent } from './components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from './components/messages/background-agent-status';
import { CronMessageComponent } from './components/messages/cron-message';
import { buildGoalMarker } from './components/messages/goal-markers';
import {
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
} from './components/messages/goal-panel';
import { PluginCommandComponent } from './components/messages/plugin-command';
import { ShellRunComponent } from './components/messages/shell-run';
import { SkillActivationComponent } from './components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from './components/messages/status-message';
import { StepSummaryComponent } from './components/messages/step-summary';
import { ThinkingComponent } from './components/messages/thinking';
import { ToolCallComponent } from './components/messages/tool-call';
import {
  ReplayTurnBoundaryComponent,
  UserMessageComponent,
} from './components/messages/user-message';
import { ActivityPaneComponent, type ActivityPaneMode } from './components/panes/activity-pane';
import { removeLegacySurveySetting, type TuiConfig } from './config';
import {
  LLM_NOT_SET_MESSAGE,
  MAIN_AGENT_ID,
  MAX_AUTO_TITLE_ATTEMPTS,
  NO_ACTIVE_SESSION_MESSAGE,
  PRODUCT_NAME,
  SESSION_LIST_PAGE_SIZE,
  SESSIONLESS_STARTUP_NOTICE,
  SHUTTING_DOWN_HINT,
} from './constant/kimi-tui';
import { MEDIA_INGESTION_SUBMIT_WAIT_MS } from './constant/media';
import { CHROME_GUTTER, DOCK_APPROVAL_ROWS } from './constant/rendering';
import { MAX_TERMINAL_TITLE_LENGTH } from './constant/terminal';
import { AuthFlowController } from './controllers/auth-flow';
import { BtwPanelController } from './controllers/btw-panel';
import { ClipboardImageHintController } from './controllers/clipboard-image-hint';
import { EditorKeyboardController } from './controllers/editor-keyboard';
import { ModelMigrationController } from './controllers/model-migration';
import { ProgramStatusController } from './controllers/program-status';
import { SessionEventHandler } from './controllers/session-event-handler';
import { showSessionOccupancyPrompt } from './controllers/session-occupancy';
import { SessionReplayRenderer } from './controllers/session-replay';
import { StagingLeaseTracker, type StagingLease } from './controllers/staging-leases';
import { StreamingUIController } from './controllers/streaming-ui';
import { SurveyController } from './controllers/survey-controller';
import { TasksBrowserController } from './controllers/tasks-browser';
import { installRainbowDance } from './easter-eggs/dance';
import { adaptPanelResponse } from './reverse-rpc/approval/adapter';
import { ApprovalController } from './reverse-rpc/approval/controller';
import { createApprovalRequestHandler } from './reverse-rpc/approval/handler';
import { registerReverseRPCHandlers } from './reverse-rpc/index';
import type { ReverseRpcModalOwner } from './reverse-rpc/modal-coordinator';
import { QuestionController } from './reverse-rpc/question/controller';
import { createQuestionAskHandler } from './reverse-rpc/question/handler';
import type { ApprovalPanelData, QuestionPanelData } from './reverse-rpc/types';
import { currentTheme, getColorPalette, getBuiltInPalette } from './theme';
import type { ColorToken, ResolvedTheme, ThemeName } from './theme';
import { createTUIState, mountFooter, setEditorSlot, type TUIState } from './tui-state';
import {
  INITIAL_LIVE_PANE,
  sumTokenUsage,
  type AppState,
  type InlineSkillActivation,
  type PreparedSkillActivations,
  type KimiTUIOptions,
  type LivePaneState,
  type LoginProgressSpinnerHandle,
  type QueuedMessage,
  type EnvironmentSlotState,
  type SteerInputItem,
  type StepRetryState,
  type TranscriptEntry,
  type TUIStartupOptions,
  type TUIStartupState,
} from './types';
import {
  countedByExpandHint,
  hasDispose,
  hasHiddenContent,
  isExpandable,
  isExpandedComponent,
} from './utils/component-capabilities';
import { isDeadTerminalError } from './utils/dead-terminal';
import { formatErrorMessage } from './utils/event-payload';
import { pickForegroundTasks } from './utils/foreground-task';
import { ImageAttachmentStore, type ImageAttachment, type MediaAttachment } from './utils/image-attachment-store';
import {
  extractMediaAttachments,
  omitExpiredVideoFileRefs,
  pendingMediaIngestions,
  refreshExpiringImageFileRefs,
  resolveSessionOriginalCaptions,
  rewriteMediaPlaceholders,
} from './utils/image-placeholder';
import type { ExtractionResult } from './utils/image-placeholder';
import { installInputLatencyProbe } from './utils/input-latency';
import { combineSteerInput } from './utils/steer-input';
import { startupTrace } from '#/utils/startup-trace';
import { REPLAY_FETCH_TURN_LIMIT } from './utils/message-replay';
import { hasPatchChanges } from './utils/object-patch';
import { beginScreenTakeover, endScreenTakeover, type ScreenTakeover } from './utils/screen-takeover';
import { sessionRowsForPicker } from './utils/session-picker-rows';
import { isSessionOccupiedError } from './utils/session-lock-errors';
import { formatStepRetryDetail, formatStepRetryLabel } from './utils/step-retry';
import { formatBashOutputForDisplay } from './utils/shell-output';
import { lazyModelSelection } from './utils/model-switch';
import { combineStartupNotice, isOAuthLoginRequiredError } from './utils/startup';
import { installTerminalFocusTracking } from './utils/terminal-focus';
import { notifyTerminalOnce } from './utils/terminal-notification';
import { installTerminalThemeTracking } from './utils/terminal-theme';
import { detectTmuxKeyboardWarning } from './utils/tmux-keyboard';
import {
  getTranscriptComponentEntry,
  markTranscriptComponent,
} from './utils/transcript-component-metadata';
import { nextTranscriptId } from './utils/transcript-id';
import {
  expandCutoffIndex,
  TRANSCRIPT_EXPAND_TURNS,
  TRANSCRIPT_HYSTERESIS,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_WINDOW_ENABLED,
  groupTurns,
  turnsToTrim,
} from './utils/transcript-window';

export type { TUIState } from './tui-state';
export { createTUIState } from './tui-state';
export type {
  KimiTUIOptions,
  LoginProgressSpinnerHandle,
  TUIStartupOptions,
  TUIStartupState,
} from './types';

export interface KimiTUIStartupInput {
  readonly cliOptions: CLIOptions;
  /** Profile name resolved from cliOptions --agent/--agent-file (see resolveAgentProfileSelection). */
  readonly agentProfile?: string;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
  readonly migrationPlan?: MigrationPlan | null;
  /** When true, run only the migration screen, then exit (the `kimi migrate` command). */
  readonly migrateOnly?: boolean;
  readonly telemetryDisabled?: boolean;
}

type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';
type LoadingTipKind = 'moon' | 'braille';

function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing' || mode === 'thinking' || mode === 'compacting') return 'braille';
  return undefined;
}

function waitingSpinnerLabel(retry: StepRetryState | null): string {
  return retry === null ? '' : formatStepRetryLabel(retry);
}

function sameStringArrays(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

function createInitialAppState(input: KimiTUIStartupInput): AppState {
  const startupPermission: PermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    model: '',
    workDir: input.workDir,
    additionalDirs: [...(input.additionalDirs ?? [])],
    sessionId: '',
    permissionMode: startupPermission,
    planMode: input.cliOptions.plan,
    inputMode: 'prompt',
    swarmMode: false,
    towerMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    cumulativeTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    stepRetry: null,
    theme: input.tuiConfig.theme,
    tuiMode: input.tuiConfig.tuiMode,
    version: input.version,
    editorCommand: input.tuiConfig.editorCommand,
    disablePasteBurst: input.tuiConfig.disablePasteBurst,
    renderLatex: input.tuiConfig.renderLatex,
    cacheExpiryHint: input.tuiConfig.cacheExpiryHint,
    disableFeedbackSurvey: input.tuiConfig.disableFeedbackSurvey,
    autoSessionTitle: input.tuiConfig.autoSessionTitle,
    notifications: input.tuiConfig.notifications,
    upgrade: input.tuiConfig.upgrade,
    statusLine: input.tuiConfig.statusLine,
    markdown: input.tuiConfig.markdown,
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
    goal: null,
    mcpServersSummary: null,
    banner: undefined,
  };
}

interface SendMessageOptions {
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
  readonly mediaSnapshots?: readonly MediaAttachment[];
  readonly hasMedia?: boolean;
  /**
   * Lease pre-created at extraction time by `sendNormalUserInput`. Dispatch
   * reuses it (carrying its exact-binding submission id); enqueueing defers
   * it — the queue item owns the raw ids and re-leases at dequeue.
   */
  readonly lease?: StagingLease;
  readonly occupiedRetry?: boolean;
}

/** How long the one-shot "moved to background" footer hint stays visible. */
const DETACH_HINT_DISPLAY_MS = 4_000;

export class KimiTUI {
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  session: Session | undefined;
  state: TUIState;
  private hasSessionHistory = false;
  /** In-flight lazy session creation (v2 engine), shared by concurrent first-use triggers. */
  private ensureSessionPromise: Promise<Session | undefined> | null = null;
  /** In-flight `/new` session replacement, shared by concurrent `/new` triggers. */
  private newSessionPromise: Promise<void> | null = null;
  private readonly cacheHint = new CacheHintController(this);
  /** Staged prompt media lifecycle (daemon uploads + cache copies) — see StagingLeaseTracker. */
  private readonly staging: StagingLeaseTracker;
  private readonly steeringQueuedMessages = new Set<QueuedMessage>();
  private readonly pendingPromptEntries = new Set<TranscriptEntry>();
  private readonly autoTitleAttempts = new Map<string, { attempts: number; done: boolean }>();
  private readonly approvalController = new ApprovalController();
  private readonly questionController = new QuestionController();
  private readonly reverseRpcDisposers: Array<() => void> = [];
  private surveySettingSubscription: Unsubscribe | undefined;
  private skillCommands: readonly KimiSlashCommand[] = [];
  readonly skillCommandMap = new Map<string, string>();
  private pluginCommands: readonly KimiSlashCommand[] = [];
  readonly pluginCommandMap = new Map<string, string>();
  private readonly imageStore = new ImageAttachmentStore();
  // Detected lazily in startBackgroundFdAutocomplete() — detection spawns
  // `fd --version`, which must not happen before the workspace trust gate:
  // on Windows a bare command name resolves into the (untrusted) cwd first.
  private fdPath: string | null = null;
  private fdDownloadStarted = false;
  sessionEventUnsubscribe: (() => void) | undefined;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages = false;
  aborted = false;
  /** Trigger of the most recent compaction.started; paired with its completed. */
  lastCompactionTrigger: CompactionStartedEvent['trigger'] | undefined;
  /** Bumped on every completed auto compaction; queued /compact items snapshot it. */
  autoCompactionSerial = 0;
  private terminalFocusTrackingDispose: (() => void) | undefined;
  private terminalThemeTrackingDispose: (() => void) | undefined;
  private clipboardImageHintController: ClipboardImageHintController | undefined;
  private uninstallRainbowDance: () => void;
  private signalCleanupHandlers: Array<() => void> = [];
  private isShuttingDown = false;
  private backgroundRefreshPromise: Promise<void> | undefined;
  private readonly migrationPlan: MigrationPlan | null;
  private readonly migrateOnly: boolean;
  private readonly telemetryDisabled: boolean;
  private startupNotice: string | undefined;
  private lastActivityMode: string | undefined;
  private currentLoadingTip: { kind: LoadingTipKind; tip: string | undefined } | undefined =
    undefined;
  private lastHistoryContent: string | undefined;
  // Live `!` shell output entries, keyed by commandId so concurrent commands
  // each update their own card and stale events are dropped. Mutated in place
  // as `shell.output` events arrive; removed when the command completes.
  // `taskId` (from `shell.started`) lets ctrl+b detach the exact task.
  private readonly shellOutputStreams = new Map<
    string,
    { entry: TranscriptEntry; component: ShellRunComponent; taskId?: string }
  >();
  readonly streamingUI: StreamingUIController;
  readonly programStatus: ProgramStatusController;
  readonly authFlow: AuthFlowController;
  readonly btwPanelController: BtwPanelController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly sessionReplay: SessionReplayRenderer;
  readonly tasksBrowserController: TasksBrowserController;
  readonly surveyController: SurveyController;
  readonly editorKeyboard: EditorKeyboardController;
  readonly modelMigration: ModelMigrationController;
  private editorReplacementOnDisplaced: (() => void) | undefined;
  private editorReplacementOnReplaced: (() => void) | undefined;
  private editorReplacementOwner: ReverseRpcModalOwner | undefined;

  /** Timer that auto-clears the one-shot "moved to background" footer hint. */
  private detachHintClearTimer: ReturnType<typeof setTimeout> | undefined;

  // The currently-mounted approval panel, if any. Kept so the full-screen
  // preview viewer can restore focus to the exact same instance (and its
  // selection / feedback state) when it closes.
  private activeApprovalPanel: ApprovalPanelComponent | undefined;
  // Active full-screen approval preview. While set, the previous screen is
  // stashed in `takeover` (root children in regular mode, the layout root in
  // fullscreen); closing restores it.
  private approvalPreview:
    | {
        component: ApprovalPreviewViewer;
        takeover: ScreenTakeover;
        panel: ApprovalPanelComponent;
      }
    | undefined;

  public onExit?: (exitCode?: number) => Promise<void>;

  /** URL opened in the browser just before exit (e.g. by `/web`); printed by onExit. */
  public exitOpenUrl: string | undefined;

  /**
   * Task that takes over the process after the TUI shuts down, instead of
   * exiting (`/web` starting a new server: the server keeps this terminal
   * attached until Ctrl+C). Set via {@link setExitForegroundTask}.
   */
  public exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

  track(
    event: string,
    properties?: Parameters<KimiHarness['track']>[1],
    context?: { readonly sessionId?: string },
  ): void {
    if (context === undefined) {
      this.harness.track(event, properties);
      return;
    }
    this.harness.trackWithContext(event, properties, { sessionId: context.sessionId });
  }

  constructor(harness: KimiHarness, startupInput: KimiTUIStartupInput) {
    this.harness = harness;
    this.staging = new StagingLeaseTracker({
      takeFileIds: (ids) => this.imageStore.takeFileIds(ids),
      releaseRetains: (ids) => {
        this.imageStore.releaseRetains(ids);
      },
      deleteFiles: async (fileIds, paths) => {
        await Promise.all([
          ...fileIds.map((fileId) => this.harness.deleteFile(fileId).catch(() => undefined)),
          ...paths.map((path) => unlink(path).catch(() => undefined)),
        ]);
      },
      warn: (message) => {
        this.track('staging_lease_invariant', { message });
      },
    });
    const tuiOptions: KimiTUIOptions = {
      initialAppState: createInitialAppState(startupInput),
      startup: {
        sessionFlag: startupInput.cliOptions.session,
        continueLast: startupInput.cliOptions.continue,
        yolo: startupInput.cliOptions.yolo,
        auto: startupInput.cliOptions.auto,
        plan: startupInput.cliOptions.plan,
        model: startupInput.cliOptions.model,
        additionalDirs: startupInput.additionalDirs,
        agentProfile: startupInput.agentProfile,
        agentFiles: startupInput.cliOptions.agentFiles,
        environment: startupInput.cliOptions.environment,
        environmentCwd: startupInput.cliOptions.environmentCwd,
        startupNotice: startupInput.startupNotice,
      },
    };
    this.options = tuiOptions;
    this.migrationPlan = startupInput.migrationPlan ?? null;
    this.migrateOnly = startupInput.migrateOnly ?? false;
    this.telemetryDisabled = startupInput.telemetryDisabled ?? false;
    this.startupNotice = startupInput.startupNotice;
    this.state = createTUIState(tuiOptions);
    this.programStatus = new ProgramStatusController(this.state, this.state.terminal);
    this.state.footer.setExpandHintProvider(() => this.toolOutputExpandHint());
    this.state.transcriptContainer.setUnhandledClick((index) =>
      this.toggleClickedFoldBlock(index),
    );
    this.uninstallRainbowDance = installRainbowDance(() => {
      this.state.ui.requestRender();
    });

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
    this.surveySettingSubscription = this.harness.onConfigSectionChanged((change) => {
      if (change.domain !== 'disableFeedbackSurvey') return;
      this.setAppState({ disableFeedbackSurvey: change.value === true ? true : undefined });
    });
    this.streamingUI = new StreamingUIController(this);
    this.authFlow = new AuthFlowController(this);
    this.btwPanelController = new BtwPanelController(this, this.imageStore, this.staging);
    this.sessionEventHandler = new SessionEventHandler(this);
    this.sessionReplay = new SessionReplayRenderer(this);
    this.tasksBrowserController = new TasksBrowserController(this);
    this.surveyController = new SurveyController(this, {
      accessToken: () => this.harness.auth.getCachedAccessToken(),
      telemetryDisabled: () => isTelemetryDisabledByEnv() || this.telemetryDisabled,
    });
    this.modelMigration = new ModelMigrationController(this);
    this.editorKeyboard = new EditorKeyboardController(this, this.imageStore);
    this.editorKeyboard.install();
    this.buildLayout();
  }

  // =========================================================================
  // Autocomplete & Skill Commands
  // =========================================================================

  private getSlashCommands(): readonly KimiSlashCommand[] {
    const builtins = sortSlashCommands(BUILTIN_SLASH_COMMANDS).filter((command) =>
      isExperimentalFlagEnabled(command.experimentalFlag),
    );
    return [...builtins, ...this.skillCommands, ...this.pluginCommands];
  }

  private setupAutocomplete(): void {
    const slashCommands: SlashAutocompleteCommand[] = this.getSlashCommands().map((cmd) => {
      const completer = cmd.completeArgs;
      return {
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        ...(cmd.argumentHint !== undefined ? { argumentHint: cmd.argumentHint } : {}),
        ...(completer !== undefined
          ? { getArgumentCompletions: (prefix: string) => completer(prefix) }
          : {}),
      };
    });
    const skillCommandNames = new Set(this.skillCommandMap.keys());
    const environment = this.state.appState.environment;
    const environmentBinding =
      environment !== undefined
        ? environment
        : this.creationEnvironment ?? {
            environmentId: this.options.startup.environment,
            cwd: this.options.startup.environmentCwd,
          };
    const { environmentId } = environmentBinding;
    const remoteSuggest =
      environmentId === undefined || environmentId === 'local'
        ? undefined
        : async (query: string) => {
            const session = this.session;
            if (session === undefined) return undefined;
            const result = await this.harness.suggestFiles(this.state.appState.workDir, {
              query,
              sessionId: session.id,
            });
            return result?.items;
          };
    const provider = new FileMentionProvider(
      slashCommands,
      this.state.appState.workDir,
      this.fdPath,
      this.state.appState.additionalDirs,
      () => this.state.appState.inputMode,
      skillCommandNames,
      remoteSuggest,
    );
    this.state.editor.setAutocompleteProvider(provider);

    const argumentHints = new Map<string, string>();
    for (const cmd of slashCommands) {
      if (cmd.argumentHint === undefined) continue;
      argumentHints.set(cmd.name, cmd.argumentHint);
      for (const alias of cmd.aliases ?? []) {
        argumentHints.set(alias, cmd.argumentHint);
      }
    }
    this.state.editor.setArgumentHints(argumentHints);
    this.state.editor.setSkillCommandNames(skillCommandNames);
  }

  refreshSlashCommandAutocomplete(): void {
    this.sessionEventHandler.notifications.setEnabled(isExperimentalFlagEnabled('notify_user'));
    this.setupAutocomplete();
  }

  async refreshSkillCommands(session?: SkillListSession): Promise<void> {
    if (session === undefined) {
      // v2 engine: skills live on the workspace handler, not the session, so
      // they are available before the first (lazy) session is created — the
      // workspace catalog is the same merged view a session would serve.
      try {
        const skills = await this.harness.listWorkspaceSkills(this.state.appState.workDir);
        this.applySkillCommands(skills);
      } catch {}
      return;
    }

    let skills;
    try {
      skills = await session.listSkills();
    } catch {
      return;
    }
    this.applySkillCommands(skills);
  }

  private applySkillCommands(skills: readonly SkillSummary[]): void {
    const skillCommands = buildSkillSlashCommands(skills);
    this.skillCommands = skillCommands.commands;
    this.skillCommandMap.clear();
    for (const [commandName, skillName] of skillCommands.commandMap) {
      this.skillCommandMap.set(commandName, skillName);
    }
    this.setupAutocomplete();
  }

  async refreshPluginCommands(session?: Session): Promise<void> {
    if (session === undefined) {
      // v2 engine: the enabled plugin commands are an app-global live view,
      // available before the first (lazy) session is created.
      try {
        const defs = await this.harness.listPluginCommands();
        this.applyPluginCommands(defs);
      } catch {}
      return;
    }

    let defs;
    try {
      defs = await session.listPluginCommands();
    } catch {
      return;
    }
    this.applyPluginCommands(defs);
  }

  private applyPluginCommands(defs: readonly PluginCommandDef[]): void {
    const pluginSlashCommands = buildPluginSlashCommands(defs);
    this.pluginCommands = pluginSlashCommands.commands;
    this.pluginCommandMap.clear();
    for (const [commandName, body] of pluginSlashCommands.commandMap) {
      this.pluginCommandMap.set(commandName, body);
    }
    this.setupAutocomplete();
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    startupTrace('tui:start');
    // Signal handlers must be installed before raw mode to avoid EIO loops.
    this.registerSignalHandlers();
    let trustPromptStartedLoop = false;
    // Outer try rolls back signal listeners on startup failure.
    try {
      // The workspace trust gate must run before anything else in startup —
      // including the migration branch: a workspace that needs migration is
      // not implicitly trusted, and later startup steps spawn child processes.
      startupTrace('trustPrompt:begin');
      trustPromptStartedLoop = await this.maybeRunWorkspaceTrustPrompt();
      startupTrace('trustPrompt:end');

      if (this.migrationPlan !== null) {
        // Migration needs the event loop running first (pi-tui component).
        // When the trust prompt already started it, starting it again would
        // re-run pi-tui's terminal.start() — stacking a second Kitty
        // keyboard-protocol push and duplicate stdin listeners.
        if (!trustPromptStartedLoop) this.startEventLoop();
        try {
          const migrationResult = await this.runMigrationScreen(this.migrationPlan);
          if (this.migrateOnly) {
            const failed = migrationResult.decision === 'now' && migrationResult.migrated === false;
            this.disposeTerminalTracking();
            this.state.ui.stop();
            await this.onExit?.(failed ? 1 : 0);
            return;
          }
          const startupSpinner = this.showProgressSpinner(this.startupProgressLabel());
          const shouldReplayHistory = await this.initMainTui().then(
            (result) => {
              startupSpinner.stop({ ok: true, label: 'Ready.' });
              return result;
            },
            (error: unknown) => {
              startupSpinner.stop({ ok: false, label: 'Startup failed.' });
              throw error;
            },
          );
          this.startBackgroundFdAutocomplete();
          await this.finishStartup(shouldReplayHistory);
        } catch (error) {
          if (!trustPromptStartedLoop) {
            this.disposeTerminalTracking();
            this.state.ui.stop();
          }
          throw error;
        }
        return;
      }

      startupTrace('initMainTui:begin');
      if (!trustPromptStartedLoop) this.startEventLoop();
      const startupSpinner = this.showProgressSpinner(this.startupProgressLabel());
      let shouldReplayHistory: boolean;
      try {
        shouldReplayHistory = await this.initMainTui();
      } catch (error) {
        startupSpinner.stop({ ok: false, label: 'Startup failed.' });
        if (!trustPromptStartedLoop) {
          this.disposeTerminalTracking();
          this.state.ui.stop();
        }
        throw error;
      }
      startupSpinner.stop({ ok: true, label: 'Ready.' });
      startupTrace('initMainTui:end');
      // Debug-only input→render latency overlay (KIMI_TUI_INPUT_LATENCY=1).
      if (process.env['KIMI_TUI_INPUT_LATENCY']) installInputLatencyProbe(this.state.ui);
      startupTrace('eventLoop:started');
      try {
        this.startBackgroundFdAutocomplete();
        startupTrace('finishStartup:begin');
        await this.finishStartup(shouldReplayHistory);
        startupTrace('finishStartup:end');
      } catch (error) {
        if (!trustPromptStartedLoop) {
          this.disposeTerminalTracking();
          this.state.ui.stop();
        }
        throw error;
      }
    } catch (error) {
      if (trustPromptStartedLoop) {
        this.disposeTerminalTracking();
        this.state.ui.stop();
      }
      this.unregisterSignalHandlers();
      throw error;
    }
  }

  private async loadBanner(): Promise<void> {
    const provider = new BannerProvider(this.state.appState.version);
    const displayState = await readBannerDisplayState();
    const now = new Date();
    const audience = this.harness.auth.getCachedAccessToken().then(
      (accessToken) => resolveBannerAudienceContext(accessToken),
      (): BannerAudienceContext => ({ login: 'unknown' }),
    );
    const banner = await provider.load({
      state: displayState,
      now,
      audience,
    });
    this.state.appState.banner = banner;
    if (banner === null) return;

    this.renderBanner();
    this.state.ui.requestRender();

    if (banner.display === 'always') return;
    try {
      await writeBannerDisplayState({
        version: 1,
        shown: {
          ...displayState.shown,
          [banner.key]: { lastShownAt: now.toISOString() },
        },
      });
    } catch {
      // Best-effort: banner display state should never block startup.
    }
  }

  private renderBanner(): void {
    if (this.state.appState.banner === null || this.state.appState.banner === undefined) {
      return;
    }
    if (this.state.transcriptContainer.children.some((child) => child instanceof BannerComponent)) {
      return;
    }
    const welcomeIndex = this.state.transcriptContainer.children.findIndex(
      (child) => child instanceof WelcomeComponent,
    );
    const banner = new BannerComponent(this.state.appState.banner);
    if (welcomeIndex >= 0) {
      this.state.transcriptContainer.children.splice(welcomeIndex + 1, 0, banner);
    } else {
      this.state.transcriptContainer.children.unshift(banner);
    }
    this.state.transcriptContainer.invalidate();
  }

  private async initMainTui(): Promise<boolean> {
    const shouldReplayHistory = await this.init();

    if (this.session === undefined) {
      const workDir = this.state.appState.workDir;
      const pendingAdditionalDirs = this.state.appState.additionalDirs;
      const workspaceAdditionalDirs = await this.harness
        .getWorkspaceAdditionalDirs(workDir)
        .catch((error: unknown) => {
          if (
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            error.code !== ErrorCodes.SHELL_GIT_BASH_NOT_FOUND
          ) {
            throw error;
          }
          this.appendStartupNotice(
            `Additional workspace directories could not be loaded: ${formatErrorMessage(error)}`,
          );
          return [];
        });
      this.setAppState({
        additionalDirs: [
          ...new Set(
            [...workspaceAdditionalDirs, ...pendingAdditionalDirs].map((dir) =>
              resolveMentionDirectory(workDir, dir),
            ),
          ),
        ],
      });
    }

    // Mount only after init() succeeds; see mountFooter().
    mountFooter(this.state);
    this.renderWelcome();
    void this.loadBanner();
    this.setupAutocomplete();
    void this.loadPersistedInputHistory();
    setEditorSlot(this.state, this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.applyRecommendedEffortInBackground();
    this.refreshModelSwitchConfirmConfigInBackground();
    return shouldReplayHistory;
  }

  private startEventLoop(): void {
    // Dispose any previous focus/clipboard/theme tracking so re-entering the
    // event loop (e.g. a future TUI reconnect) can't stack duplicate listeners.
    this.disposeTerminalTracking();
    this.state.ui.start();
    this.programStatus.refresh();
    this.startClipboardImageHintController();
    this.terminalFocusTrackingDispose = installTerminalFocusTracking(this.state, () => {
      this.programStatus.acknowledgeResults();
    });
    this.refreshTerminalThemeTracking();
  }

  private startupProgressLabel(): string {
    const { startup } = this.options;
    if (startup.sessionFlag !== undefined || startup.continueLast) return 'Restoring session…';
    const environmentId = this.creationEnvironment?.environmentId ?? startup.environment;
    if (environmentId !== undefined && environmentId !== 'local') {
      return `Connecting to ${environmentId}…`;
    }
    return 'Preparing Kimi Code…';
  }

  private startClipboardImageHintController(): void {
    this.clipboardImageHintController = new ClipboardImageHintController({
      ui: this.state.ui,
      footer: this.state.footer,
      getModelSupportsImage: () => this.supportsCurrentModelCapability('image_in'),
      requestRender: () => {
        this.state.ui.requestRender();
      },
    });
    this.clipboardImageHintController.start();
  }

  private startBackgroundFdAutocomplete(): void {
    if (this.fdDownloadStarted) return;
    this.fdDownloadStarted = true;

    this.fdPath = detectFdPath();
    if (this.fdPath !== null) {
      this.setupAutocomplete();
      return;
    }

    void ensureFdPath()
      .then((fdPath) => {
        if (fdPath === null) return;
        this.fdPath = fdPath;
        this.setupAutocomplete();
      })
      .catch(() => {
        // Best-effort background bootstrap: autocomplete keeps using the filesystem fallback.
      });
  }

  private applyRecommendedEffortInBackground(): void {
    void this.backgroundRefreshPromise?.then(async () => {
      await applyRecommendedEffort({
        fetchConfig: async () =>
          getRecommendedEffortConfig({
            accessToken: await this.harness.auth.getCachedAccessToken(),
          }),
        getConfig: () => this.harness.getConfig(),
        setConfig: (patch) => this.harness.setConfig(patch),
        track: (event, properties) => {
          this.track(event, properties);
        },
      });
    });
  }

  private refreshModelSwitchConfirmConfigInBackground(): void {
    void (async () => {
      try {
        await refreshModelSwitchConfirmConfig({
          accessToken: await this.harness.auth.getCachedAccessToken(),
        });
      } catch {
        // Best-effort warm-up: a failed token lookup or fetch just leaves the
        // dialog gated off.
      }
    })();
  }

  private async refreshProviderModelsInBackground(): Promise<void> {
    try {
      const result = await this.authFlow.refreshProviderModels();
      for (const c of result.changed) {
        if (c.added <= 0) continue;
        this.showStatus(`${c.provider_name} · +${String(c.added)} model${c.added > 1 ? 's' : ''}.`);
      }
      for (const f of result.failed) {
        this.showStatus(`Skipped refreshing ${f.provider}: ${f.reason}`, 'warning');
      }
      if (result.retired_default !== undefined) {
        await this.modelMigration.retire(result.retired_default);
      }
    } catch {
      // Best-effort: startup must not crash on background refresh failures.
    }
  }

  private async migrateLegacySurveySetting(): Promise<void> {
    const legacyValue = this.state.appState.disableFeedbackSurvey;
    try {
      const outcome = await migrateLegacySurveySetting({
        legacyValue,
        getConfig: () => this.harness.getConfig(),
        setConfig: (patch) => this.harness.setConfig(patch),
        dropLegacy: removeLegacySurveySetting,
        warn: (message) => {
          this.showStatus(message, 'warning');
        },
      });
      this.setAppState({ disableFeedbackSurvey: outcome.value });
      if (outcome.action === undefined) return;
      this.track('survey_setting_migration', {
        legacy: legacyValue,
        configured: outcome.configured ?? 'absent',
        action: outcome.action,
      });
    } catch {}
  }

  private async finishStartup(shouldReplayHistory: boolean): Promise<void> {
    if (this.startupNotice !== undefined) {
      this.showStatus(this.startupNotice);
      this.startupNotice = undefined;
    }
    void this.showTmuxKeyboardWarningIfNeeded();
    void this.migrateLegacySurveySetting();
    // Config diagnostics (deprecated keys/env vars, invalid sections) in
    // warning yellow at boot; `run-prompt`/`run-v2-print` print them to
    // stderr for non-interactive runs.
    void this.showConfigWarningsIfAny();
    if (this.state.startupState === 'picker') {
      void this.bootstrapFromPicker();
      void this.backgroundRefreshPromise?.then(() => {
        this.modelMigration.request();
      });
      return;
    }
    if (shouldReplayHistory) {
      await this.sessionReplay.hydrateFromReplay(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    const resumeState = this.session?.getResumeState();
    this.surveyController.seedFromResumedAgents(resumeState?.sessionMetadata.agents ?? {});
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    if (this.session !== undefined) {
      this.sessionEventHandler.startSubscription();
      void this.refreshEnvironmentSlot(this.session);
      void this.showSessionWarnings(this.session);
    }
    if (shouldReplayHistory) {
      void this.cacheHint.maybeShowOnResume();
    }
    void this.fetchSessions();
    if (this.session !== undefined) {
      this.updateTerminalTitle();
    }
    void this.refreshSkillCommands(this.session);
    void this.refreshPluginCommands(this.session);
    void this.backgroundRefreshPromise?.then(() => {
      this.modelMigration.request();
    });
  }

  private async showSessionWarnings(session: Session): Promise<void> {
    try {
      const warnings = await session.getSessionWarnings();
      if (this.session !== session) return;
      for (const warning of warnings) {
        const severity = warning.severity === 'error' ? 'error' : 'warning';
        this.showStatus(`Warning: ${warning.message}`, severity);
      }
    } catch {
      // Best-effort: startup must not block on warning retrieval.
    }
  }

  private async showTmuxKeyboardWarningIfNeeded(): Promise<void> {
    const warning = await detectTmuxKeyboardWarning();
    if (warning === undefined || this.aborted) return;
    this.showStatus(warning, 'warning');
  }

  private async init(): Promise<boolean> {
    setExperimentalFeatures(await this.harness.getExperimentalFeatures());
    this.sessionEventHandler.notifications.setEnabled(isExperimentalFlagEnabled('notify_user'));
    await this.authFlow.refreshAvailableModels();
    this.backgroundRefreshPromise = this.refreshProviderModelsInBackground();

    const { startup } = this.options;
    const { workDir } = this.state.appState;
    let session: Session | undefined;
    let shouldReplayHistory = false;
    const isResumeStartup = startup.sessionFlag !== undefined || startup.continueLast;
    const createSessionOptions: MutableCreateSessionOptions = {
      workDir,
      model: startup.model,
      permission: startup.auto ? 'auto' : startup.yolo ? 'yolo' : undefined,
      planMode: startup.plan ? true : undefined,
      // --agent/--agent-file bind the startup session only; sessions created
      // later in this process fall back to the default profile.
      agentProfile: startup.agentProfile,
      agentFiles: startup.agentFiles?.length ? [...startup.agentFiles] : undefined,
    };
    const startupAdditionalDirs = this.options.startup.additionalDirs ?? [];
    if (startupAdditionalDirs.length > 0) {
      createSessionOptions.additionalDirs = [...startupAdditionalDirs];
    }

    try {
      if (isResumeStartup) {
        if (startup.sessionFlag === '') {
          this.state.startupState = 'picker';
          return false;
        }

        if (startup.sessionFlag !== undefined) {
          const sessions = await this.harness.listSessions({
            sessionId: startup.sessionFlag,
            workDir,
          });
          const target = sessions[0];
          if (target === undefined) {
            throw new Error(`Session "${startup.sessionFlag}" not found.`);
          }
          if (resolve(target.workDir) !== resolve(workDir)) {
            this.state.ui.stop();
            process.stderr.write(
              `${currentTheme.fg(
                'warning',
                `Session "${startup.sessionFlag}" was created under a different directory.\n` +
                  `  cd "${target.workDir}" && kimi -r ${startup.sessionFlag}`,
              )}\n\n`,
            );
            throw new Error(
              `Session "${startup.sessionFlag}" was created under a different directory.`,
            );
          }
          session = await this.harness.resumeSession({
            id: startup.sessionFlag,
            additionalDirs: createSessionOptions.additionalDirs,
            replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
          });
          shouldReplayHistory = true;
        } else {
          // Only the most recent session matters here — fetch a one-item page
          // instead of materializing the whole listing.
          const page = await this.harness.listSessionsPage({ workDir, limit: 1 });
          const target = page.items[0];
          if (target !== undefined) {
            session = await this.harness.resumeSession({
              id: target.id,
              additionalDirs: createSessionOptions.additionalDirs,
              replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
            });
            shouldReplayHistory = true;
          } else {
            session = await this.harness.createSession(createSessionOptions);
            this.startupNotice = combineStartupNotice(
              this.startupNotice,
              `No sessions to continue under "${workDir}"; starting a fresh session.`,
            );
          }
        }
      } else {
        // Lazy session creation (v2 engine): start session-less and create the
        // session on the first message. Startup flags are carried in appState
        // and applied when that session is created; until then the footer
        // shows the config defaults the engine would apply at createSession
        // time (model, permission, plan mode, thinking effort, context cap).
        await this.hydrateLazyConfigDefaults();
        if (this.creationEnvironment?.environmentId !== undefined && this.creationEnvironment.environmentId !== 'local') {
          // The remote session is created eagerly, so the session-less
          // "No session yet" notice would contradict the live banner.
          void this.ensureSession();
        } else {
          this.appendStartupNotice(SESSIONLESS_STARTUP_NOTICE);
        }
      }
      if (session !== undefined && shouldReplayHistory) {
        await this.applyStartupModesToResumedSession(session);
        if (startup.model !== undefined) {
          await session.setModel(startup.model);
        }
      }
    } catch (error) {
      if (!isOAuthLoginRequiredError(error)) throw error;
      this.authFlow.enterLoginRequiredStartupState();
      return false;
    }

    if (session !== undefined) {
      await this.setSession(
        session,
        shouldReplayHistory ? session.getResumeState()?.agents[MAIN_AGENT_ID]?.userTurnCount : 0,
      );
      await this.syncRuntimeState(session);
    }
    this.applyStartupPermissionAndPlanToAppState();
    this.state.startupState = 'ready';
    return shouldReplayHistory;
  }

  async stop(exitCode?: number): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    this.aborted = true;
    // A Ctrl+C during shutdown means "don't wait for slow hooks": skip the
    // remaining graceful close and get out immediately. Captured at the UI
    // input-listener level so it works no matter which component holds focus
    // (a dialog may have replaced the editor).
    const removeForceExitListener = this.state.ui.addInputListener((data) => {
      if (!matchesKey(data, Key.ctrl('c'))) return undefined;
      this.forceExitDuringShutdown();
      return { consume: true };
    });
    // Give the startup provider-model refresh a brief chance to finish before
    // the harness closes (and the process exits): its config writes are each
    // atomic, so draining can only ever leave a complete file behind. Bounded
    // so a slow network never delays the exit.
    if (this.backgroundRefreshPromise !== undefined) {
      await Promise.race([
        this.backgroundRefreshPromise,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    this.streamingUI.discardPending();
    // Stop background polling, streaming intervals, and per-component timers
    // before tearing the UI down, so they can't keep firing requestRender after
    // stop() returns (or leak when stop() runs without process.exit).
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.stopActivitySpinner();
    this.streamingUI.clearActiveCompaction();
    this.streamingUI.resetToolUi();
    this.disposeTranscriptChildren();
    this.editorKeyboard.dispose();
    this.surveyController.dispose();
    this.surveySettingSubscription?.();
    this.surveySettingSubscription = undefined;
    this.state.footer.dispose();
    this.disposeEditorReplacement();
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
    this.disposeTerminalTracking();
    // closeSession runs SessionEnd hooks, which can take seconds (bounded by
    // the hook timeout) — keep the last frame from looking like a freeze by
    // saying the shutdown is in progress.
    this.state.footer.setTransientHint(SHUTTING_DOWN_HINT);
    this.state.ui.requestRender();
    // Restore the terminal even if closing the session / harness throws — a
    // SIGTERM during a network or MCP shutdown must not leave the user stuck in
    // raw mode with a hidden cursor.
    try {
      await this.closeSession('shutting down');
      this.clearQueuedMessages();
      this.staging.releaseAll();
      this.staging.deleteStaged(this.imageStore.clear());
      await this.staging.drain();
      await this.harness.close();
    } finally {
      removeForceExitListener();
      this.sessionEventHandler.stopAllMcpServerStatusSpinners();
      this.sessionEventHandler.clearStepRetryAttemptTimer();
      this.uninstallRainbowDance();
      try {
        await this.state.terminal.drainInput();
      } catch {
        // best effort — the terminal may already be dead (SIGHUP / EIO).
      }
      try {
        this.stopUiForExit();
      } catch {
        // best effort terminal restore.
      }
    }
    if (this.onExit) {
      await this.onExit(exitCode);
    }
  }

  // Ctrl+C while shutdown hooks run → skip the remaining graceful close. The
  // terminal is still alive (unlike the SIGHUP path), so run the full UI
  // teardown — alternate screen, mouse reporting, autowrap — and the CLI's
  // stty restore via onExit, instead of the bare emergency sequences.
  private forceExitDuringShutdown(): void {
    try {
      this.stopUiForExit();
    } catch {
      restoreTerminalModes();
    }
    if (this.onExit) {
      void this.onExit(130);
    } else {
      process.exit(130);
    }
  }

  // SIGHUP / dead-terminal EIO → emergencyTerminalExit (no cleanup, avoids
  // EIO write-loop that can pin a CPU core). SIGTERM → normal stop().
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
        // Registering a SIGTERM listener disables Node's default exit(143),
        // so we must reinstate it after stop() or on failure.
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

  // Exit codes follow POSIX 128+signum: 129 = SIGHUP, 143 = SIGTERM.
  private emergencyTerminalExit(exitCode = 129): never {
    this.isShuttingDown = true;
    this.unregisterSignalHandlers();
    // Best-effort terminal restore: stop() may not have run (SIGHUP) or may
    // have thrown (SIGTERM cleanup failure), so recover raw mode / cursor /
    // bracketed paste before exiting instead of leaving the user's shell broken.
    restoreTerminalModes();
    process.exit(exitCode);
  }

  private disposeTerminalTracking(): void {
    this.stopTerminalThemeTracking();
    this.clipboardImageHintController?.stop();
    this.clipboardImageHintController = undefined;
    this.terminalFocusTrackingDispose?.();
    this.terminalFocusTrackingDispose = undefined;
  }

  private buildLayout(): void {
    const { ui } = this.state;
    // Fullscreen mounts its layout root (transcript ScrollView + bottom dock)
    // in createTUIState; the root children list stays empty there.
    if (ui instanceof TuiAltScreen) return;
    ui.clear();
    ui.addChild(this.state.transcriptContainer);
    ui.addChild(this.state.activityContainer);
    ui.addChild(this.state.notifyPanelContainer);
    ui.addChild(this.state.queueContainer);
    ui.addChild(this.state.btwPanelContainer);
    ui.addChild(this.state.surveyContainer);
    ui.addChild(this.state.editorContainer);
    // Footer is mounted later (mountFooter), not here.
  }

  // Fullscreen exit: leave the alternate screen with the frame preserved,
  // then replay the transcript through a main-screen renderer so native
  // scrollback ends up with the same inline layout a regular session would
  // have produced (pi's "transcript" exit form).
  private stopUiForExit(): void {
    const ui = this.state.ui;
    if (!(ui instanceof TuiAltScreen)) {
      ui.stop();
      return;
    }
    ui.stop({ preserveScreen: true });
    const main = new TuiMainScreen(ui.terminal);
    main.addChild(this.state.transcriptContainer);
    main.addChild(this.state.activityContainer);
    main.addChild(this.state.notifyPanelContainer);
    main.addChild(this.state.queueContainer);
    main.addChild(this.state.btwPanelContainer);
    main.addChild(this.state.surveyContainer);
    main.addChild(this.state.editorContainer);
    const footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    footerWrap.addChild(this.state.footer);
    main.addChild(footerWrap);
    // First paint of a main-screen renderer writes every line sequentially,
    // landing the whole transcript in native scrollback.
    main.renderNow();
    main.stop();
  }

  // =========================================================================
  // Input Dispatch
  // =========================================================================

  handlePlanToggle(next: boolean): void {
    void slashCommands.handlePlanCommand(this, next ? 'on' : 'off');
  }

  handleInputModeChange(mode: 'prompt' | 'bash'): void {
    this.setAppState({ inputMode: mode });
    this.surveyController.notifyInputModeChanged(mode);
    this.updateEditorBorderHighlight();
  }

  handleUserInput(text: string): void {
    const wasBashMode = this.state.appState.inputMode === 'bash';
    if (wasBashMode) {
      // A submit always exits bash mode (the `!` is consumed by this command).
      this.state.editor.inputMode = 'prompt';
      this.handleInputModeChange('prompt');
    }
    if (text.trim().length === 0) return;
    if (this.state.appState.isReplaying) {
      this.showError('Cannot send input while session history is replaying.');
      return;
    }
    // Shell commands are stored with a leading `!` so ↑ recall can tell them
    // apart from prompts and restore bash mode (see CustomEditor's mode-aware
    // history navigation). The `!` is stripped again when the entry is recalled.
    const historyText = wasBashMode ? `!${text}` : text;
    void this.persistInputHistory(historyText);
    if (wasBashMode) {
      // Only one foreground action at a time: queue the shell command while
      // another shell command is running or an agent turn is in progress.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.enqueueMessage(text, undefined, 'bash');
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
      void this.runShellCommandFromInput(text);
      return;
    }
    slashCommands.dispatchInput(this, text);
  }

  private async runShellCommandFromInput(command: string): Promise<void> {
    let session = this.session;
    if (session === undefined) {
      session = await this.ensureSession();
      if (session === undefined) return;
      // A concurrent first message may have started a prompt while this lazy
      // creation was in flight (both inputs share the same creation promise);
      // honor the busy gate here, like handleUserInput does before the await,
      // instead of running the shell command concurrently with an agent turn.
      if (this.state.appState.streamingPhase !== 'idle') {
        this.enqueueMessage(command, undefined, 'bash');
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        return;
      }
    }
    // Echo the command locally (bash-input) with a `$` prompt. The agent also
    // records it for resume; this is the live view.
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: currentTheme.fg('shellMode', `$ ${command}`),
      bullet: '',
    });
    // Create the live output entry up front. ShellRunComponent owns its own
    // rendering (running card → final view) and is mutated in place as output
    // streams in and on completion.
    const commandId = nextTranscriptId();
    const outputEntry: TranscriptEntry = {
      id: commandId,
      kind: 'status',
      turnId: undefined,
      renderMode: 'plain',
      content: '',
    };
    const outputComponent = new ShellRunComponent(() => this.state.ui.requestRender());
    // Inherit the current ctrl+o state, same as freshly mounted tool calls —
    // the global toggle only reaches components that exist when it fires.
    if (this.state.toolOutputExpanded) outputComponent.setExpanded(true);
    this.shellOutputStreams.set(commandId, { entry: outputEntry, component: outputComponent });
    this.state.transcriptEntries.push(outputEntry);
    markTranscriptComponent(outputComponent, outputEntry);
    this.state.transcriptContainer.addChild(outputComponent);
    // Treat command execution as a streaming phase so input queues, the activity
    // pane shows the moon spinner, and ctrl+b is enabled while it runs.
    this.setAppState({ streamingPhase: 'shell' });
    this.state.ui.requestRender();

    this.track('shell_command');

    void session.runShellCommand(command, { commandId }).then(
      ({ stdout, stderr, isError, backgrounded }) => {
        this.finishShellOutput(commandId, stdout, stderr, isError, backgrounded);
      },
      (error: unknown) => {
        const message = formatErrorMessage(error);
        this.finishShellOutput(commandId, '', message, true);
        this.programStatus.failRequest(message);
        this.showError(`Shell command failed: ${message}`);
      },
    );
  }

  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    const text = event.update.text ?? '';
    if (text.length === 0) return;
    stream.component.append(text);
  }

  handleShellStarted(event: { commandId: string; taskId: string }): void {
    const stream = this.shellOutputStreams.get(event.commandId);
    if (stream === undefined) return;
    stream.taskId = event.taskId;
  }

  cancelRunningShellCommand(): void {
    const session = this.session;
    if (session === undefined) return;
    for (const commandId of this.shellOutputStreams.keys()) {
      void session.cancelShellCommand(commandId).catch((error: unknown) => {
        this.showError(`Failed to cancel shell command: ${formatErrorMessage(error)}`);
      });
    }
  }

  private finishShellOutput(
    commandId: string,
    stdout: string,
    stderr: string,
    isError?: boolean,
    backgrounded?: boolean,
  ): void {
    const stream = this.shellOutputStreams.get(commandId);
    if (stream === undefined) return;
    if (backgrounded === true) {
      // The command was moved to the background; detachRunningShellCommand owns
      // the UI and the model notification, so there is nothing to render here.
      return;
    }
    stream.component.finish(stdout, stderr, isError);
    // Keep the transcript entry's metadata in sync for anything that reads it
    // (export / copy). The component renders itself.
    stream.entry.content = formatBashOutputForDisplay(stdout, stderr, isError);
    this.shellOutputStreams.delete(commandId);
    // When the last shell command finishes, leave the shell streaming phase,
    // release one queued message (if any), and refresh the activity pane.
    if (this.shellOutputStreams.size === 0) {
      this.programStatus.finishShell();
      this.setAppState({ streamingPhase: 'idle' });
      this.drainOneQueuedMessage();
    }
  }

  private drainOneQueuedMessage(): void {
    const session = this.session;
    if (session === undefined) return;
    const item = this.shiftQueuedMessage();
    if (item === undefined) return;
    if (item.mode === 'bash') {
      this.staging.releaseQueued([item]);
      void this.runShellCommandFromInput(item.text);
    } else {
      this.sendQueuedMessage(session, item);
    }
    this.updateQueueDisplay();
  }

  async sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void> {
    if (this.btwPanelController.sendUserInput(text)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    let extraction: ReturnType<typeof extractMediaAttachments>;
    if (preExtracted === undefined) {
      // A just-pasted image/video may still be finishing its background
      // ingestion (compression/daemon upload): give it a bounded moment so
      // the submit can use the daemon-ref form — a slower image ingestion
      // extracts to the inline fallback instead, a slower video upload
      // refuses the submission below. Undefined when nothing is pending,
      // keeping the media-free send path synchronous.
      const ingestionWait = pendingMediaIngestions(
        text,
        this.imageStore,
        MEDIA_INGESTION_SUBMIT_WAIT_MS,
      );
      if (ingestionWait !== undefined) await ingestionWait;
    }
    try {
      // A cache-hint-swallowed resend passes its pre-dialog extraction back
      // in: the image store may already be cleared (e.g. after "Start a new
      // session"), so re-extracting from the text would lose the media.
      extraction = preExtracted ?? extractMediaAttachments(text, this.imageStore);
      if (preExtracted !== undefined) {
        const parts = refreshExpiringImageFileRefs(
          extraction.parts,
          extraction.imageAttachmentIds,
          this.imageStore,
        );
        if (parts !== extraction.parts) extraction = { ...extraction, parts };
      }
    } catch (error) {
      // A pasted video's daemon upload was unusable (still in flight,
      // failed, expired); nothing was dispatched.
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    // Create the staging lease right after extraction, so every exit below
    // releases through the tracker instead of open-coding ids — a
    // forgotten exit degrades to an unclaimed lease (swept by `releaseAll`)
    // instead of a permanently retained upload. The lease carries the
    // exact-binding submission id: the consuming turn's `turn.started` echoes
    // it as `promptId`. A goal-active submission is steered and binds its
    // lease explicitly in sendMessageInternal, so it gets no id.
    const stagingLease = this.staging.create(
      // One retain per unique id per extraction: dedupe repeated placeholder
      // occurrences so the lease's id multiplicity matches the retain count.
      [...new Set([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds])],
      [],
      'user',
      extraction.hasMedia && this.state.appState.goal?.status !== 'active'
        ? randomUUID()
        : undefined,
    );
    if (!this.validateMediaCapabilities(extraction)) {
      this.staging.release(stagingLease);
      return;
    }
    // Idle cache-hint interception sits before session creation; it is
    // synchronous unless a hint actually fires. Aside from the bounded
    // ingestion wait above, the send path stays await-free up to sendMessage.
    if (this.cacheHint.maybeInterceptOnSubmit(text, extraction)) {
      // The stash owns the extraction from here: its resend re-leases inside
      // the re-entered send path, its restore goes through releaseRecalled
      // (see CacheHintController). Detach so the stash is not double-owned.
      this.staging.defer(stagingLease);
      return;
    }
    let session = this.session;
    if (session === undefined) {
      session = await this.ensureSession();
      if (session === undefined) {
        this.staging.release(stagingLease);
        return;
      }
    }
    if (extraction.hasMedia) {
      this.sendMessage(session, text, {
        hasMedia: true,
        parts: extraction.parts,
        imageAttachmentIds: extraction.imageAttachmentIds,
        videoAttachmentIds: extraction.videoAttachmentIds,
        lease: stagingLease,
      });
    } else {
      this.sendMessage(session, text);
    }
    this.updateQueueDisplay();
    this.state.ui.requestRender();
  }

  async sendInlineSkillUserInput(
    text: string,
    activations: readonly InlineSkillActivation[],
    preExtracted?: ExtractionResult,
  ): Promise<void> {
    if (this.btwPanelController.sendUserInput(text, activations)) return;
    if (this.state.appState.model.trim().length === 0) {
      this.showError(LLM_NOT_SET_MESSAGE);
      return;
    }
    const originatingSession = this.session;
    const mediaGeneration = this.imageStore.generation;
    let extraction: ExtractionResult;
    if (preExtracted === undefined) {
      const ingestionWait = pendingMediaIngestions(
        text,
        this.imageStore,
        MEDIA_INGESTION_SUBMIT_WAIT_MS,
      );
      if (ingestionWait !== undefined) await ingestionWait;
      if (
        (originatingSession !== undefined && this.session !== originatingSession) ||
        this.imageStore.generation !== mediaGeneration
      ) {
        this.showError('Session changed while preparing media attachment; skill prompt not sent.');
        return;
      }
    }
    try {
      extraction = preExtracted ?? extractMediaAttachments(text, this.imageStore);
      if (
        preExtracted?.mediaGeneration !== undefined &&
        preExtracted.mediaGeneration !== this.imageStore.generation
      ) {
        extraction = { ...preExtracted, imageAttachmentIds: [], videoAttachmentIds: [] };
      }
    } catch (error) {
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    if (!this.validateMediaCapabilities(extraction)) {
      this.staging.releaseMedia([
        ...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds,
      ], []);
      return;
    }
    if (this.cacheHint.maybeInterceptOnSubmit(text, extraction, activations)) return;
    let session = this.session;
    if (session === undefined) {
      session = await this.ensureSession();
      if (session === undefined) {
        this.staging.releaseMedia([
          ...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds,
        ], []);
        return;
      }
    }
    if (
      this.deferUserMessages ||
      this.steeringQueuedMessages.size > 0 ||
      this.state.appState.streamingPhase !== 'idle' ||
      this.state.appState.isCompacting
    ) {
      this.enqueueMessage(text, {
        parts: extraction.hasMedia ? extraction.parts : undefined,
        imageAttachmentIds: extraction.imageAttachmentIds,
        videoAttachmentIds: extraction.videoAttachmentIds,
        mediaSnapshots: extraction.mediaSnapshots,
        inlineSkillActivations: activations,
      });
      this.updateQueueDisplay();
      this.state.ui.requestRender();
      return;
    }
    this.beginSessionRequest();
    this.runInlineSkillActivations(session, text, activations, extraction);
  }

  prepareSkillActivations(
    activations: readonly InlineSkillActivation[],
    mediaSnapshots?: readonly MediaAttachment[],
  ): PreparedSkillActivations {
    const prepared: PreparedSkillActivations = {
      skills: [],
      mediaAttachmentIds: [],
      stagingPaths: [],
      cachedVideos: [],
    };
    try {
      for (const activation of activations) {
        if (activation.args === undefined) {
          prepared.skills.push({ name: activation.skillName });
          continue;
        }
        const rewrite = rewriteMediaPlaceholders(
          activation.args, this.imageStore, 'plain', mediaSnapshots,
        );
        this.imageStore.retainFileIds(rewrite.videoAttachmentIds);
        prepared.skills.push({ name: activation.skillName, args: rewrite.text });
        prepared.mediaAttachmentIds.push(
          ...new Set([...rewrite.imageAttachmentIds, ...rewrite.videoAttachmentIds]),
        );
        prepared.stagingPaths.push(...rewrite.stagingPaths);
        prepared.cachedVideos.push(...rewrite.cachedVideos);
      }
      return prepared;
    } catch (error) {
      this.releaseSkillArgumentMedia(prepared);
      throw error;
    }
  }

  releaseSkillArgumentMedia(prepared: PreparedSkillActivations): void {
    for (const id of prepared.mediaAttachmentIds) this.staging.releaseRecalled([id]);
    this.staging.releaseMedia([], prepared.stagingPaths);
  }

  private runInlineSkillActivations(
    session: Session,
    text: string,
    activations: readonly InlineSkillActivation[],
    extraction: ReturnType<typeof extractMediaAttachments>,
    occupiedRetry = false,
  ): void {
    let prepared: PreparedSkillActivations | undefined;
    let input: string | readonly PromptPart[] | Promise<PromptPart[]>;
    try {
      prepared = this.prepareSkillActivations(activations, extraction.mediaSnapshots);
      input = extraction.hasMedia
        ? resolveSessionOriginalCaptions(
            omitExpiredVideoFileRefs(extraction.parts, prepared.cachedVideos),
            extraction.imageAttachmentIds,
            this.imageStore,
            session,
          )
        : text;
    } catch (error) {
      if (prepared !== undefined) this.releaseSkillArgumentMedia(prepared);
      this.staging.releaseMedia([
        ...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds,
      ], []);
      this.failSessionRequest(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    const stagingLease = this.staging.create(
      [
        ...new Set([...extraction.imageAttachmentIds, ...extraction.videoAttachmentIds]),
        ...prepared.mediaAttachmentIds,
      ],
      prepared.stagingPaths,
      'user',
    );
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: text,
      skillNames: activations.map((activation) => activation.skillName),
      imageAttachmentIds:
        extraction.imageAttachmentIds.length > 0 ? extraction.imageAttachmentIds : undefined,
    };
    this.appendTranscriptEntry(entry);
    const skills = prepared.skills;
    const request = this.trackPendingEntries(
      [entry],
      this.dispatchPreparedInput(session, input, (parts) => session.promptWithSkills(parts, skills)),
    );
    this.staging.trackDispatch(stagingLease, request, (error) => {
      const recovered = this.handlePromptConflict({
        session,
        error,
        entries: [entry],
        retried: occupiedRetry,
        retry: () => this.runInlineSkillActivations(session, text, activations, extraction, true),
        restore: () => {
          this.staging.releaseRecalled([
            ...extraction.imageAttachmentIds,
            ...extraction.videoAttachmentIds,
          ]);
          this.restoreInputText(text);
        },
      });
      if (recovered) {
        this.staging.defer(stagingLease);
        return;
      }
      if (this.session === session && stagingLease !== undefined && stagingLease.turnId === undefined) {
        this.staging.defer(stagingLease);
        for (const id of stagingLease.mediaAttachmentIds) this.staging.releaseRecalled([id]);
        this.staging.releaseMedia([], stagingLease.paths);
      }
      this.handleSkillActivationError(session, error);
    });
  }

  private handleSkillActivationError(session: Session, error: unknown): void {
    if (this.session !== session) return;
    const message = `Skill activation failed: ${formatErrorMessage(error)}`;
    if (this.streamingUI.getTurnContext().turnId === undefined) this.failSessionRequest(message);
    else this.showError(message);
  }

  validateMediaCapabilities(extraction: {
    hasMedia: boolean;
    imageAttachmentIds: readonly number[];
    videoAttachmentIds: readonly number[];
    imageSnapshots?: readonly unknown[];
    mediaSnapshots?: readonly MediaAttachment[];
  }): boolean {
    if (!extraction.hasMedia) return true;
    if (
      (extraction.imageAttachmentIds.length > 0 || (extraction.imageSnapshots?.length ?? 0) > 0) &&
      !this.supportsCurrentModelCapability('image_in')
    ) {
      this.showError('Current model does not support image input.');
      return false;
    }
    if (
      (extraction.videoAttachmentIds.length > 0 ||
        extraction.mediaSnapshots?.some((snapshot) => snapshot.kind === 'video')) &&
      !this.supportsCurrentModelCapability('video_in')
    ) {
      this.showError('Current model does not support video input.');
      return false;
    }
    return true;
  }

  private supportsCurrentModelCapability(capability: string): boolean {
    const capabilities =
      this.state.appState.availableModels[this.state.appState.model]?.capabilities;
    if (capabilities === undefined) return true;
    return capabilities.includes(capability);
  }

  private async loadPersistedInputHistory(): Promise<void> {
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const entries = await loadInputHistory(file);
      for (const entry of entries) {
        this.state.editor.addToHistory(entry.content);
      }
      this.lastHistoryContent = entries.at(-1)?.content;
    } catch {
      // best-effort
    }
  }

  private async persistInputHistory(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    if (trimmed === this.lastHistoryContent) return;
    this.state.editor.addToHistory(trimmed);
    try {
      const file = getInputHistoryFile(this.state.appState.workDir);
      const written = await appendInputHistory(file, trimmed, this.lastHistoryContent);
      if (written) this.lastHistoryContent = trimmed;
    } catch {
      this.lastHistoryContent = trimmed;
    }
  }

  recallLastQueued(): QueuedMessage | undefined {
    if (this.state.queuedMessages.length === 0) return undefined;
    const last = this.state.queuedMessages.at(-1)!;
    if (this.steeringQueuedMessages.has(last)) return undefined;
    this.state.queuedMessages = this.state.queuedMessages.slice(0, -1);
    // A recall restores the draft into the editor — it is not a discard:
    // consumes the retains only, keeping the staged daemon uploads alive
    // (see `releaseRecalled`) so the restored draft resubmits them.
    this.staging.releaseRecalled([
      ...(last.imageAttachmentIds ?? []),
      ...(last.videoAttachmentIds ?? []),
    ]);
    return last;
  }

  /**
   * Cache-hint restore: a dismissed/hand-back interception returns its draft
   * to the editor — same semantics as a queue recall (consume the stash
   * extraction's retains; the staged daemon uploads stay alive for the
   * restored draft).
   */
  recallStashedMedia(extraction: ExtractionResult | undefined): void {
    if (extraction === undefined) return;
    this.staging.releaseRecalled([
      ...extraction.imageAttachmentIds,
      ...extraction.videoAttachmentIds,
    ]);
  }

  // =========================================================================
  // Session Requests / Queues
  // =========================================================================

  private enqueueMessage(
    text: string,
    options?: SendMessageOptions & {
      readonly inlineSkillActivations?: readonly InlineSkillActivation[];
    },
    mode?: 'prompt' | 'bash',
  ): void {
    this.state.queuedMessages.push(this.toQueuedMessage(text, options, mode));
    this.track('input_queue');
  }

  private toQueuedMessage(
    text: string,
    options?: SendMessageOptions & {
      readonly inlineSkillActivations?: readonly InlineSkillActivation[];
    },
    mode?: 'prompt' | 'bash',
  ): QueuedMessage {
    return {
      text,
      agentId: this.harness.interactiveAgentId,
      parts: options?.parts,
      imageAttachmentIds:
        options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
          ? options.imageAttachmentIds
          : undefined,
      videoAttachmentIds:
        options?.videoAttachmentIds !== undefined && options.videoAttachmentIds.length > 0
          ? options.videoAttachmentIds
          : undefined,
      mode,
      mediaSnapshots: options?.mediaSnapshots,
      inlineSkillActivations: options?.inlineSkillActivations,
    };
  }

  enqueueCompactCommand(args: string): boolean {
    if (this.state.queuedMessages.some((message) => message.mode === 'compact')) return false;
    const instruction = args.trim() || undefined;
    this.state.queuedMessages.push({
      text: '/compact' + (instruction !== undefined ? ` ${instruction}` : ''),
      agentId: this.harness.interactiveAgentId,
      mode: 'compact',
      compactInstruction: instruction,
      queuedAfterAutoSerial: this.autoCompactionSerial,
    });
    this.updateQueueDisplay();
    this.state.ui.requestRender();
    return true;
  }

  beginSessionRequest(): void {
    this.cacheHint.onTurnBegin();
    this.streamingUI.setTurnId(undefined);
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.streamingUI.resetToolCallState();

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

  failSessionRequest(message: string): void {
    this.programStatus.failRequest(message);
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    this.showError(message);
  }

  sendQueuedMessage(session: Session, item: QueuedMessage): void {
    if (item.mode === 'compact') {
      if (item.queuedAfterAutoSerial !== this.autoCompactionSerial) {
        this.showNotice('Skipped queued /compact — context was already auto-compacted.');
        this.drainOneQueuedMessage();
        return;
      }
      // Wait out a competing turn/compaction before refiring: draining while
      // busy would burn the retry budget on the same race. A session switch
      // (/new) clears the queue — do not resurrect the item into it.
      const retryWhenIdle = (): void => {
        setTimeout(() => {
          if (this.session !== session) return;
          if (
            this.state.appState.streamingPhase !== 'idle' ||
            this.state.appState.isCompacting ||
            this.deferUserMessages ||
            this.steeringQueuedMessages.size > 0
          ) {
            retryWhenIdle();
            return;
          }
          this.drainOneQueuedMessage();
        }, 1000);
      };
      // The fire races other clients holding the engine queue
      // (COMPACTION_UNABLE): requeue at the head with a bounded retry.
      const retryOrDrop = (error: unknown): void => {
        if (this.session !== session) return;
        const retries = (item.compactRetries ?? 0) + 1;
        if (retries >= 3) {
          const message = formatErrorMessage(error);
          this.setAppState({ isCompacting: false });
          this.programStatus.failRequest(message);
          this.showError(`Failed to run queued /compact: ${message}`);
          this.drainOneQueuedMessage();
          return;
        }
        this.state.queuedMessages.unshift({ ...item, compactRetries: retries });
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        retryWhenIdle();
      };
      // A compaction from another client may already be running by the time
      // the fire lands: the engine's begin() then silently no-ops (the SDK
      // returns void, so this is undetectable after the fact), dropping the
      // item. Requeue without firing — no attempt was made, no retry spent.
      if (this.state.appState.isCompacting) {
        this.state.queuedMessages.unshift(item);
        this.updateQueueDisplay();
        this.state.ui.requestRender();
        retryWhenIdle();
        return;
      }
      void session.compact({ instruction: item.compactInstruction }).catch(retryOrDrop);
      return;
    }
    if (item.mode === 'bash') {
      this.staging.releaseQueued([item]);
      void this.runShellCommandFromInput(item.text);
      return;
    }
    if (item.inlineSkillActivations !== undefined && item.inlineSkillActivations.length > 0) {
      // Media was extracted and validated at enqueue time; reuse the queued
      // parts rather than re-extracting from a possibly-cleared image store.
      // Expiring daemon refs refresh at dispatch, same as the plain tail below.
      const refreshed =
        item.parts === undefined
          ? []
          : [
              ...refreshExpiringImageFileRefs(
                item.parts,
                item.imageAttachmentIds ?? [],
                this.imageStore,
              ),
            ];
      const extraction: ExtractionResult = {
        parts: refreshed,
        hasMedia: refreshed.length > 0,
        imageAttachmentIds: item.imageAttachmentIds !== undefined ? [...item.imageAttachmentIds] : [],
        videoAttachmentIds: item.videoAttachmentIds !== undefined ? [...item.videoAttachmentIds] : [],
        imageSnapshots: [],
        mediaSnapshots: item.mediaSnapshots,
      };
      this.beginSessionRequest();
      this.runInlineSkillActivations(session, item.text, item.inlineSkillActivations, extraction);
      return;
    }
    const parts =
      item.parts === undefined
        ? undefined
        : refreshExpiringImageFileRefs(
            item.parts,
            item.imageAttachmentIds ?? [],
            this.imageStore,
          );
    this.harness.withInteractiveAgent(item.agentId ?? MAIN_AGENT_ID, () => {
      this.sendMessageInternal(session, item.text, {
        parts,
        imageAttachmentIds: item.imageAttachmentIds,
        videoAttachmentIds: item.videoAttachmentIds,
        occupiedRetry: item.occupiedRetry,
      });
    });
  }

  handleTurnStarted(event: TurnStartedEvent): void {
    this.staging.handleTurnStarted(event);
    this.surveyController.notifyTurnStarted(event.origin);
    this.programStatus.beginTurn(event.origin);
  }

  handleTurnEnded(event: TurnEndedEvent): void {
    this.staging.handleTurnEnded(event);
    this.surveyController.notifyTurnEnded(event.requestId);
    this.programStatus.finishTurn(event);
    this.state.footer.refreshGitStatus();
    if (event.reason === 'completed') void this.maybeAutoGenerateSessionTitle();
  }

  private async maybeAutoGenerateSessionTitle(): Promise<void> {
    const sessionId = this.state.appState.sessionId;
    if (sessionId.length === 0) return;
    if (this.state.appState.autoSessionTitle === false) return;
    const record = this.autoTitleAttempts.get(sessionId);
    if (record !== undefined && (record.done || record.attempts >= MAX_AUTO_TITLE_ATTEMPTS)) {
      return;
    }
    try {
      const config = await this.harness.getConfig();
      if (config.autoSessionTitle === false) return;
      this.autoTitleAttempts.set(sessionId, {
        attempts: (record?.attempts ?? 0) + 1,
        done: false,
      });
      const title = await this.harness.generateSessionTitle({
        id: sessionId,
        source: 'first_turn',
      });
      if (title !== undefined) {
        this.autoTitleAttempts.set(sessionId, { attempts: 0, done: true });
      }
    } catch {
      /* title generation is best-effort; the session keeps its current title */
    }
  }

  releaseStagingMedia(mediaAttachmentIds: readonly number[]): void {
    this.staging.releaseMedia(mediaAttachmentIds, []);
  }

  requestQueuedGoalPromotion(): void {
    this.sessionEventHandler.requestQueuedGoalPromotion();
  }

  private dispatchPreparedInput<T>(
    session: Session,
    input: T | Promise<T>,
    dispatch: (input: T) => Promise<void>,
  ): Promise<void> {
    if (!(input instanceof Promise)) return dispatch(input);
    let rejectPreparation!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectPreparation = reject; });
    const cancel = () => {
      rejectPreparation(new Error('Interrupted by user'));
      void session.cancel().catch(() => {});
    };
    this.cancelInFlight = cancel;
    return Promise.race([input, interrupted]).then((parts) => {
      if (this.cancelInFlight === cancel) this.cancelInFlight = undefined;
      if (this.session !== session) throw new Error('Session changed while preparing media.');
      return dispatch(parts);
    }).finally(() => {
      if (this.cancelInFlight === cancel) this.cancelInFlight = undefined;
    });
  }

  private sendMessageInternal(session: Session, input: string, options?: SendMessageOptions): void {
    const imageAttachmentIds =
      options?.imageAttachmentIds !== undefined && options.imageAttachmentIds.length > 0
        ? options.imageAttachmentIds
        : undefined;
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'user',
      turnId: undefined,
      renderMode: 'plain',
      content: input,
      imageAttachmentIds,
    };
    this.appendTranscriptEntry(entry);
    // A goal-active steer is buffered into the running goal turn — no new
    // turn.started will fire for handleTurnStarted to claim the lease — so
    // bind it to that turn here. The turn context must be read BEFORE
    // beginSessionRequest resets it, and only while a turn is actually live
    // (finalizeTurn clears the id at turn end; a queued dispatch can land
    // while the goal driver's next continuation turn is already streaming).
    const runningTurnId =
      this.state.appState.streamingPhase === 'idle' || this.state.appState.streamingPhase === 'shell'
        ? undefined
        : this.streamingUI.getTurnContext().turnId;
    this.beginSessionRequest();

    // Compression captions for pasted images are authored here — not at
    // extraction — because only now is the session (and its media-originals
    // dir) known: extraction runs before a first session exists.
    const sdkInput =
      options?.parts !== undefined
        ? resolveSessionOriginalCaptions(
            options.parts,
            options.imageAttachmentIds ?? [],
            this.imageStore,
            session,
          )
        : input;
    const goalActive = this.state.appState.goal?.status === 'active';
    // The lease normally arrives pre-created by sendNormalUserInput (carrying
    // its exact-binding submission id). Queued dispatches and steer batches
    // arrive with raw ids instead: a prompt submission carrying staged
    // media gets a client-chosen prompt id minted here — the engine echoes it
    // on the consuming turn's `turn.started` (`promptId`), so the lease binds
    // exactly instead of through the origin heuristic. The goal-steer path
    // binds its lease explicitly below, so it gets no id.
    const stagingIds = [
      ...(options?.imageAttachmentIds ?? []),
      ...(options?.videoAttachmentIds ?? []),
    ];
    const stagingLease =
      options?.lease ??
      this.staging.create(
        // One retain per unique id per extraction: dedupe repeated placeholder
        // occurrences so the lease's id multiplicity matches the retain count.
        [...new Set(stagingIds)],
        [],
        'user',
        !goalActive && stagingIds.length > 0 ? randomUUID() : undefined,
      );
    const submissionId = stagingLease?.submissionId;
    const resend = (): void => {
      this.state.queuedMessages.unshift({
        ...this.toQueuedMessage(input, options),
        occupiedRetry: true,
      });
      this.updateQueueDisplay();
      this.drainQueueIfIdle();
    };
    const restoreInput = (): void => {
      this.staging.releaseRecalled(stagingIds);
      this.restoreInputText(input);
    };
    // While a goal is being pursued the engine holds its active turn across the
    // whole continuation loop, so a fresh prompt races the goal driver at every
    // continuation boundary and is rejected with `turn.agent_busy`, dropping
    // the message. Steer instead: the engine buffers it into the running goal
    // turn, or launches a turn of its own if the loop just ended.
    if (goalActive) {
      if (runningTurnId !== undefined) this.staging.bindToTurn(stagingLease, runningTurnId);
      const request = this.trackPendingEntries(
        [entry],
        this.dispatchPreparedInput(session, sdkInput, (parts) => session.steer(parts)),
      );
      void request.then(
        () => {
          if (this.session === session) this.programStatus.markUserSteer();
        },
        () => {},
      );
      this.staging.trackDispatch(stagingLease, request, (error) => {
        const recovered = this.handlePromptConflict({
          session,
          error,
          entries: [entry],
          retried: options?.occupiedRetry === true,
          retry: resend,
          restore: restoreInput,
        });
        if (recovered) {
          this.staging.defer(stagingLease);
          return;
        }
        // Same reset as the prompt path: beginSessionRequest already moved the
        // TUI to the waiting phase, and no turn events may follow a failed
        // steer (e.g. the session is gone), which would leave the UI stuck
        // queueing input behind a request that never completes.
        if (this.session === session) this.failSessionRequest(`Failed to steer: ${formatErrorMessage(error)}`);
      });
      return;
    }
    const request = this.trackPendingEntries(
      [entry],
      this.dispatchPreparedInput(
        session, sdkInput, (parts) => session.prompt(parts, { promptId: submissionId }),
      ),
    );
    this.staging.trackDispatch(stagingLease, request, (error) => {
      const recovered = this.handlePromptConflict({
        session,
        error,
        entries: [entry],
        retried: options?.occupiedRetry === true,
        retry: resend,
        restore: restoreInput,
      });
      if (recovered) {
        this.staging.defer(stagingLease);
        return;
      }
      if (this.session === session) this.failSessionRequest(`Failed to send: ${formatErrorMessage(error)}`);
    });
  }

  private trackPendingEntries(
    entries: readonly TranscriptEntry[],
    request: Promise<void>,
  ): Promise<void> {
    for (const entry of entries) this.pendingPromptEntries.add(entry);
    const settle = (): void => {
      for (const entry of entries) this.pendingPromptEntries.delete(entry);
    };
    void request.then(settle, settle);
    return request;
  }

  private handlePromptConflict(args: {
    session: Session;
    error: unknown;
    entries?: readonly TranscriptEntry[];
    retried: boolean;
    retry: () => void;
    restore: () => void;
  }): boolean {
    const { session, error, entries, retried, retry, restore } = args;
    if (this.session?.id !== session.id || !isSessionOccupiedError(error)) return false;
    if (entries !== undefined) this.removeTranscriptEntries(entries);
    this.setAppState({ streamingPhase: 'idle' });
    this.resetLivePane();
    showSessionOccupancyPrompt(this, { session, error, retried, retry, restore });
    return true;
  }

  // The SDK reloads a stale session and retries the rejected call once this
  // resolves; the request stays in flight meanwhile, so input submitted during
  // the reload queues against the reloaded session.
  private async refreshAfterStaleReload(session: Session): Promise<void> {
    if (this.session !== session) return;
    const pending = this.state.transcriptEntries.filter((entry) =>
      this.pendingPromptEntries.has(entry),
    );
    await this.reloadCurrentSessionView(session, 'Loaded updates from another client.', {
      replayHistory: true,
    });
    for (const entry of pending) this.appendTranscriptEntry(entry);
    this.track('session_stale_reload');
  }

  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
    occupiedRetry = false,
  ): void {
    let rewrite: ReturnType<typeof rewriteMediaPlaceholders>;
    try {
      rewrite = rewriteMediaPlaceholders(args, this.imageStore, 'tag');
    } catch (error) {
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      return;
    }
    const stagingLease = this.staging.create(
      [...new Set(rewrite.imageAttachmentIds)],
      rewrite.stagingPaths,
      'plugin_command',
    );
    if (!this.validateMediaCapabilities(rewrite)) {
      this.staging.release(stagingLease);
      return;
    }
    this.beginSessionRequest();
    this.staging.trackDispatch(
      stagingLease,
      session.activatePluginCommand(pluginId, commandName, rewrite.text),
      (error) => {
        const recovered = this.handlePromptConflict({
          session,
          error,
          retried: occupiedRetry,
          retry: () => this.activatePluginCommand(session, pluginId, commandName, args, true),
          restore: () => {
            this.staging.releaseRecalled(rewrite.imageAttachmentIds);
            this.restoreInputText(`/${pluginId}:${commandName}${args.length > 0 ? ` ${args}` : ''}`);
          },
        });
        if (recovered) {
          this.staging.defer(stagingLease);
          return;
        }
        this.failSessionRequest(
          `Command "${pluginId}:${commandName}" failed: ${formatErrorMessage(error)}`,
        );
      },
    );
  }

  private sendMessage(session: Session, input: string, options?: SendMessageOptions): void {
    // Submission order must survive a mid-turn compaction: objectives queued
    // while compacting stay queued when the turn outlives the compaction, so
    // steering this input ahead of them would reorder the conversation.
    // Prompt-only backlog rides along in the same steer batch, ahead of the
    // new input; a non-steerable backlog (bash, slash-skill, inline-skill
    // bundle) cannot, and then this input queues behind it instead.
    if (
      this.canSteerQueueIntoRunningTurn() &&
      this.state.queuedMessages.every(isSteerableQueuedMessage)
    ) {
      // Same lease hand-off as the queue path below: the pre-dispatch lease
      // defers to the raw ids on the queue item, which re-leases inside
      // steerMessage and binds to the running turn.
      this.staging.defer(options?.lease);
      this.state.queuedMessages.push(this.toQueuedMessage(input, options));
      this.updateQueueDisplay();
      this.steerQueuedMessagesIntoRunningTurn();
      return;
    }
    if (
      this.deferUserMessages ||
      this.steeringQueuedMessages.size > 0 ||
      this.state.appState.streamingPhase !== 'idle' ||
      this.state.appState.isCompacting
    ) {
      // A queued message re-leases its staged media at dequeue dispatch; the
      // pre-dispatch lease defers to the queue item's raw ids.
      this.staging.defer(options?.lease);
      this.enqueueMessage(input, options);
      return;
    }
    this.sendMessageInternal(session, input, options);
  }

  // Tower mode keeps the main agent as a long-lived coordinator: while its
  // turn is live, input steers into that turn instead of queueing behind it,
  // so consecutive /tower objectives are accepted immediately rather than
  // serialized one turn at a time. A running WaitFor steers the same way: the
  // steer ends the wait at once and the model reads the new input, instead of
  // the input queueing until the wait times out. A foreground shell command
  // ('shell') has no turn to steer into and keeps queue semantics, as do
  // input deferral and compaction.
  private canSteerQueueIntoRunningTurn(): boolean {
    const phase = this.state.appState.streamingPhase;
    return (
      (this.state.appState.towerMode || this.streamingUI.isWaitForRunning()) &&
      phase !== 'idle' &&
      phase !== 'shell' &&
      !this.deferUserMessages &&
      !this.state.appState.isCompacting
    );
  }

  steerQueuedMessagesIntoRunningTurn(manual = false): void {
    const session = this.session;
    if (session === undefined || this.steeringQueuedMessages.size > 0) return;
    if (manual ? !this.canManuallySteer() : !this.canSteerQueueIntoRunningTurn()) return;
    // A queued /compact is a FIFO barrier for steering, manual or automatic:
    // messages behind it must wait for the compaction, not jump into the
    // pre-compaction context.
    const firstCompact = this.state.queuedMessages.findIndex((message) => message.mode === 'compact');
    const beforeBarrier = this.state.queuedMessages.slice(
      0,
      firstCompact === -1 ? this.state.queuedMessages.length : firstCompact,
    );
    const batch = manual
      ? beforeBarrier.filter((message) => message.mode !== 'bash')
      : beforeBarrier;
    if (batch.length === 0 || (!manual && !batch.every(isSteerableQueuedMessage))) return;
    const pending = [...batch];
    const sendNext = (): void => {
      if (this.deferUserMessages || this.state.appState.isCompacting) return;
      let first = pending.shift();
      while (first !== undefined && !this.state.queuedMessages.includes(first)) first = pending.shift();
      if (first === undefined) {
        this.updateQueueDisplay();
        if (!manual && this.canSteerQueueIntoRunningTurn()) {
          this.steerQueuedMessagesIntoRunningTurn();
        } else {
          this.drainQueueIfIdle();
        }
        return;
      }
      const group = [first];
      if (first.inlineSkillActivations === undefined) {
        while (pending[0] !== undefined && pending[0].inlineSkillActivations === undefined) {
          const next = pending.shift()!;
          if (this.state.queuedMessages.includes(next)) group.push(next);
        }
      }
      for (const message of group) this.steeringQueuedMessages.add(message);
      this.updateQueueDisplay();
      const items = group.map((message) => {
        const item = toSteerInputItem(message);
        if (message.parts === undefined) return item;
        return {
          ...item,
          parts: refreshExpiringImageFileRefs(
            message.parts,
            message.imageAttachmentIds ?? [],
            this.imageStore,
          ),
        };
      });
      this.steerMessage(session, items, (steered) => {
        for (const message of group) this.steeringQueuedMessages.delete(message);
        if (this.session !== session) return;
        if (steered) this.programStatus.markUserSteer();
        if (steered || manual) {
          const done = new Set(group);
          this.state.queuedMessages = this.state.queuedMessages.filter((message) => !done.has(message));
        }
        if (!steered) {
          this.staging.releaseQueued(group.filter((message) => !this.state.queuedMessages.includes(message)));
        }
        this.updateQueueDisplay();
        if (steered || manual) sendNext();
        else this.drainQueueIfIdle();
      }, manual);
    };
    sendNext();
  }

  canManuallySteer(): boolean {
    const phase = this.state.appState.streamingPhase;
    return (
      !this.deferUserMessages &&
      !this.state.appState.isCompacting &&
      phase !== 'idle' &&
      phase !== 'shell' &&
      this.steeringQueuedMessages.size === 0
    );
  }

  isSteeringQueuedMessages(): boolean {
    return this.steeringQueuedMessages.size > 0;
  }

  private drainQueueIfIdle(): void {
    if (
      this.state.appState.streamingPhase !== 'idle' ||
      this.deferUserMessages ||
      this.state.appState.isCompacting ||
      this.state.queuedMessageDispatchPending
    ) {
      return;
    }
    this.drainOneQueuedMessage();
  }

  steerMessage(
    session: Session,
    input: readonly SteerInputItem[],
    onSettled?: (steered: boolean) => void,
    manual = false,
    occupiedRetry = false,
  ): void {
    if (this.deferUserMessages || this.state.appState.isCompacting) {
      if (onSettled !== undefined) {
        onSettled(false);
      } else {
        for (const item of input) this.enqueueMessage(item.text, item);
      }
      return;
    }
    const activations = input.flatMap((item) => item.inlineSkillActivations ?? []);
    let prepared: PreparedSkillActivations | undefined;
    let resolvedInput: readonly (SteerInputItem | Promise<SteerInputItem>)[];
    try {
      if (activations.length > 0) {
        prepared = this.prepareSkillActivations(
          activations,
          input.some((item) => item.mediaSnapshots !== undefined)
            ? input.flatMap((item) => item.mediaSnapshots ?? [])
            : undefined,
        );
      }
      resolvedInput = input.map((item) => {
        if (item.parts === undefined) return item;
        const parts = resolveSessionOriginalCaptions(
          prepared === undefined ? item.parts : omitExpiredVideoFileRefs(item.parts, prepared.cachedVideos),
          item.imageAttachmentIds ?? [], this.imageStore, session,
        );
        return parts instanceof Promise ? parts.then((parts) => ({ ...item, parts })) : { ...item, parts };
      });
    } catch (error) {
      if (prepared !== undefined) this.releaseSkillArgumentMedia(prepared);
      this.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}`);
      onSettled?.(false);
      return;
    }
    const startsNewTurn = this.state.appState.streamingPhase === 'idle';
    if (startsNewTurn) this.beginSessionRequest();
    const steeredEntries: TranscriptEntry[] = input.map((item) => ({
      id: nextTranscriptId(),
      kind: 'user',
      turnId: this.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: item.text,
      skillNames: item.inlineSkillActivations?.map((activation) => activation.skillName),
      imageAttachmentIds:
        item.imageAttachmentIds !== undefined && item.imageAttachmentIds.length > 0
          ? item.imageAttachmentIds
          : undefined,
    }));
    for (const entry of steeredEntries) this.appendTranscriptEntry(entry);
    const mediaAttachmentIds = input.flatMap((item) => [
      ...new Set([...(item.imageAttachmentIds ?? []), ...(item.videoAttachmentIds ?? [])]),
    ]);
    const stagingLease = this.staging.create(
      [...mediaAttachmentIds, ...(prepared?.mediaAttachmentIds ?? [])],
      prepared?.stagingPaths ?? [],
      'user',
    );
    const currentTurnId = this.streamingUI.getTurnContext().turnId;
    // Skill steers may not merge into the current turn: an untracked active
    // turn (e.g. a goal continuation) has no steerable prompt, so the engine
    // queues the submission — and binding the lease here would release its
    // media when that unrelated turn ends. Leave skill leases unclaimed so
    // the submission's own turn.started claims them; a merged steer simply
    // retires its media at session close instead.
    if (currentTurnId !== undefined && prepared === undefined) this.staging.bindToTurn(stagingLease, currentTurnId);
    const dispatch = (items: readonly SteerInputItem[]) => prepared === undefined
      ? session.steer(combineSteerInput(items))
      : session.promptWithSkills(combineSteerInput(items), prepared.skills, { steerIfActive: true });
    const request = this.trackPendingEntries(
      steeredEntries,
      this.dispatchPreparedInput(
        session,
        resolvedInput.some((item) => item instanceof Promise)
          ? Promise.all(resolvedInput.map((item) => Promise.resolve(item)))
          : resolvedInput as readonly SteerInputItem[],
        dispatch,
      ),
    );
    if (onSettled !== undefined) {
      void request.then(
        () => onSettled(true),
        () => {},
      );
    }
    this.staging.trackDispatch(stagingLease, request, (error) => {
      if (this.session !== session) {
        onSettled?.(false);
        return;
      }
      const recovered = this.handlePromptConflict({
        session,
        error,
        entries: prepared === undefined && !manual ? steeredEntries : undefined,
        retried: occupiedRetry,
        retry: () => this.steerMessage(session, input, onSettled, manual, true),
        restore: () => {
          this.staging.releaseRecalled(mediaAttachmentIds);
          this.restoreInputText(input.map((item) => item.text).join('\n'));
          onSettled?.(false);
        },
      });
      if (recovered) {
        this.staging.defer(stagingLease);
        return;
      }
      const message = `Failed to steer: ${formatErrorMessage(error)}`;
      if (startsNewTurn && this.streamingUI.getTurnContext().turnId === undefined) {
        this.failSessionRequest(message);
      } else {
        this.showError(message);
      }
      if (onSettled !== undefined) {
        this.staging.defer(stagingLease);
        if (prepared !== undefined) this.releaseSkillArgumentMedia(prepared);
        if (prepared === undefined && !manual) this.removeTranscriptEntries(steeredEntries);
        onSettled(false);
      }
    });
  }

  private removeTranscriptEntries(entries: readonly TranscriptEntry[]): void {
    const doomed = new Set(entries);
    const componentsToRemove = this.state.transcriptContainer.children.filter((child) => {
      const entry = getTranscriptComponentEntry(child);
      return entry !== undefined && doomed.has(entry);
    });
    for (const child of componentsToRemove) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }
    this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !doomed.has(e));
    this.state.ui.requestRender();
  }

  // =========================================================================
  // State & Accessors
  // =========================================================================

  setStartupReady(): void {
    this.state.startupState = 'ready';
  }

  clearQueuedMessages(): void {
    const queued = this.state.queuedMessages;
    this.state.queuedMessages = [];
    this.staging.releaseQueued(queued.filter((message) => !this.steeringQueuedMessages.has(message)));
  }

  shiftQueuedMessage(): QueuedMessage | undefined {
    if (this.steeringQueuedMessages.size > 0) return undefined;
    return this.state.queuedMessages.shift();
  }

  pushTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
  }

  setExternalEditorRunning(running: boolean): void {
    this.state.externalEditorRunning = running;
    if (!running) this.modelMigration.retry();
  }

  setTasksBrowser(value: TUIState['tasksBrowser']): void {
    this.state.tasksBrowser = value;
  }

  appendStartupNotice(extra: string): void {
    this.startupNotice = combineStartupNotice(this.startupNotice, extra);
  }

  get backgroundTasks(): ReadonlyMap<string, BackgroundTaskInfo> {
    return this.sessionEventHandler.backgroundTasks;
  }

  handleBackgroundTaskStatus(info: BackgroundTaskInfo): void {
    this.programStatus.updateBackgroundTask(info);
  }

  restoreProgramStatusBackground(tasks: readonly BackgroundTaskInfo[]): void {
    this.programStatus.restoreBackgroundTasks(tasks);
  }

  handleCompactionCancelled(): void {
    this.programStatus.finishCompaction();
  }

  getCurrentSessionId(): string {
    return this.state.appState.sessionId;
  }

  hasSessionContent(): boolean {
    return this.state.transcriptEntries.length > 0;
  }

  setExitOpenUrl(url: string): void {
    this.exitOpenUrl = url;
  }

  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void {
    this.exitForegroundTask = task;
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

  setAppState(patch: Partial<AppState>): void {
    if (!hasPatchChanges(this.state.appState, patch)) return;
    const additionalDirsChanged =
      'additionalDirs' in patch &&
      !sameStringArrays(this.state.appState.additionalDirs, patch.additionalDirs ?? []);
    const busyChanged = 'streamingPhase' in patch || 'isCompacting' in patch;
    Object.assign(this.state.appState, patch);
    if ('planMode' in patch) this.updateEditorBorderHighlight();
    this.state.footer.setState(this.state.appState);
    this.updateActivityPane();
    if (busyChanged) {
      this.updateQueueDisplay();
      this.sessionEventHandler.retryQueuedGoalPromotion();
    }
    if (busyChanged || 'sessionTitle' in patch) this.programStatus.refresh();
    if (additionalDirsChanged) this.setupAutocomplete();
    this.modelMigration.retry();
    this.state.ui.requestRender();
  }

  patchLivePane(patch: Partial<LivePaneState>): void {
    if (!hasPatchChanges(this.state.livePane, patch)) return;
    Object.assign(this.state.livePane, patch);
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  resetLivePane(): void {
    this.state.livePane = { ...INITIAL_LIVE_PANE };
    this.updateActivityPane();
    this.state.ui.requestRender();
  }

  private syncAdditionalDirs(session: Session): void {
    const additionalDirs = session.summary?.additionalDirs ?? [];
    if (sameStringArrays(this.state.appState.additionalDirs, additionalDirs)) return;
    this.setAppState({ additionalDirs: [...additionalDirs] });
  }

  // =========================================================================
  // Session Environment
  // =========================================================================

  requireSession(): Session {
    if (this.session === undefined) {
      throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    }
    return this.session;
  }

  /**
   * Seed appState with the config defaults the v2 engine would apply at
   * createSession time (model, permission, plan mode, thinking effort,
   * context cap), so the footer and the lazy create path reflect them while
   * no session exists. Runs at session-less startup and after auth/config
   * refreshes, so externally edited defaults take effect before the first
   * lazy-created session. `includeModel: false` leaves the pending model,
   * effort, and context cap untouched while hydrating the other defaults.
   */
  async hydrateLazyConfigDefaults(includeModel = true): Promise<void> {
    const { startup } = this.options;
    const config = await this.harness.getConfig({ reload: true });
    this.creationEnvironment = await this.harness.resolveSessionEnvironment({
      workDir: this.state.appState.workDir,
      environmentId: startup.environment,
      environmentCwd: startup.environmentCwd,
    });
    this.refreshSlashCommandAutocomplete();
    const patch: Partial<AppState> = includeModel
      ? lazyModelSelection(config, startup.model ?? config.defaultModel)
      : {};
    // CLI --auto/--yolo/--plan win over config defaults; the flags are
    // re-applied by applyStartupPermissionAndPlanToAppState at startup.
    if (!startup.auto && !startup.yolo) {
      // Reset to manual when the default was removed from config — a stale
      // elevated mode must not be passed to the first lazy-created session.
      patch.permissionMode = config.defaultPermissionMode ?? 'manual';
    }
    // Track the config default itself (vs an explicit CLI --plan) so the lazy
    // create path can tell which one would activate plan mode; a removed
    // default also clears the hydrated footer value.
    patch.configDefaultPlanMode = config.defaultPlanMode === true;
    if (!startup.plan) {
      patch.planMode = config.defaultPlanMode === true;
    }
    if (startup.agentProfile !== undefined || startup.agentFiles !== undefined) {
      patch.agentProfile = startup.agentProfile;
      patch.agentFiles = startup.agentFiles?.length ? [...startup.agentFiles] : undefined;
    }
    this.setAppState(patch);
  }

  private creationEnvironment?: { readonly environmentId: string; readonly cwd?: string };

  private async environmentForNewSession(): Promise<
    { readonly environmentId: string; readonly environmentCwd?: string } | undefined
  > {
    const session = this.session;
    if (session !== undefined) {
      const binding = await session.getEnvironment();
      if (binding.environmentId !== 'local' && binding.cwd === undefined) {
        throw new Error(
          `Cannot start a new session on ${binding.environmentId}: the current binding has no working directory`,
        );
      }
      return {
        environmentId: binding.environmentId,
        environmentCwd: binding.cwd,
      };
    }
    const startupEnvironment = this.options.startup.environment;
    if (startupEnvironment === undefined) return undefined;
    return {
      environmentId: startupEnvironment,
      environmentCwd: this.options.startup.environmentCwd,
    };
  }

  private async createSessionFromCurrentState(
    bindStartupAgent = false,
    inherited?: { readonly environmentId: string; readonly environmentCwd?: string },
  ): Promise<Session> {
    // Background warm-up of the cache-hint config on every new session.
    this.cacheHint.refreshConfigInBackground();
    const model = this.state.appState.model.trim();
    if (model.length === 0) {
      throw new Error(LLM_NOT_SET_MESSAGE);
    }
    // With an active session, carry the live plan state. Session-less (lazy
    // creation / `/new` before the first session) on v2, pass only the
    // explicit CLI --plan intent — and only when the engine is not already
    // applying `defaultPlanMode` at create time (sessionLifecycleService),
    // since re-entering an active plan mode throws.
    const explicitPlanMode =
      this.session !== undefined
        ? this.state.appState.planMode
        : this.options.startup.plan && this.state.appState.configDefaultPlanMode !== true;
    const options: MutableCreateSessionOptions = {
      workDir: this.state.appState.workDir,
      model,
      // With an active session, carry the live effort. Session-less (lazy
      // creation / `/new` before the first session), carry the session-only
      // thinking override chosen via Alt+S if any — never the initial 'off'
      // default, which would force thinking off where the engine's config or
      // model default would apply.
      thinking:
        this.session === undefined
          ? this.state.appState.lazySessionThinking
          : this.state.appState.thinkingEffort,
      permission: this.state.appState.permissionMode,
      planMode: explicitPlanMode ? true : undefined,
    };
    const additionalDirs =
      this.session === undefined && this.state.appState.sessionId === '' && !this.hasSessionHistory
        ? (this.options.startup.additionalDirs ?? [])
        : this.state.appState.additionalDirs;
    if (additionalDirs.length > 0) {
      options.additionalDirs = [...additionalDirs];
    }
    if (bindStartupAgent) {
      // --agent / --agent-file bind only the first lazy-created session.
      // `/new` keeps the default profile.
      if (this.state.appState.agentProfile !== undefined) {
        options.agentProfile = this.state.appState.agentProfile;
      }
      if (this.state.appState.agentFiles !== undefined) {
        options.agentFiles = [...this.state.appState.agentFiles];
      }
      if (this.options.startup.environment !== undefined) {
        options.environmentId = this.options.startup.environment;
        options.environmentCwd = this.options.startup.environmentCwd;
      }
    } else if (inherited !== undefined) {
      // `/new` keeps the live binding. Before the first session exists, it
      // inherits the startup environment flags instead.
      options.environmentId = inherited.environmentId;
      options.environmentCwd = inherited.environmentCwd;
    }
    return this.harness.createSession(options);
  }

  promptSshPassword(environmentId: string): Promise<string | undefined> {
    return promptSshPassword(this, environmentId);
  }

  /**
   * Lazy-create the session on first use (v2 engine, session-less startup).
   * Returns the existing session, or creates one from the current state and
   * runs the same assembly `createNewSession` performs. Returns undefined and
   * shows the error when creation fails; callers must still guard on
   * `appState.model`.
   *
   * Concurrent first-use triggers (a double Enter, or a slash command right
   * after a prompt) both observe `session === undefined`, so the first caller
   * owns the creation and the rest share the in-flight promise — otherwise
   * two sessions would be created and the later `setSession` would close the
   * first one mid-dispatch.
   */
  async ensureSession(): Promise<Session | undefined> {
    // Even when a session is already assigned, a previous lazy creation may
    // still be finishing its assembly (runtime sync, command refresh,
    // subscription). Wait for it so callers never dispatch against a
    // partially initialized session.
    if (this.ensureSessionPromise !== null) return this.ensureSessionPromise;
    if (this.session !== undefined) return this.session;
    this.ensureSessionPromise = this.lazyCreateSession().finally(() => {
      this.ensureSessionPromise = null;
    });
    return this.ensureSessionPromise;
  }

  /** Await in-flight session assembly — lazy creation or a `/new` replacement — if any; no-op otherwise. */
  async waitForSessionAssembly(): Promise<void> {
    await this.ensureSessionPromise;
    await this.newSessionPromise;
  }

  /** True while a `/new` replacement is assembling; idle checks must treat it as busy. */
  get sessionReplacementInFlight(): boolean {
    return this.newSessionPromise !== null;
  }

  private async lazyCreateSession(): Promise<Session | undefined> {
    const environmentId = this.creationEnvironment?.environmentId ?? this.options.startup.environment;
    const progress = environmentId !== undefined && environmentId !== 'local'
      ? this.showProgressSpinner(`Connecting to ${environmentId}…`)
      : undefined;
    let ready = false;
    try {
      let session: Session;
      try {
        session = await this.createSessionFromCurrentState(true);
      } catch (error) {
        const msg = formatErrorMessage(error);
        this.showError(`Failed to start a session: ${msg}`);
        return undefined;
      }
      this.resetSessionRuntime({ keepQueuedMessages: true });
      await this.setSession(session, 0);
      this.setAppState({ sessionId: session.id });
      try {
        await this.activateRuntime();
        await this.syncRuntimeState(session);
      } catch (error) {
        this.sessionEventHandler.startSubscription();
        const msg = formatErrorMessage(error);
        this.showError(`Post-create setup failed: ${msg}`);
        return undefined;
      }
      try {
        await this.refreshSkillCommands(session);
        await this.refreshPluginCommands(session);
      } catch {
        /* keep the new session usable even if dynamic skills fail */
      }
      this.sessionEventHandler.startSubscription();
      void this.showSessionWarnings(session);
      // The session-only thinking override was consumed by this session; the
      // runtime status now owns the displayed effort.
      if (this.state.appState.lazySessionThinking !== undefined) {
        this.setAppState({ lazySessionThinking: undefined });
      }
      ready = true;
      return session;
    } finally {
      progress?.stop({ ok: ready, label: ready ? 'Session ready.' : 'Session setup failed.' });
    }
  }

  async setSession(
    session: Session,
    initialUserTurnCount = session.getResumeState()?.agents[MAIN_AGENT_ID]?.userTurnCount,
  ): Promise<void> {
    const previous = this.unloadCurrentSession('switching session');
    await previous?.close();
    // A session switch abandons the previous session's in-flight staging
    // leases and retires its history-owned cache copies. Do this at the
    // boundary so retired paths cannot accumulate until process shutdown.
    // Only when actually replacing a live session, though: on lazy first
    // creation the outstanding lease belongs to the new session's first
    // prompt, whose dispatch continues right after this — releasing it here
    // would delete the staged media (e.g. a pasted image's daemon upload)
    // before the engine's intake can read it.
    if (previous !== undefined) this.staging.releaseAll();
    this.session = session;
    this.hasSessionHistory = true;
    this.surveyController.seedUserTurnCount(initialUserTurnCount);
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
    this.syncAdditionalDirs(session);
  }

  async syncRuntimeState(session: Session = this.requireSession()): Promise<void> {
    const [status, goalResult] = await Promise.all([session.getStatus(), session.getGoal()]);
    this.setAppState({
      sessionId: session.id,
      model: status.model ?? '',
      thinkingEffort: status.thinkingEffort,
      permissionMode: status.permission,
      planMode: status.planMode,
      swarmMode: status.swarmMode ?? false,
      towerMode: status.towerMode ?? false,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
      cumulativeTokens:
        status.usage?.total === undefined ? 0 : sumTokenUsage(status.usage.total),
      sessionTitle: session.summary?.title ?? null,
      goal: goalResult.goal,
    });
    this.syncAdditionalDirs(session);
    await this.refreshEnvironmentSlot(session);
  }

  /**
   * Sync the footer environment slot with the session's current binding and the
   * environment registry's connection status. A disconnect is footer state only;
   * it does not write a transcript notice. Runs at session load, explicit
   * environment actions, and on the engine's environment.status.changed hint
   * (mid-session drops, reconnects).
   */
  async refreshEnvironmentSlot(session: Session | undefined = this.session): Promise<void> {
    if (session === undefined) return;
    let next: EnvironmentSlotState;
    try {
      next = await session.getEnvironmentState();
    } catch {
      return;
    }
    if (this.session !== session) return;
    const previous = this.state.appState.environment;
    if (
      previous !== undefined &&
      previous.environmentId === next.environmentId &&
      previous.type === next.type &&
      previous.status === next.status &&
      previous.cwd === next.cwd &&
      previous.connectError === next.connectError
    ) {
      return;
    }
    this.setAppState({ environment: next });
    if (
      previous?.environmentId !== next.environmentId ||
      previous?.type !== next.type ||
      previous?.cwd !== next.cwd
    ) {
      this.setupAutocomplete();
    }
  }

  // Apply --auto/--yolo/--plan startup flags to a resumed session. The resumed
  // session may already be in plan mode from its persisted records, and
  // re-entering plan mode throws, so only enable it when it is not active yet.
  // setPermission is idempotent and needs no such guard.
  private async applyStartupModesToResumedSession(session: Session): Promise<void> {
    const { startup } = this.options;
    if (startup.auto) {
      await session.setPermission('auto');
    } else if (startup.yolo) {
      await session.setPermission('yolo');
    }
    if (startup.plan) {
      const status = await session.getStatus();
      if (!status.planMode) {
        await session.setPlanMode(true);
      }
    }
  }

  // Re-apply startup flags that the user explicitly passed on the command line.
  // syncRuntimeState and session-replay hydration can both read stale persisted
  // values, so this guarantees the footer reflects the CLI intent.
  private applyStartupPermissionAndPlanToAppState(): void {
    const { startup } = this.options;
    if (startup.auto) {
      this.setAppState({ permissionMode: 'auto' });
    } else if (startup.yolo) {
      this.setAppState({ permissionMode: 'yolo' });
    }
    if (startup.plan) {
      this.setAppState({ planMode: true });
    }
  }

  // Plan mode is set by createSession — do not re-enter it here.
  private async activateRuntime(): Promise<void> {
    const session = this.requireSession();
    await session.setPermission(this.state.appState.permissionMode);
    await this.syncRuntimeState(session);
  }

  async closeSession(reason: string): Promise<void> {
    const previous = this.unloadCurrentSession(reason);
    await previous?.close();
    this.staging.releaseAll();
  }

  private unloadCurrentSession(reason: string): Session | undefined {
    const previous = this.session;
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    previous?.setStaleReloadHandler(undefined);
    previous?.setApprovalHandler(undefined);
    previous?.setQuestionHandler(undefined);
    this.approvalController.cancelAll(reason);
    this.questionController.cancelAll(reason);
    this.session = undefined;
    this.state.swarmModeEntry = undefined;
    this.harness.setTelemetryContext({ sessionId: null });
    this.setAppState({ goal: null, environment: undefined });
    return previous;
  }

  private clearReverseRpcPanels(): void {
    for (const dispose of this.reverseRpcDisposers) {
      dispose();
    }
    this.reverseRpcDisposers.length = 0;
  }

  private registerSessionHandlers(session: Session): void {
    session.setStaleReloadHandler(() => this.refreshAfterStaleReload(session));
    session.setApprovalHandler(
      createApprovalRequestHandler(
        this.approvalController,
        (request, response) => {
          this.appendApprovalTranscriptEntry(request, response);
        },
        () => this.resolveApprovalEnvironment(),
        this.programStatus,
      ),
    );
    session.setQuestionHandler(
      createQuestionAskHandler(this.questionController, this.programStatus),
    );
  }

  async fetchSessions(scope: 'cwd' | 'all' = this.state.sessionsScope): Promise<void> {
    this.state.loadingSessions = true;
    this.state.sessionsScope = scope;
    this.state.sessionsNextCursor = undefined;
    this.state.sessionsLoadingMore = false;
    try {
      const page = await this.harness.listSessionsPage({
        workDir: scope === 'all' ? undefined : this.state.appState.workDir,
        limit: SESSION_LIST_PAGE_SIZE,
      });
      this.state.sessionsNextCursor = page.nextCursor;
      this.state.sessions = sessionRowsForPicker(
        page.items,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
    } catch (error) {
      // The picker must keep working (it renders the empty state), but a
      // swallowed failure surfaces as a misleading "No sessions found." —
      // keep a log trail so the real error stays discoverable.
      log.warn('failed to fetch sessions for picker', { error: String(error) });
    } finally {
      this.state.loadingSessions = false;
    }
  }

  /**
   * Pulls the next keyset page into the session picker (scroll-bottom paging).
   * A scope switch or picker close bumps `sessionPickerScopeRequestToken`,
   * which makes an in-flight append discard its result. Returns whether a page
   * was appended — callers draining pages stop on the first `false`.
   * Scroll triggers pass no argument and are dropped while a fetch is running;
   * the search drain passes `waitForInFlight` to join the running fetch and
   * continue with the next page, so a query typed mid-fetch still ends up
   * covering every session.
   */
  private async fetchMoreSessions(waitForInFlight = false): Promise<boolean> {
    while (this.sessionsPageFetchInFlight !== undefined) {
      if (!waitForInFlight) return false;
      await this.sessionsPageFetchInFlight;
    }
    const cursor = this.state.sessionsNextCursor;
    if (cursor === undefined) return false;
    const requestToken = this.sessionPickerScopeRequestToken;
    this.state.sessionsLoadingMore = true;
    this.sessionPickerComponent?.setPaging(true, true);
    this.state.ui.requestRender();
    const run = this.appendNextSessionPage(cursor, requestToken);
    this.sessionsPageFetchInFlight = run;
    try {
      return await run;
    } finally {
      if (this.sessionsPageFetchInFlight === run) this.sessionsPageFetchInFlight = undefined;
    }
  }

  private async appendNextSessionPage(cursor: string, requestToken: number): Promise<boolean> {
    try {
      const page = await this.harness.listSessionsPage({
        workDir: this.state.sessionsScope === 'all' ? undefined : this.state.appState.workDir,
        limit: SESSION_LIST_PAGE_SIZE,
        before: cursor,
      });
      if (requestToken !== this.sessionPickerScopeRequestToken) return false;
      this.state.sessionsNextCursor = page.nextCursor;
      const rows = sessionRowsForPicker(
        page.items,
        this.state.appState.sessionId,
        this.hasSessionContent(),
      );
      this.state.sessions = [...this.state.sessions, ...rows];
      this.sessionPickerComponent?.appendSessions(rows);
      this.sessionPickerComponent?.setPaging(page.nextCursor !== undefined, false);
      return true;
    } catch (error) {
      log.warn('failed to fetch more sessions for picker', { error: String(error) });
      return false;
    } finally {
      if (requestToken === this.sessionPickerScopeRequestToken) {
        this.state.sessionsLoadingMore = false;
        this.sessionPickerComponent?.setPaging(this.state.sessionsNextCursor !== undefined, false);
        this.state.ui.requestRender();
      }
    }
  }

  /**
   * Search covers every session: while a query is active the picker asks for
   * all remaining pages, drained one at a time in the background. A failed or
   * superseded fetch stops the drain (the next fresh query re-triggers it).
   */
  private async drainSessionsForSearch(): Promise<void> {
    const requestToken = this.sessionPickerScopeRequestToken;
    while (
      this.state.sessionsNextCursor !== undefined &&
      requestToken === this.sessionPickerScopeRequestToken
    ) {
      if (!(await this.fetchMoreSessions(true))) return;
    }
  }

  updateTerminalTitle(): void {
    const trimmed = this.state.appState.sessionTitle?.trim() ?? '';
    const label = trimmed.length > 0 ? trimmed.slice(0, MAX_TERMINAL_TITLE_LENGTH) : PRODUCT_NAME;
    this.state.terminal.setTitle(label);
  }

  resetSessionRuntime(options?: { readonly keepQueuedMessages?: boolean }): void {
    this.aborted = false;
    this.cacheHint.resetRuntime();
    this.surveyController.reset();
    this.streamingUI.discardPending();
    // The lazy first creation keeps input queued while it was in flight (the
    // queued messages belong to the session being created); every other
    // reset discards the old session's backlog.
    if (options?.keepQueuedMessages !== true) this.clearQueuedMessages();
    this.programStatus.resetSession();
    this.state.swarmModeEntry = undefined;
    this.streamingUI.resetToolCallState();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.resetRuntimeState();
    this.tasksBrowserController.close();
    this.btwPanelController.clear();
    this.state.footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    this.sessionEventHandler.notifications.clear();
    this.streamingUI.setTurnId(undefined);
    this.setAppState({ mcpServersSummary: null });
    this.streamingUI.setStep(0);
    this.streamingUI.resetLiveText();
    this.updateQueueDisplay();
  }

  private async showResumeOtherWorkDirHint(session: SessionRow): Promise<void> {
    this.hideSessionPicker();
    const command = `cd ${quoteShellArg(session.work_dir)} && kimi --resume ${quoteShellArg(session.id)}`;
    const message = `Current session is in a different working directory.\n  To resume, run: ${command}`;
    try {
      await copyTextToClipboard(command);
      this.showStatus(`${message}\n  Command copied to clipboard`, 'warning');
    } catch {
      this.showStatus(`${message}\n  Failed to copy command to clipboard`, 'warning');
    }
  }

  private async resumeSession(targetSessionId: string): Promise<boolean> {
    // A first-use lazy creation may still be in flight: wait it out so the
    // checks below see settled state — the pending prompt would otherwise
    // replace the resumed session when creation completes.
    await this.waitForSessionAssembly();
    if (targetSessionId === this.state.appState.sessionId) {
      this.showStatus('Already on this session.');
      return true;
    }
    if (this.state.appState.streamingPhase !== 'idle') {
      this.showError('Cannot switch sessions while streaming — press Esc or Ctrl-C first.');
      return false;
    }
    if (this.state.appState.isReplaying) {
      this.showError('Cannot switch sessions while history is replaying.');
      return false;
    }

    let session: Session;
    try {
      // A remote-bound session awaits the environment connect inside
      // resumeSession (same as /new); say so before the UI goes quiet.
      this.showStatus(`Resuming session ${targetSessionId}…`);
      session = await this.harness.resumeSession({
        id: targetSessionId,
        replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
      });
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to resume session ${targetSessionId}: ${msg}`);
      return false;
    }

    await this.switchToSession(session, `Resumed session (${session.id}).`);
    return true;
  }

  async switchToSession(session: Session, statusMessage: string): Promise<void> {
    this.resetSessionRuntime();
    await this.setSession(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(this.session);
      await this.refreshPluginCommands(this.session);
    } catch {
      /* keep the switched session usable even if dynamic skills fail */
    }
    this.clearTranscriptAndRedraw();
    try {
      await this.sessionReplay.hydrateFromReplay(session);
    } catch (error) {
      const msg = formatErrorMessage(error);
      this.showError(`Failed to replay session history: ${msg}`);
    } finally {
      this.sessionEventHandler.startSubscription();
      void this.refreshEnvironmentSlot(session);
    }
    const resumeState = session.getResumeState();
    this.surveyController.seedFromResumedAgents(resumeState?.sessionMetadata.agents ?? {});
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
    void this.cacheHint.maybeShowOnResume();
  }

  async reloadCurrentSessionView(
    session: Session,
    statusMessage: string,
    options?: { readonly replayHistory?: boolean },
  ): Promise<void> {
    this.sessionEventUnsubscribe?.();
    this.sessionEventUnsubscribe = undefined;
    this.clearReverseRpcPanels();
    session.setApprovalHandler(undefined);
    session.setQuestionHandler(undefined);
    this.approvalController.cancelAll('reloading session');
    this.questionController.cancelAll('reloading session');

    // The same session reloads in place, so its queued messages stay queued.
    this.resetSessionRuntime({ keepQueuedMessages: true });
    this.session = session;
    this.surveyController.seedUserTurnCount(
      session.getResumeState()?.agents[MAIN_AGENT_ID]?.userTurnCount,
    );
    this.harness.setTelemetryContext({ sessionId: session.id });
    this.registerSessionHandlers(session);
    await this.syncRuntimeState(session);
    this.updateTerminalTitle();
    try {
      await this.refreshSkillCommands(session);
      await this.refreshPluginCommands(session);
    } catch {
      /* keep the reloaded session usable even if dynamic skills fail */
    }
    if (options?.replayHistory === true) {
      this.clearTranscriptView();
      try {
        await this.sessionReplay.hydrateFromReplay(session);
      } catch (error) {
        this.showError(`Failed to replay session history: ${formatErrorMessage(error)}`);
      }
    }
    this.sessionEventHandler.startSubscription();
    const resumeState = session.getResumeState();
    this.surveyController.seedFromResumedAgents(resumeState?.sessionMetadata.agents ?? {});
    if (resumeState?.warning !== undefined) {
      this.showStatus(`Warning: ${resumeState.warning}`, 'warning');
    }
    this.showStatus(statusMessage);
    void this.showSessionWarnings(session);
  }

  async createNewSession(inherited?: {
    readonly environmentId: string;
    readonly environmentCwd?: string;
  }): Promise<void> {
    if (this.state.appState.isReplaying) {
      this.showError('Cannot start a new session while history is replaying.');
      return;
    }
    // Track the replacement like `ensureSession` tracks lazy creation: a
    // second `/new` shares the in-flight assembly instead of racing a second
    // createSession, and idle checks (the model-migration prompt) treat the
    // switch as busy until it has fully settled.
    if (this.newSessionPromise !== null) return this.newSessionPromise;
    this.newSessionPromise = this.assembleNewSession(inherited).finally(() => {
      this.newSessionPromise = null;
      this.modelMigration.retry();
    });
    return this.newSessionPromise;
  }

  private async assembleNewSession(inherited?: {
    readonly environmentId: string;
    readonly environmentCwd?: string;
  }): Promise<void> {
    const progress = this.showProgressSpinner('Starting a new session…');
    let ready = false;
    try {
      let session: Session;
      try {
        const environment = inherited ?? (await this.environmentForNewSession());
        session = await this.createSessionFromCurrentState(false, environment);
      } catch (error) {
        const msg = formatErrorMessage(error);
        this.showError(`Failed to start a new session: ${msg}`);
        return;
      }

      this.resetSessionRuntime();
      await this.setSession(session, 0);
      this.setAppState({ sessionId: session.id });
      try {
        await this.activateRuntime();
        await this.syncRuntimeState(session);
      } catch (error) {
        this.sessionEventHandler.startSubscription();
        const msg = formatErrorMessage(error);
        this.showError(`Post-create setup failed: ${msg}`);
        return;
      }
      try {
        await this.refreshSkillCommands(this.session);
        await this.refreshPluginCommands(this.session);
      } catch {
        /* keep the new session usable even if dynamic skills fail */
      }
      this.sessionEventHandler.startSubscription();
      this.clearTranscriptAndRedraw();
      this.showStatus(`Started a new session (${session.id}).`);
      void this.showSessionWarnings(session);
      void this.showConfigWarningsIfAny();
      ready = true;
    } finally {
      progress.stop({ ok: ready, label: ready ? 'New session ready.' : 'New session setup failed.' });
    }
  }

  /** Surface config.toml load warnings (degraded or kept-previous config) in the status bar. */
  private async showConfigWarningsIfAny(): Promise<void> {
    try {
      const { warnings } = await this.harness.getConfigDiagnostics();
      for (const warning of warnings) {
        this.showStatus(warning, 'warning');
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  // =========================================================================
  // Transcript Rendering
  // =========================================================================

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.state.ui, data.instruction);
      if (data.result === 'cancelled') {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter, data.summary);
        if (this.state.toolOutputExpanded) {
          block.setExpanded(true);
        }
      }
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        const skillNames = new Set(entry.skillNames);
        for (const [command, skillName] of this.skillCommandMap) {
          if (entry.skillNames?.includes(skillName)) skillNames.add(command.replace(/^skill:/, ''));
        }
        return new UserMessageComponent(entry.content, images, entry.bullet, [...skillNames]);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case 'plugin_command': {
        const data = entry.pluginCommandData;
        if (data === undefined) return null;
        return new PluginCommandComponent(data.pluginId, data.commandName, data.args);
      }
      case 'cron':
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case 'goal':
        if (entry.goalData?.kind === 'created') {
          return new GoalSetMessageComponent();
        }
        if (entry.goalData?.kind === 'lifecycle') {
          return buildGoalMarker(entry.goalData.change, this.state.toolOutputExpanded);
        }
        return null;
      case 'assistant': {
        if (entry.content.trimStart().startsWith('✓ Goal complete')) {
          return new GoalCompletionMessageComponent(entry.content);
        }
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, true);
        if (this.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.state.ui,
            this.state.appState.workDir,
          );
          if (this.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      markTranscriptComponent(component, entry);
      this.state.transcriptContainer.addChild(component);
    }
    const trimmed = this.trimTranscriptWindow();
    const merged = this.mergeCurrentTurnSteps();
    if (component || trimmed || merged) {
      this.state.ui.requestRender();
    }
  }

  /**
   * Relocate an already-mounted transcript entry (and its component) to the
   * end of the transcript. Used to re-anchor an asynchronously mounted
   * background-task terminal card to the start of its notification turn, so
   * the card's fold-segment boundary guards that turn's output instead of
   * splitting whatever turn happened to be live when the task terminated.
   * Returns false when the entry is no longer mounted (e.g. trimmed).
   */
  moveTranscriptEntryToEnd(entry: TranscriptEntry): boolean {
    const entries = this.state.transcriptEntries;
    const entryIndex = entries.indexOf(entry);
    if (entryIndex < 0) return false;
    entries.splice(entryIndex, 1);
    entries.push(entry);
    const children = this.state.transcriptContainer.children;
    const childIndex = children.findIndex(
      (child) => getTranscriptComponentEntry(child) === entry,
    );
    if (childIndex >= 0) {
      const [component] = children.splice(childIndex, 1);
      children.push(component!);
    }
    this.state.ui.requestRender();
    return true;
  }

  private appendApprovalTranscriptEntry(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): void {
    if (
      request.toolName === 'ExitPlanMode' ||
      request.display.kind === 'plan_review' ||
      request.display.kind === 'goal_start'
    )
      return;
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
      turnId: request.turnId === undefined ? undefined : String(request.turnId),
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  private renderWelcome(): void {
    if (
      this.state.transcriptContainer.children.some((child) => child instanceof WelcomeComponent)
    ) {
      return;
    }
    const welcome = new WelcomeComponent(this.state.appState);
    // Startup progress rows (e.g. the "Ready." spinner) are added before
    // initMainTui() reaches this point; the welcome stays on top of them.
    this.state.transcriptContainer.children.unshift(welcome);
    this.state.transcriptContainer.invalidate();
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.state.terminal.write(deleteAllKittyImages());
  }

  private disposeTranscriptChildren(): void {
    // Dispose disposable children (e.g. ShellRunComponent's 1s timer,
    // ThinkingComponent's spinner) before dropping them, so a /clear, session
    // switch, or shutdown can't leak intervals that keep firing requestRender
    // on a removed component.
    for (const child of this.state.transcriptContainer.children) {
      if (hasDispose(child)) child.dispose();
    }
  }

  private clearTranscriptAndRedraw(): void {
    this.staging.deleteStaged(this.imageStore.clear());
    this.clearTranscriptView();
  }

  private clearTranscriptView(): void {
    this.streamingUI.discardPending();
    this.state.transcriptEntries = [];
    this.streamingUI.clearActiveCompaction();
    this.streamingUI.resetLiveText();
    this.streamingUI.resetToolUi();
    this.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.disposeTranscriptChildren();
    this.state.transcriptContainer.clear();
    this.btwPanelController.clear();
    this.clearTerminalInlineImages();
    this.sessionEventHandler.notifications.clear();
    this.renderWelcome();
    // No forced full render on session reset: let the differential renderer
    // converge on its own (a mass change above the viewport still makes the
    // engine repaint everything, but nothing is forced destructively here).
    this.state.ui.requestRender();
  }

  private isTurnBoundaryComponent(child: Component): boolean {
    if (
      !(child instanceof UserMessageComponent) &&
      !(child instanceof SkillActivationComponent) &&
      !(child instanceof PluginCommandComponent) &&
      !(child instanceof ReplayTurnBoundaryComponent)
    ) {
      return false;
    }
    const entry = getTranscriptComponentEntry(child);
    if (entry === undefined) return false;
    // Live user messages / slash activations have an undefined turnId; replayed
    // ones get a `replay:N` turnId. Both start a new turn. Steer messages carry
    // a defined non-replay turnId and are not boundaries.
    return entry.turnId === undefined || entry.turnId.startsWith('replay:');
  }

  /**
   * Fold-segment boundary: everything {@link isTurnBoundaryComponent} counts,
   * plus the cron card and terminal background-task cards. Cron-fired and
   * task-notification turns mount no user message, so without one of these
   * cards as a boundary their output would share the previous user turn's
   * fold segment — and the completed-turn assistant cap would fold that turn's
   * final answer into the step summary. A task-notification turn re-anchors
   * its terminal card to the turn's start (see SessionEventHandler), because
   * the card's asynchronous mount point may sit inside an unrelated turn;
   * cards that never get a notification turn (resumed sessions, missed
   * drains) still bound whatever segment they landed in.
   */
  private isFoldSegmentBoundaryComponent(child: Component): boolean {
    return (
      this.isTurnBoundaryComponent(child) ||
      child instanceof CronMessageComponent ||
      (child instanceof BackgroundAgentStatusComponent && child.phase !== 'started')
    );
  }

  private trimTranscriptWindow(): boolean {
    if (!TRANSCRIPT_WINDOW_ENABLED || TRANSCRIPT_MAX_TURNS <= 0) return false;
    // Session replay already caps history to its own turn limit; trimming during
    // replay would shrink it further and fight that limit.
    if (this.state.appState.isReplaying) return false;

    const children = this.state.transcriptContainer.children;

    // Trim whole turns by *position* in the child list rather than by entry
    // lookup — otherwise only the (registered) user message would be removed and
    // the rest of the turn would be left behind.
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }

    const turns = groupTurns(this.state.transcriptEntries);

    const toRemove = turnsToTrim(turns, TRANSCRIPT_MAX_TURNS, TRANSCRIPT_HYSTERESIS);
    if (toRemove.size === 0) return false;

    // Reclaim image bytes referenced by trimmed user messages. The transcript
    // renders historical thumbnails via imageStore.get(id), so an attachment can
    // only be dropped once its owning user message leaves the transcript.
    for (const entry of toRemove) {
      if (entry.kind === 'user' && entry.imageAttachmentIds !== undefined) {
        const stagingFileIds = this.imageStore.removeMany(entry.imageAttachmentIds);
        this.staging.deleteStaged(stagingFileIds);
      }
    }

    let boundariesToRemove = 0;
    for (const entry of toRemove) {
      if (
        (entry.kind === 'user' ||
          entry.kind === 'skill_activation' ||
          entry.kind === 'plugin_command') &&
        entry.turnId === undefined
      ) {
        boundariesToRemove++;
      }
    }
    if (boundariesToRemove === 0) {
      this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
      return true;
    }

    let boundariesSeen = 0;
    let cutoff = 0;
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        if (boundariesSeen === boundariesToRemove) {
          cutoff = i;
          break;
        }
        boundariesSeen++;
      }
    }

    const componentsToRemove: Component[] = [];
    for (let i = 0; i < cutoff; i++) {
      const child = children[i]!;
      if (child instanceof WelcomeComponent) continue;
      componentsToRemove.push(child);
    }
    for (const child of componentsToRemove) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }

    this.state.transcriptEntries = this.state.transcriptEntries.filter((e) => !toRemove.has(e));
    return true;
  }

  mergeCurrentTurnSteps(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT,
    );
  }

  /**
   * Fold the just-finished turn's assistant messages down to the completed-turn
   * cap: while a turn is live it may keep TRANSCRIPT_KEEP_RECENT_ASSISTANT
   * messages mounted, but once it ends only the conclusion-bearing tail stays.
   * Called when a turn finishes; the finished turn is still the current one at
   * that point (no newer boundary exists yet).
   */
  mergeCompletedTurnAssistants(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
    );
  }

  private foldCurrentTurnContent(keepSteps: number, keepAssistants: number): boolean {
    if (keepSteps <= 0 && keepAssistants <= 0) return false;
    const children = this.state.transcriptContainer.children;

    // Find the start of the current fold segment.
    let turnStart = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    // Locate an existing summary, the assistant messages, and the mergeable steps.
    let summaryIndex = -1;
    const stepIndices: number[] = [];
    const assistantIndices: number[] = [];
    for (let i = turnStart + 1; i < children.length; i++) {
      const child = children[i]!;
      if (child instanceof StepSummaryComponent) {
        summaryIndex = i;
        continue;
      }
      if (child instanceof AssistantMessageComponent) {
        assistantIndices.push(i);
        continue;
      }
      stepIndices.push(i);
    }

    // Fold the oldest steps / assistant messages beyond their respective caps;
    // the most recent ones stay mounted. Children are chronological, so the
    // oldest of each kind sit at the front of their index lists.
    const stepMergeCount = keepSteps > 0 ? Math.max(0, stepIndices.length - keepSteps) : 0;
    const assistantMergeCount =
      keepAssistants > 0 ? Math.max(0, assistantIndices.length - keepAssistants) : 0;
    if (stepMergeCount === 0 && assistantMergeCount === 0) return false;
    const toMergeIndices = [
      ...stepIndices.slice(0, stepMergeCount),
      ...assistantIndices.slice(0, assistantMergeCount),
    ];

    let thinkingCount = 0;
    let toolCount = 0;
    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (child instanceof ThinkingComponent) thinkingCount++;
      else if (child instanceof ToolCallComponent) toolCount++;
    }
    if (thinkingCount === 0 && toolCount === 0 && assistantMergeCount === 0) return false;

    let summary: StepSummaryComponent;
    if (summaryIndex >= 0) {
      summary = children[summaryIndex] as StepSummaryComponent;
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    } else {
      summary = new StepSummaryComponent();
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    }

    // Rebuild children: keep everything except the merged steps, with the summary
    // sitting right after the user message.
    const toMergeSet = new Set(toMergeIndices);
    const newChildren: Component[] = [];
    for (let i = 0; i <= turnStart; i++) newChildren.push(children[i]!);
    newChildren.push(summary);
    for (let i = turnStart + 1; i < children.length; i++) {
      if (i === summaryIndex) continue;
      if (toMergeSet.has(i)) continue;
      newChildren.push(children[i]!);
    }

    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (hasDispose(child)) child.dispose();
    }

    children.splice(0, children.length, ...newChildren);
    return true;
  }

  mergeAllTurnSteps(): void {
    if (TRANSCRIPT_KEEP_RECENT_STEPS <= 0 && TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED <= 0)
      return;
    const children = this.state.transcriptContainer.children;

    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    if (boundaries.length === 0) return;

    const newChildren: Component[] = [];
    const toDispose: Component[] = [];
    for (let i = 0; i < boundaries[0]!; i++) newChildren.push(children[i]!);

    for (let t = 0; t < boundaries.length; t++) {
      const turnStart = boundaries[t]!;
      const turnEnd = t + 1 < boundaries.length ? boundaries[t + 1]! : children.length;
      newChildren.push(children[turnStart]!);

      let summaryIndex = -1;
      const stepIndices: number[] = [];
      const assistantIndices: number[] = [];
      for (let i = turnStart + 1; i < turnEnd; i++) {
        const child = children[i]!;
        if (child instanceof StepSummaryComponent) summaryIndex = i;
        else if (child instanceof AssistantMessageComponent) assistantIndices.push(i);
        else stepIndices.push(i);
      }

      const stepMergeCount =
        TRANSCRIPT_KEEP_RECENT_STEPS > 0
          ? Math.max(0, stepIndices.length - TRANSCRIPT_KEEP_RECENT_STEPS)
          : 0;
      // Replayed turns are all completed turns, so the stricter completed-turn
      // assistant cap applies (matching what live turns fold to on turn end).
      const assistantMergeCount =
        TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED > 0
          ? Math.max(0, assistantIndices.length - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED)
          : 0;
      if (stepMergeCount > 0 || assistantMergeCount > 0) {
        const toMergeIndices = [
          ...stepIndices.slice(0, stepMergeCount),
          ...assistantIndices.slice(0, assistantMergeCount),
        ];
        let thinkingCount = 0;
        let toolCount = 0;
        for (const idx of toMergeIndices) {
          const child = children[idx]!;
          if (child instanceof ThinkingComponent) thinkingCount++;
          else if (child instanceof ToolCallComponent) toolCount++;
        }
        let summary: StepSummaryComponent;
        if (summaryIndex >= 0) {
          summary = children[summaryIndex] as StepSummaryComponent;
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        } else {
          summary = new StepSummaryComponent();
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        }
        newChildren.push(summary);
        for (const idx of toMergeIndices) toDispose.push(children[idx]!);
        const toMergeSet = new Set(toMergeIndices);
        for (let i = turnStart + 1; i < turnEnd; i++) {
          if (i === summaryIndex) continue;
          if (toMergeSet.has(i)) continue;
          newChildren.push(children[i]!);
        }
      } else {
        for (let i = turnStart + 1; i < turnEnd; i++) newChildren.push(children[i]!);
      }
    }

    for (const child of toDispose) {
      if (hasDispose(child)) child.dispose();
    }
    children.splice(0, children.length, ...newChildren);
  }

  showStatus(message: string, color?: ColorToken): void {
    this.state.transcriptContainer.addChild(new StatusMessageComponent(message, color));
    this.state.ui.requestRender();
  }

  showNotice(title: string, detail?: string): void {
    this.state.transcriptContainer.addChild(new NoticeMessageComponent(title, detail));
    this.state.ui.requestRender();
  }

  showError(message: string): void {
    this.showStatus(`Error: ${message}`, 'error');
  }

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle {
    return this.showProgressSpinner(label);
  }

  showProgressSpinner(label: string): LoginProgressSpinnerHandle {
    const tint = (s: string): string => currentTheme.fg('primary', s);
    const spinner = new MoonLoader(this.state.ui, 'braille', tint, label);
    this.state.transcriptContainer.addChild(new Spacer(1));
    this.state.transcriptContainer.addChild(spinner);
    this.state.ui.requestRender();
    return {
      stop: ({ ok, label: finalLabel }) => {
        spinner.stop();
        const tone = ok ? 'success' : 'error';
        const symbol = ok ? '✓' : '✗';
        spinner.setText(currentTheme.fg(tone, `${symbol} ${finalLabel}`));
        this.state.ui.requestRender();
      },
      setLabel: (nextLabel) => {
        spinner.setLabel(nextLabel);
      },
    };
  }

  beginAuthBlock(): () => void {
    return this.programStatus.beginAuthBlock();
  }

  setAuthRequired(required: boolean): void {
    this.programStatus.setAuthRequired(required);
  }

  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: 'Sign in to Kimi Code',
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: 'Press Ctrl-C to cancel',
      }),
    );
    this.state.ui.requestRender();
    const spinner = this.showLoginProgressSpinner('Waiting for authorization…');
    return {
      stop: (result) => {
        spinner.stop(result);
      },
      setLabel: (label) => {
        spinner.setLabel(label);
      },
    };
  }

  // =========================================================================
  // Panes / Presentation State
  // =========================================================================

  updateActivityPane(): void {
    const effectiveMode = this.resolveActivityPaneMode();
    const tipKind = loadingTipKind(effectiveMode);
    // Pick a fresh loading tip when the loading kind changes: waiting/tool
    // share the moon kind and thinking/composing/compacting share the braille
    // kind, so a burst of tool calls or thinking/composing alternation does
    // not flip tips. Clear the cache only when there is no loading UI at all.
    if (effectiveMode === 'idle' || effectiveMode === 'session' || effectiveMode === 'hidden') {
      this.currentLoadingTip = undefined;
    } else if (
      tipKind !== undefined &&
      (this.currentLoadingTip === undefined || this.currentLoadingTip.kind !== tipKind)
    ) {
      const previousTip = this.currentLoadingTip?.tip;
      this.currentLoadingTip = {
        kind: tipKind,
        tip: pickRandomWorkingTip(previousTip)?.text,
      };
    }
    this.syncTerminalProgress(this.shouldShowTerminalProgress(effectiveMode));
    const placeSpinnerInAgentSwarm = this.shouldPlaceActivitySpinnerInAgentSwarm(effectiveMode);
    // Carry the retry state in the mode key so an incoming/cleared
    // `turn.step.retrying` rebuilds the waiting pane with fresh label and
    // detail instead of hitting the cached-pane early return below.
    const retry = effectiveMode === 'waiting' ? this.state.appState.stepRetry : null;
    const retryKey =
      retry === null ? '' : `${formatStepRetryLabel(retry)}|${formatStepRetryDetail(retry)}`;
    const activityModeKey = `${effectiveMode}:${placeSpinnerInAgentSwarm ? 'swarm' : 'pane'}:${retryKey}`;

    if (
      activityModeKey === this.lastActivityMode &&
      (effectiveMode === 'waiting' ||
        effectiveMode === 'thinking' ||
        effectiveMode === 'tool' ||
        effectiveMode === 'compacting')
    ) {
      if (placeSpinnerInAgentSwarm) {
        this.syncAgentSwarmActivitySpinner(this.state.activitySpinner?.instance);
      }
      return;
    }

    this.lastActivityMode = activityModeKey;
    this.state.activityContainer.clear();

    switch (effectiveMode) {
      case 'hidden':
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.ui.requestRender();
        return;
      case 'compacting': {
        const spinner = this.ensureActivitySpinner('braille', 'Compacting…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'compacting',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'waiting': {
        const stepRetry = this.state.appState.stepRetry;
        const spinner = this.ensureActivitySpinner('moon', waitingSpinnerLabel(stepRetry));
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'waiting',
            spinner,
            tip: stepRetry === null ? this.currentLoadingTip?.tip : undefined,
            detail: stepRetry === null ? undefined : formatStepRetryDetail(stepRetry),
          }),
        );
        break;
      }
      case 'thinking': {
        const spinner = this.ensureActivitySpinner('braille', 'Working…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'thinking',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'composing': {
        const spinner = this.ensureActivitySpinner('braille', 'Working…', (s) =>
          currentTheme.fg('primary', s),
        );
        this.syncAgentSwarmActivitySpinner(undefined);
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'composing',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'tool': {
        const spinner = this.ensureActivitySpinner('moon');
        this.syncAgentSwarmActivitySpinner(placeSpinnerInAgentSwarm ? spinner : undefined);
        if (placeSpinnerInAgentSwarm) break;
        this.state.activityContainer.addChild(
          new ActivityPaneComponent({
            mode: 'tool',
            spinner,
            tip: this.currentLoadingTip?.tip,
          }),
        );
        break;
      }
      case 'idle':
      case 'session': {
        this.stopActivitySpinner();
        this.syncAgentSwarmActivitySpinner(undefined);
        // Working modes occupy two rows (a spacer above the loader); idle
        // keeps a one-row placeholder so the dock only shifts once at turn
        // boundaries instead of on every intra-turn mode flip.
        this.state.activityContainer.addChild(new Spacer(1));
        break;
      }
    }
    this.state.ui.requestRender();
  }

  private resolveActivityPaneMode(): EffectiveActivityPaneMode {
    if (this.state.activeDialog === 'session-picker') return 'hidden';
    if (this.state.livePane.pendingApproval !== null) return 'hidden';
    if (this.state.livePane.pendingQuestion !== null) return 'hidden';
    if (this.state.appState.isCompacting) return 'compacting';

    const streamingPhase = this.state.appState.streamingPhase;

    // A running `!` shell command shows the moon spinner (same as `waiting`)
    // until it finishes, signalling that input is busy / queued.
    if (streamingPhase === 'shell') return 'waiting';

    if (this.state.livePane.mode === 'idle') {
      if (streamingPhase === 'thinking' || streamingPhase === 'composing') {
        return streamingPhase;
      }
    }

    return this.state.livePane.mode;
  }

  updateQueueDisplay(): void {
    this.programStatus?.refresh();
    const { queueContainer, queuePane, queuedMessages } = this.state;
    if (queuedMessages.length === 0) {
      queuePane.scrollBodyToTop();
      queueContainer.clear();
      return;
    }
    // The pane is long-lived so a docked list keeps its scroll position.
    queuePane.setOptions({
      messages: queuedMessages,
      isCompacting: this.state.appState.isCompacting,
      isStreaming: this.state.appState.streamingPhase !== 'idle',
      canSteerImmediately: !this.deferUserMessages && !this.isSteeringQueuedMessages(),
    });
    if (queueContainer.children.length === 0) queueContainer.addChild(queuePane);
  }

  /**
   * Index of the first transcript child ctrl+o may expand: a component is
   * expandable only if it sits at or after the start of the
   * (totalTurns - expandTurns)-th turn, i.e. it belongs to one of the most
   * recent `expandTurns` turns. Position-based so it also covers streaming
   * components that have no entry in the metadata map.
   */
  private expandCutoff(children: readonly Component[]): number {
    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    return expandCutoffIndex(children.length, boundaries, TRANSCRIPT_EXPAND_TURNS);
  }

  /**
   * What the footer's ctrl+o hint should offer: `expand` while a card in the
   * expandable window keeps content out of its collapsed form, `collapse`
   * once the toggle shows it, `null` when ctrl+o would change nothing.
   */
  private toolOutputExpandHint(): 'expand' | 'collapse' | null {
    const children = this.state.transcriptContainer.children;
    if (this.state.toolOutputExpanded) {
      // Toggling off collapses every expanded card, including one that slid
      // out of the expansion window since it was expanded, so any expanded
      // card with hidden content keeps the collapse hint on.
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (isExpandedComponent(child) && countedByExpandHint(child)) return 'collapse';
      }
      return null;
    }
    const cutoff = this.expandCutoff(children);
    for (let i = children.length - 1; i >= cutoff; i--) {
      if (countedByExpandHint(children[i])) return 'expand';
    }
    return null;
  }

  private toggleClickedFoldBlock(index: number): TuiMouseEventResult | undefined {
    const children = this.state.transcriptContainer.children;
    const hit = children[index];
    if (hit === undefined || !isExpandable(hit) || !hasHiddenContent(hit)) return undefined;
    if (isExpandedComponent(hit)) {
      hit.setExpanded(false);
    } else if (index >= this.expandCutoff(children)) {
      hit.setExpanded(true);
    } else {
      return undefined;
    }
    this.state.ui.requestRender();
    return { handled: true };
  }

  toggleToolOutputExpansion(): void {
    this.state.toolOutputExpanded = !this.state.toolOutputExpanded;
    const children = this.state.transcriptContainer.children;
    const expandCutoff = this.expandCutoff(children);

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!isExpandable(child)) continue;
      child.setExpanded(this.state.toolOutputExpanded && i >= expandCutoff);
    }
    // Differential render only — no destructive full redraw on expand/collapse.
    // (When the expanded region reaches above the viewport, the engine's own
    // fallback may still do a full render; that path is not forced from here.)
    this.state.ui.requestRender();
  }

  openTasksBrowser(): void {
    void this.tasksBrowserController.show();
  }

  focusNotifyPanel(): boolean {
    return this.sessionEventHandler.notifications.focusPanel();
  }

  private async detachRunningShellCommand(): Promise<void> {
    // Only one `!` command runs at a time (input is queued while busy).
    const next = this.shellOutputStreams.entries().next();
    if (next.done) {
      this.showDetachHint('No shell command running.');
      return;
    }
    const [commandId, stream] = next.value;
    if (stream.taskId === undefined) {
      this.showDetachHint('Command is still starting — try again.');
      return;
    }
    const session = this.session;
    if (session === undefined) return;
    try {
      const info = await session.detachBackgroundTask(stream.taskId);
      if (info === undefined) {
        this.showDetachHint('Command already finished.');
        return;
      }
    } catch (error) {
      this.showError(`Failed to move to background: ${formatErrorMessage(error)}`);
      return;
    }
    // Finalize the card as backgrounded and drop the stream so the eventual
    // runShellCommand resolution (which carries background metadata) is a no-op
    // instead of overwriting this view.
    stream.component.finishBackgrounded();
    stream.entry.content = 'Moved to background.';
    this.shellOutputStreams.delete(commandId);
    // The backgrounded command's notification turn (started by the engine via
    // appendSystemReminderAndNotify) owns the streaming phase and drains the
    // queue when it completes, so we intentionally leave both untouched here.
    this.showDetachHint('Moved to background. /tasks to view.');
  }

  async detachCurrentForegroundTask(): Promise<void> {
    // A running `!` shell command takes priority over agent foreground tasks.
    if (this.shellOutputStreams.size > 0) {
      await this.detachRunningShellCommand();
      return;
    }

    const session = this.session;
    if (session === undefined) {
      this.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    let tasks: readonly BackgroundTaskInfo[];
    try {
      // activeOnly defaults to true; foreground running tasks are non-terminal
      // and therefore included. We filter to `detached === false` ourselves.
      tasks = await session.listBackgroundTasks();
    } catch (error) {
      this.showError(`Failed to list tasks: ${formatErrorMessage(error)}`);
      return;
    }

    const targets = pickForegroundTasks(tasks);
    if (targets.length === 0) {
      this.showDetachHint('No foreground task running.');
      return;
    }

    let detached = 0;
    let alreadyFinished = 0;
    for (const target of targets) {
      try {
        const info = await session.detachBackgroundTask(target.taskId);
        if (info === undefined) alreadyFinished++;
        else detached++;
      } catch (error) {
        this.showError(`Failed to detach ${target.taskId}: ${formatErrorMessage(error)}`);
      }
    }

    let hint: string;
    if (detached === 0 && alreadyFinished > 0) {
      hint = alreadyFinished === 1 ? 'Task already finished.' : 'Tasks already finished.';
    } else if (detached === targets.length) {
      hint =
        detached === 1 ? 'Moved 1 task to background.' : `Moved ${detached} tasks to background.`;
    } else {
      hint = `Moved ${detached} of ${targets.length} tasks to background.`;
    }
    if (detached > 0) hint = `${hint} /tasks to view.`;
    this.showDetachHint(hint);
  }

  /** Show a one-shot footer hint that auto-clears after DETACH_HINT_DISPLAY_MS. */
  private showDetachHint(hint: string): void {
    if (this.detachHintClearTimer !== undefined) {
      clearTimeout(this.detachHintClearTimer);
      this.detachHintClearTimer = undefined;
    }
    this.state.footer.setTransientHint(hint);
    this.detachHintClearTimer = setTimeout(() => {
      this.detachHintClearTimer = undefined;
      // Don't clobber a newer transient hint (e.g. the exit-confirmation
      // prompt) that took over while this timer was pending.
      if (this.state.footer.getTransientHint() !== hint) return;
      this.state.footer.setTransientHint(null);
      this.state.ui.requestRender();
    }, DETACH_HINT_DISPLAY_MS);
    this.state.ui.requestRender();
  }

  updateEditorBorderHighlight(text?: string): void {
    const trimmed = (text ?? this.state.editor.getText()).trimStart();
    const isBash = this.state.appState.inputMode === 'bash';
    const highlighted = this.state.appState.planMode || isBash || trimmed.startsWith('/');
    this.state.editor.borderHighlighted = highlighted;
    // Shell mode gets its own hue; plan-mode and slash context stay primary.
    const borderToken = isBash ? 'shellMode' : highlighted ? 'primary' : 'border';
    this.state.editor.borderColor = (s: string) => currentTheme.fg(borderToken, s);
    this.state.ui.requestRender();
  }

  /**
   * Live pre-send warning in the footer while the typed `/goal` objective
   * exceeds the length limit, so the user can trim it (or move it into a
   * file) before submitting instead of losing the input to a rejection.
   * `undefined` input means the text cannot be a `/goal` command and is not
   * measured at all. The footer keeps this warning in its own slot, so
   * transient hints (exit confirm, detach, image paste) only displace it
   * temporarily.
   */
  updateGoalLengthWarning(text: string | undefined): void {
    const warning = text === undefined ? undefined : goalObjectiveLengthWarning(text);
    this.state.footer.setWarningHint(warning ?? null);
    this.state.ui.requestRender();
  }

  async applyTheme(themeName: ThemeName, resolved?: ResolvedTheme): Promise<void> {
    const palette = await getColorPalette(themeName === 'auto' ? (resolved ?? 'dark') : themeName);
    currentTheme.setPalette(palette);
    this.setAppState({ theme: themeName });
    this.updateEditorBorderHighlight();
    // Force every historical message to re-render so Markdown/Text caches
    // (which hold old ANSI colour codes) are cleared.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  refreshTerminalThemeTracking(): void {
    this.stopTerminalThemeTracking();
    this.terminalThemeTrackingDispose = installTerminalThemeTracking(
      this.state,
      (resolved) => {
        void this.applyResolvedAutoTheme(resolved);
      },
      (background) => {
        currentTheme.setTerminalBackground(background);
        this.state.ui.requestRender();
      },
    );
  }

  private stopTerminalThemeTracking(): void {
    this.terminalThemeTrackingDispose?.();
    this.terminalThemeTrackingDispose = undefined;
  }

  private async applyResolvedAutoTheme(resolved: ResolvedTheme): Promise<void> {
    if (this.state.appState.theme !== 'auto') return;
    const palette = getBuiltInPalette(resolved);
    if (currentTheme.palette === palette) return;
    currentTheme.setPalette(palette);
    this.updateEditorBorderHighlight();
    // Repaint already-rendered transcript entries (status/markdown caches hold
    // old ANSI codes), matching applyTheme()'s behaviour.
    this.state.transcriptContainer.invalidate();
    this.state.ui.requestRender(true);
  }

  private shouldShowTerminalProgress(effectiveMode: EffectiveActivityPaneMode): boolean {
    if (this.state.appState.isCompacting) return true;
    return (
      effectiveMode === 'waiting' ||
      effectiveMode === 'thinking' ||
      effectiveMode === 'composing' ||
      effectiveMode === 'tool'
    );
  }

  private shouldPlaceActivitySpinnerInAgentSwarm(
    effectiveMode: EffectiveActivityPaneMode,
  ): boolean {
    return (
      this.sessionEventHandler.hasActiveAgentSwarmToolCall() &&
      (effectiveMode === 'waiting' || effectiveMode === 'tool')
    );
  }

  private syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.sessionEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  private syncTerminalProgress(active: boolean): void {
    if (!this.state.terminalState.supportsProgress) return;
    if (this.state.terminalState.progressActive === active) return;
    this.state.terminal.setProgress(active);
    this.state.terminalState.progressActive = active;
  }

  private ensureActivitySpinner(
    style: SpinnerStyle,
    label = '',
    colorFn?: (s: string) => string,
  ): MoonLoader {
    if (this.state.activitySpinner?.style !== style) {
      this.stopActivitySpinner();
    }

    if (this.state.activitySpinner === null) {
      const instance = new MoonLoader(this.state.ui, style, colorFn, label);
      this.state.activitySpinner = { instance, style };
      return instance;
    }

    this.state.activitySpinner.instance.setLabel(label);
    if (colorFn !== undefined) {
      this.state.activitySpinner.instance.setColorFn(colorFn);
    }
    return this.state.activitySpinner.instance;
  }

  private stopActivitySpinner(): void {
    if (this.state.activitySpinner !== null) {
      this.state.activitySpinner.instance.stop();
      this.state.activitySpinner = null;
    }
  }

  // =========================================================================
  // Dialogs / Selectors
  // =========================================================================

  // Tracked so a dropped panel's `dispose()` runs on replacement / editor
  // return — a busy dialog's spinner timer must not tick after removal.
  private editorReplacementPanel: (Component & Focusable) | undefined;

  // While the Updates panel holds the keyboard, whatever takes the editor slot
  // waits faded until the user comes back (Esc / Ctrl+N / a click), so an
  // approval arriving mid-read cannot catch keys meant for Updates.
  mountEditorReplacement(
    panel: Component & Focusable,
    onDisplaced?: () => void,
    onReplaced?: () => void,
    owner?: ReverseRpcModalOwner,
  ): void {
    const previousOnDisplaced = this.editorReplacementOnDisplaced;
    const previousOnReplaced = this.editorReplacementOnReplaced;
    const previousOwner = this.editorReplacementOwner;
    this.editorReplacementOnDisplaced = onDisplaced;
    this.editorReplacementOnReplaced = onReplaced;
    this.editorReplacementOwner = owner;
    this.surveyController.notifyDisplaced();
    if (this.state.activeDialog === 'model-switch-confirm') this.state.activeDialog = null;
    this.disposeEditorReplacement();
    this.state.editorReplacementMounted = true;
    this.editorReplacementPanel = panel;
    setEditorSlot(this.state, panel);
    if (!this.state.notifyPanel.focused) this.state.ui.setFocus(panel);
    this.state.ui.requestRender();
    previousOnDisplaced?.();
    const continuingSameOwner = owner !== undefined && previousOwner === owner;
    if (!continuingSameOwner) previousOnReplaced?.();
  }

  restoreEditor(): void {
    this.disposeEditorReplacement();
    const onDisplaced = this.editorReplacementOnDisplaced;
    this.editorReplacementOnDisplaced = undefined;
    this.editorReplacementOnReplaced = undefined;
    this.editorReplacementOwner = undefined;
    this.state.editorReplacementMounted = false;
    setEditorSlot(this.state, this.state.editor);
    if (!this.state.notifyPanel.focused) this.state.ui.setFocus(this.state.editor);
    onDisplaced?.();
    this.modelMigration.retry();
    // Differential render only: closing a tall panel leaves the editor a few
    // rows above the bottom (blank tail) until the next append, but avoids a
    // destructive full redraw on every dialog close.
    this.state.ui.requestRender();
  }

  private disposeEditorReplacement(): void {
    const panel = this.editorReplacementPanel;
    this.editorReplacementPanel = undefined;
    if (panel !== undefined && hasDispose(panel)) panel.dispose();
  }

  restoreInputText(text: string): void {
    this.restoreEditor();
    this.state.editor.setText(text);
    this.updateEditorBorderHighlight(text);
    this.state.ui.requestRender();
  }

  /** Latest in-process LLM round-trip; feeds the idle cache-hint scenario. */
  recordSessionActivity(): void {
    this.cacheHint.recordActivity();
  }

  /** Per-step usage for the client-side cache-break detector. */
  noteStepUsage(usage: TokenUsage | undefined): void {
    this.cacheHint.noteStepUsage(usage);
  }

  /** Compaction shrinks the cached prefix — reset the cache-break baseline. */
  noteCompactionFinished(): void {
    this.cacheHint.resetCacheBreakBaseline();
    this.programStatus.finishCompaction();
  }

  /** /undo cut the context — the next step's cache drop is expected. */
  noteContextCut(): void {
    this.cacheHint.resetCacheBreakBaseline();
  }

  private async runMigrationScreen(plan: MigrationPlan): Promise<MigrationScreenResult> {
    const result = await new Promise<MigrationScreenResult>((resolve) => {
      const screen = new MigrationScreenComponent({
        plan,
        sourceHome: plan.sourceHome,
        targetHome: this.harness.homeDir,
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
        writeFileSync(join(this.harness.homeDir, '.skip-migration-from-kimi-cli'), '', 'utf-8');
      } catch {
        // Non-blocking: a failed marker write must never crash startup.
      }
    }
    return result;
  }

  /**
   * agent-core-v2 startup gate: before any session is created, ask whether to
   * trust this folder when the workspace is not trusted yet (project-level MCP
   * servers stay disabled while untrusted). A failed trust-info read is treated
   * as untrusted and still prompts. Choosing "don't trust" (or Esc) exits the
   * program before any session is created. A failed trust write still enters
   * the TUI for this process and re-asks on the next launch. Returns true when
   * the prompt started the event loop (the caller must not start it again).
   */
  private async maybeRunWorkspaceTrustPrompt(): Promise<boolean> {
    const workDir = this.state.appState.workDir;
    let info: WorkspaceTrustInfo;
    try {
      info = await this.harness.getWorkspaceTrustInfo(workDir, {
        additionalDirs: this.state.appState.additionalDirs,
        environmentId: this.options.startup.environment,
        environmentCwd: this.options.startup.environmentCwd,
      });
    } catch {
      info = {
        trusted: false,
        gatedMcpServers: [],
        gatedAdditionalDirs: [],
        additionalDirSources: [],
        warnings: ['Could not inspect project settings.'],
        instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] },
      };
    }
    if (info.trusted) {
      return false;
    }
    this.startEventLoop();
    const interaction = this.programStatus.startInteraction({
      kind: 'permission',
      message: 'Workspace trust required',
    });
    let choice: TrustPromptChoice;
    try {
      choice = await new Promise<TrustPromptChoice>((resolve) => {
        this.state.activeDialog = 'trust-prompt';
        this.mountEditorReplacement(
          new TrustPromptComponent({
            workDir,
            info,
            getAvailableRows: () =>
              this.state.terminal.rows - (this.state.ui instanceof TuiAltScreen ? 1 : 0),
            onSelect: (c) => {
              resolve(c);
            },
          }),
        );
      });
    } finally {
      this.programStatus.endInteraction(interaction);
    }
    this.state.activeDialog = null;
    if (choice !== 'trust') {
      // Declining trust exits the program (Claude Code's "No, exit" semantics):
      // stop() runs the standard shutdown path and ends in process.exit. The
      // editor is NOT restored first — its frame would linger as an orphaned
      // input box above the exit message; the prompt stays as the last frame.
      await this.stop();
      return true;
    }
    this.restoreEditor();
    try {
      await this.harness.trustWorkspace(workDir);
    } catch {
    }
    return true;
  }

  showHelpPanel(): void {
    this.state.activeDialog = 'help';
    this.mountEditorReplacement(
      new HelpPanelComponent({
        commands: this.getSlashCommands(),
        onClose: () => {
          this.hideHelpPanel();
        },
      }),
    );
  }

  private hideHelpPanel(): void {
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private sessionPickerOptions: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  } = {
    applyStartupModes: false,
    closeOnCancel: false,
    forwardEditorExit: false,
  };
  private sessionPickerScopeRequestToken = 0;
  private sessionPickerComponent: SessionPickerComponent | undefined;
  private sessionsPageFetchInFlight: Promise<boolean> | undefined;

  async showSessionPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: false,
      closeOnCancel: false,
      forwardEditorExit: false,
    });
  }

  private async bootstrapFromPicker(): Promise<void> {
    await this.openSessionPicker({
      applyStartupModes: true,
      closeOnCancel: true,
      forwardEditorExit: true,
    });
  }

  private async openSessionPicker(options: {
    readonly applyStartupModes: boolean;
    readonly closeOnCancel: boolean;
    readonly forwardEditorExit: boolean;
  }): Promise<void> {
    this.sessionPickerOptions = options;
    await this.fetchSessions('cwd');
    this.remountSessionPicker();
  }

  private async toggleSessionPickerScope(selectedSessionId: string): Promise<void> {
    const requestToken = ++this.sessionPickerScopeRequestToken;
    const nextScope = this.state.sessionsScope === 'cwd' ? 'all' : 'cwd';
    await this.fetchSessions(nextScope);
    if (requestToken !== this.sessionPickerScopeRequestToken) return;
    if (this.state.activeDialog !== 'session-picker') return;
    this.remountSessionPicker(selectedSessionId);
  }

  private remountSessionPicker(initialSelectedSessionId?: string): void {
    this.mountSessionPicker({
      initialSelectedSessionId,
      applyStartupModes: this.sessionPickerOptions.applyStartupModes,
      onCancel: () => {
        this.hideSessionPicker();
        if (this.sessionPickerOptions.closeOnCancel) void this.stop();
      },
      onCtrlC: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlC?.();
          }
        : undefined,
      onCtrlD: this.sessionPickerOptions.forwardEditorExit
        ? () => {
            this.state.editor.onCtrlD?.();
          }
        : undefined,
    });
  }

  hideSessionPicker(): void {
    this.sessionPickerScopeRequestToken += 1;
    this.sessionPickerComponent = undefined;
    this.editorKeyboard.clearPendingExit();
    this.state.activeDialog = null;
    this.restoreEditor();
  }

  private async deleteSessionFromPicker(session: SessionRow): Promise<void> {
    // Invalidate any pending scope-toggle remount: it would replace the picker
    // that is about to lock itself for the delete.
    this.sessionPickerScopeRequestToken += 1;
    try {
      await this.waitForSessionAssembly();
      if (session.id === this.state.appState.sessionId && this.session !== undefined) {
        await this.deleteCurrentSessionFromPicker(session);
        return;
      }
      await this.harness.deleteSession(session.id);
      // fetchSessions swallows refetch errors, so drop the row locally first —
      // a failed refetch must not resurrect it in the remounted list.
      this.state.sessions = this.state.sessions.filter((row) => row.id !== session.id);
      const requestToken = ++this.sessionPickerScopeRequestToken;
      await this.fetchSessions(this.state.sessionsScope);
      if (requestToken !== this.sessionPickerScopeRequestToken) return;
      if (this.state.activeDialog !== 'session-picker') return;
      this.remountSessionPicker();
      this.showStatus('Session deleted.');
    } catch (error) {
      this.showError(`Failed to delete session ${session.id}: ${formatErrorMessage(error)}`);
    }
  }

  private async deleteCurrentSessionFromPicker(session: SessionRow): Promise<void> {
    // Read the binding before closeSession drops it. The replacement session
    // is created after the old one is gone, so it cannot rediscover the binding.
    let inherited: { readonly environmentId: string; readonly environmentCwd?: string } | undefined;
    let inheritError: unknown;
    try {
      inherited = await this.environmentForNewSession();
    } catch (error) {
      inheritError = error;
    }
    const startReplacement = async (): Promise<void> => {
      this.setAppState({ sessionId: '' });
      this.clearTranscriptAndRedraw();
      if (inheritError !== undefined) {
        this.showError(`Failed to start a new session: ${formatErrorMessage(inheritError)}`);
        return;
      }
      await this.createNewSession(inherited);
    };
    // The picker stays mounted (locking input) until the replacement session
    // is ready — restoring the editor mid-flight would let a prompt race the swap.
    try {
      // Tear down before deleting so no events from the dying session reach the UI.
      await this.closeSession('deleting session');
      await this.harness.deleteSession(session.id);
    } catch (error) {
      // The engine aborts a failed delete and keeps the session: reattach,
      // falling back to a fresh session if it is gone. showError runs after
      // the switch because switchToSession clears the transcript.
      const message = `Failed to delete session ${session.id}: ${formatErrorMessage(error)}`;
      try {
        const resumed = await this.harness.resumeSession({
          id: session.id,
          replayTurnLimit: REPLAY_FETCH_TURN_LIMIT,
        });
        await this.switchToSession(resumed, `Resumed session (${resumed.id}).`);
      } catch {
        await startReplacement();
      }
      this.showError(message);
      this.hideSessionPicker();
      return;
    }
    await startReplacement();
    this.hideSessionPicker();
  }

  openUndoSelector(): void {
    void slashCommands.handleUndoCommand(this, '');
  }

  private mountSessionPicker(options: {
    readonly onCancel: () => void;
    readonly onCtrlC?: () => void;
    readonly onCtrlD?: () => void;
    readonly initialSelectedSessionId?: string;
    // CLI mode flags (--auto/--yolo/--plan) target the session picked at
    // startup (bare --session); later /sessions switches keep the picked
    // session's own persisted modes.
    readonly applyStartupModes?: boolean;
  }): void {
    this.state.activeDialog = 'session-picker';
    const picker = new SessionPickerComponent({
      sessions: this.state.sessions,
      loading: this.state.loadingSessions,
      currentSessionId: this.state.appState.sessionId,
      scope: this.state.sessionsScope,
      initialSelectedSessionId: options.initialSelectedSessionId,
      pageSize: SESSION_LIST_PAGE_SIZE,
      hasMore: this.state.sessionsNextCursor !== undefined,
      loadingMore: this.state.sessionsLoadingMore,
      onLoadMore: () => {
        void this.fetchMoreSessions();
      },
      onSearchDrain: () => {
        void this.drainSessionsForSearch();
      },
      onSelect: (session: SessionRow) =>
        this.handleSessionPickerSelect(session, options.applyStartupModes === true).catch(
          (error) => {
            this.showError(`Failed to apply startup flags: ${formatErrorMessage(error)}`);
          },
        ),
      onCancel: options.onCancel,
      onCtrlC: options.onCtrlC,
      onCtrlD: options.onCtrlD,
      onToggleScope: (selectedSessionId: string) => {
        void this.toggleSessionPickerScope(selectedSessionId);
      },
      requestRender: () => {
        this.state.ui.requestRender();
      },
      onDeleteRequest: (session: SessionRow) => this.deleteSessionFromPicker(session),
    });
    this.sessionPickerComponent = picker;
    this.mountEditorReplacement(picker);
  }

  private async handleSessionPickerSelect(
    session: SessionRow,
    applyStartupModes: boolean,
  ): Promise<void> {
    // Invalidate any pending scope-toggle remount: it would replace the picker
    // and drop the selection lock.
    this.sessionPickerScopeRequestToken += 1;
    if (resolve(session.work_dir) !== resolve(this.state.appState.workDir)) {
      await this.showResumeOtherWorkDirHint(session);
      if (applyStartupModes) await this.stop(0);
      return;
    }

    const switched = await this.resumeSession(session.id);
    if (!switched) return;
    if (applyStartupModes) {
      await this.applyStartupModesToResumedSession(this.requireSession());
      this.applyStartupPermissionAndPlanToAppState();
    }
    this.hideSessionPicker();
  }

  private showApprovalPanel(payload: ApprovalPanelData): void {
    this.patchLivePane({ pendingApproval: { data: payload } });
    this.sessionEventHandler.notifications.setPrompt(true);
    notifyTerminalOnce(this.state, `approval:${payload.id}`, {
      title: 'Kimi Code approval required',
      body: payload.tool_name,
    });
    const panel = new ApprovalPanelComponent(
      { data: payload },
      (response: ApprovalPanelResponse) => {
        this.approvalController.respond(adaptPanelResponse(response));
      },
      () => {
        this.toggleToolOutputExpansion();
      },
      (block) => {
        this.openApprovalPreview(panel, block);
      },
      {
        layout:
          this.state.dockContainer === undefined ? undefined : { maxBodyRows: DOCK_APPROVAL_ROWS },
        isTerminalFocused: () => this.state.terminalState.focused,
        onFocusUpdates: () => this.focusNotifyPanel(),
      },
    );
    this.activeApprovalPanel = panel;
    this.mountEditorReplacement(panel, undefined, () => {
      this.activeApprovalPanel = undefined;
      this.patchLivePane({ pendingApproval: null });
      this.approvalController.cancelAll('Approval panel displaced', false);
    }, 'approval');
  }

  private resolveApprovalEnvironment(): string | undefined {
    const environment = this.state.appState.environment;
    if (environment === undefined || environment.environmentId === 'local') return undefined;
    return `${environment.type}:${environment.environmentId}`;
  }

  private hideApprovalPanel(): void {
    // If the full-screen preview is open, fold it back first so the saved-
    // children stack stays consistent with what mountEditorReplacement set up.
    if (this.approvalPreview !== undefined) this.closeApprovalPreview();
    this.activeApprovalPanel = undefined;
    this.patchLivePane({ pendingApproval: null });
    this.sessionEventHandler.notifications.setPrompt(false);
    this.restoreEditor();
  }

  // Mounts the full-screen approval preview viewer on top of the current
  // approval panel. Uses the same nested-takeover pattern as
  // openTaskOutputViewer: beginScreenTakeover swaps the viewer in (root
  // children in regular mode, layout root in fullscreen) and closing restores
  // it. The approval panel instance is
  // kept around in `activeApprovalPanel` so its selection state survives.
  private openApprovalPreview(panel: ApprovalPanelComponent, block: ApprovalPreviewBlock): void {
    if (this.approvalPreview !== undefined) return;
    const viewer = new ApprovalPreviewViewer(
      {
        block,
        onClose: () => {
          this.closeApprovalPreview();
        },
      },
      this.state.terminal,
    );
    const takeover = beginScreenTakeover(this.state.ui, viewer);
    this.state.ui.setFocus(viewer);
    this.state.ui.requestRender(true);
    this.approvalPreview = { component: viewer, takeover, panel };
  }

  private closeApprovalPreview(): void {
    const preview = this.approvalPreview;
    if (preview === undefined) return;
    this.approvalPreview = undefined;
    endScreenTakeover(this.state.ui, preview.takeover);
    this.state.ui.setFocus(preview.panel);
    this.state.ui.requestRender(true);
  }

  private showQuestionDialog(payload: QuestionPanelData): void {
    this.patchLivePane({ pendingQuestion: { data: payload } });
    this.sessionEventHandler.notifications.setPrompt(true);
    notifyTerminalOnce(this.state, `question:${payload.id}`, {
      title: 'Kimi Code needs your answer',
      body: payload.questions[0]?.question,
    });
    const dialog = new QuestionDialogComponent(
      { data: payload },
      (response) => {
        this.questionController.respond(response);
      },
      6,
      () => {
        this.toggleToolOutputExpansion();
      },
      {
        isTerminalFocused: () => this.state.terminalState.focused,
        onFocusUpdates: () => this.focusNotifyPanel(),
      },
    );
    this.mountEditorReplacement(dialog, undefined, () => {
      this.patchLivePane({ pendingQuestion: null });
      this.questionController.cancelAll('Question panel displaced', false);
    }, 'question');
  }

  private hideQuestionDialog(): void {
    this.patchLivePane({ pendingQuestion: null });
    this.sessionEventHandler.notifications.setPrompt(false);
    this.restoreEditor();
  }
}

function isSteerableQueuedMessage(message: QueuedMessage): boolean {
  return (
    message.inlineSkillActivations === undefined &&
    message.mode !== 'bash' &&
    message.mode !== 'compact'
  );
}

function toSteerInputItem(message: QueuedMessage): SteerInputItem {
  return {
    text: message.text,
    parts: message.parts,
    imageAttachmentIds: message.imageAttachmentIds,
    videoAttachmentIds: message.videoAttachmentIds,
    mediaSnapshots: message.mediaSnapshots,
    inlineSkillActivations: message.inlineSkillActivations,
  };
}
