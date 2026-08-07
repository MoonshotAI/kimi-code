import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import type { ColorToken, ThemeName } from '#/tui/theme';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { AuthFlowController } from '../controllers/auth-flow';
import type { BtwPanelController } from '../controllers/btw-panel';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';
import { tryHandleDanceCommand } from '../easter-eggs/dance';
import type { ResolvedTheme } from '../theme/colors';
import type { TUIState } from '../tui-state';
import type {
  AppState,
  LoginProgressSpinnerHandle,
  QueuedMessage,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import { handleLoginCommand, handleLogoutCommand } from './auth';
import { handleBtwCommand } from './btw';
import { handleCopyCommand } from './copy';
import {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleModelCommand,
  handlePlanCommand,
  handleSecondaryModelCommand,
  handleThemeCommand,
  handleYoloCommand,
  showExperimentsPanel,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
import { handleGoalCommand } from './goal';
import { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
import { handleAddDirCommand } from './add-dir';
import { parseSlashInput } from './parse';
import { handlePluginsCommand } from './plugins';
import { handleProviderCommand } from './provider';
import {
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
  type BuiltinSlashCommandName,
} from './registry';
import { handleReloadCommand, handleReloadTuiCommand } from './reload';
import type { SkillListSession } from './skills';
import {
  resolveSlashCommandInput,
  slashBusyMessage,
  slashCommandBusyReason,
} from './resolve';
import {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
import { handleSwarmCommand } from './swarm';
import { handleUndoCommand } from './undo';
import { handleWebCommand } from './web';

// ---------------------------------------------------------------------------
// Re-exports — keep existing consumers working
// ---------------------------------------------------------------------------

export { handleLoginCommand, handleLogoutCommand } from './auth';
export { handleBtwCommand } from './btw';
export { handleCopyCommand } from './copy';
export { handleAddDirCommand } from './add-dir';
export {
  handleAutoCommand,
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleModelCommand,
  handlePlanCommand,
  handleSecondaryModelCommand,
  handleThemeCommand,
  handleYoloCommand,
  showModelPicker,
  showExperimentsPanel,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
export { handleSwarmCommand } from './swarm';
export { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info';
export { handlePluginsCommand } from './plugins';
export { handleReloadCommand, handleReloadTuiCommand } from './reload';
export { handleGoalCommand } from './goal';
export {
  handleExportDebugZipCommand,
  handleExportMdCommand,
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session';
export { handleUndoCommand } from './undo';
export { handleWebCommand } from './web';

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface SlashCommandHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  /** agent-core-v2 engine; enables lazy session creation. */
  readonly engineV2: boolean;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  refreshSlashCommandAutocomplete(): void;
  /**
   * Rebuild the plugin slash-command list. With no session (v2 session-less
   * startup) this reads the app-global plugin commands instead, so `/plugins`
   * mutations apply before the first session exists.
   */
  refreshPluginCommands(session?: Session): Promise<void>;
  /**
   * Rebuild the skill slash-command list. With no session (v2 session-less
   * startup) this reads the workspace skills instead.
   */
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  /**
   * Seed appState with the config defaults the v2 engine would apply at
   * createSession time (model, permission, plan mode, thinking effort,
   * context cap). No-op semantics on a live session path: only /reload calls
   * it while still session-less.
   */
  hydrateLazyConfigDefaults(): Promise<void>;

  // Session
  requireSession(): Session;
  /**
   * Lazy-create the session on first use (v2 engine). Returns the existing
   * session, or undefined (with the error already surfaced) when creation
   * fails.
   */
  ensureSession(): Promise<Session | undefined>;
  /** Await the in-flight lazy session creation, if any (v2); no-op otherwise. */
  waitForLazyCreation(): Promise<void>;
  switchToSession(session: Session, message: string): Promise<void>;
  reloadCurrentSessionView(session: Session, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  requestQueuedGoalPromotion?(): void;
  /** Reset the client-side cache-break baseline after the context was cut
   *  (/undo): the next step's cache-read drop is expected, not a break. */
  noteContextCut?(): void;

  // UI
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle;
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  refreshTerminalThemeTracking(): void;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  setExitOpenUrl(url: string): void;
  /**
   * Register a task that takes over the process after the TUI has shut down
   * (instead of exiting): the runner awaits it and only exits when it returns.
   * Used by `/web` to keep a freshly started server attached to this terminal
   * until Ctrl+C.
   */
  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  sendNormalUserInput(text: string): void;
  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void;
  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void;
  readonly skillCommandMap: Map<string, string>;
  readonly pluginCommandMap: Map<string, string>;

  // Controller refs
  readonly streamingUI: StreamingUIController;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly authFlow: AuthFlowController;
}

// ---------------------------------------------------------------------------
// Dispatch — entry point from handleUserInput
// ---------------------------------------------------------------------------

export function dispatchInput(host: SlashCommandHost, text: string): void {
  if (parseSlashInput(text) !== null) {
    void executeSlashCommand(host, text);
    return;
  }
  host.sendNormalUserInput(text);
}

async function executeSlashCommand(host: SlashCommandHost, input: string): Promise<void> {
  const parsedCommand = parseSlashInput(input);
  const intent = resolveSlashCommandInput({
    input,
    skillCommandMap: host.skillCommandMap,
    pluginCommandMap: host.pluginCommandMap,
    isStreaming: host.state.appState.streamingPhase !== 'idle',
    isCompacting: host.state.appState.isCompacting,
  });

  switch (intent.kind) {
    case 'not-command':
      return;
    case 'blocked':
      host.track('input_command_invalid', { reason: 'blocked', command: intent.commandName });
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      return;
    case 'invalid':
      host.track('input_command_invalid', {
        reason: intent.reason,
        command: intent.commandName,
      });
      host.showError(`Invalid slash command: /${intent.commandName}`);
      return;
    case 'skill': {
      if (host.state.appState.model.trim().length === 0) {
        host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      let session = host.session;
      if (session === undefined) {
        session = await ensureSessionForCommand(host);
        if (session === undefined) return;
        // A first prompt may have started a turn while the session was being
        // created; skill commands are always busy-gated, so re-check the gate
        // resolved before the await.
        const busyReason = slashCommandBusyReason({
          isStreaming: host.state.appState.streamingPhase !== 'idle',
          isCompacting: host.state.appState.isCompacting,
        });
        if (busyReason !== undefined) {
          host.showError(slashBusyMessage(intent.commandName, busyReason));
          return;
        }
      }
      host.track('input_command', {
        command: intent.commandName,
        skill_name: intent.skillName,
      });
      host.sendSkillActivation(session, intent.skillName, intent.args);
      return;
    }
    case 'plugin-command': {
      if (host.state.appState.model.trim().length === 0) {
        host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      let session = host.session;
      if (session === undefined) {
        session = await ensureSessionForCommand(host);
        if (session === undefined) return;
        // Same busy re-check as the skill path: plugin commands are always
        // busy-gated too.
        const busyReason = slashCommandBusyReason({
          isStreaming: host.state.appState.streamingPhase !== 'idle',
          isCompacting: host.state.appState.isCompacting,
        });
        if (busyReason !== undefined) {
          host.showError(slashBusyMessage(intent.commandName, busyReason));
          return;
        }
      }
      host.track('input_command', { command: `${intent.pluginId}:${intent.commandName}` });
      host.activatePluginCommand(session, intent.pluginId, intent.commandName, intent.args);
      return;
    }
    case 'message':
      // Unknown slash command: let /dance claim it before it falls through to
      // the model as a normal message. This runs *after* builtin and skill
      // resolution, so a real command or a same-named skill always wins.
      if (parsedCommand !== null && tryHandleDanceCommand(host, parsedCommand)) {
        return;
      }
      host.sendNormalUserInput(intent.input);
      return;
    case 'builtin':
      host.track('input_command', { command: intent.name });
      if (intent.name === 'new' && parsedCommand?.name === 'clear') {
        host.track('clear');
      }
      try {
        await handleBuiltInSlashCommand(host, intent.name, intent.args);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
  }
}

/**
 * Lazy-create the session for a slash command that needs one (v2 engine).
 * v1 keeps the historical "no active session" error; on v2 a missing session
 * means the TUI started session-less, so commands create it on first use.
 * Returns undefined (error already shown) when creation fails.
 */
async function ensureSessionForCommand(host: SlashCommandHost): Promise<Session | undefined> {
  if (!host.engineV2) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return undefined;
  }
  return host.ensureSession();
}

/** Builtin commands that need an active session; lazy-created on the v2 engine. */
const SESSION_REQUIRING_COMMANDS: ReadonlySet<BuiltinSlashCommandName> = new Set([
  'btw',
  'compact',
  'export-debug-zip',
  'export-md',
  'fork',
  'goal',
  'init',
  'plan',
  'swarm',
  'undo',
  'web',
]);

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: BuiltinSlashCommandName,
  args: string,
): Promise<void> {
  if (host.session === undefined && SESSION_REQUIRING_COMMANDS.has(name)) {
    const session = await ensureSessionForCommand(host);
    if (session === undefined) return;
    // A first prompt may have started a turn while the session was being
    // created; re-check the availability gate that was resolved before the
    // await (idle-only commands are blocked while a turn is active).
    const command = findBuiltInSlashCommand(name);
    const busyReason = slashCommandBusyReason({
      isStreaming: host.state.appState.streamingPhase !== 'idle',
      isCompacting: host.state.appState.isCompacting,
    });
    if (
      busyReason !== undefined &&
      command !== undefined &&
      resolveSlashCommandAvailability(command, args) === 'idle-only'
    ) {
      host.showError(slashBusyMessage(name, busyReason));
      return;
    }
  }
  switch (name) {
    case 'exit':
      void host.stop();
      return;
    case 'help':
      host.showHelpPanel();
      return;
    case 'version':
      host.showStatus(`Kimi Code v${host.state.appState.version}`);
      return;
    case 'new': {
      // A first-use lazy creation may still be in flight: wait it out so /new
      // never races a second createSession against the pending prompt.
      await host.waitForLazyCreation();
      // The waited-out prompt may have started a turn meanwhile; /new is
      // idle-only, so re-run the busy gate resolved before the await.
      const busyReason = slashCommandBusyReason({
        isStreaming: host.state.appState.streamingPhase !== 'idle',
        isCompacting: host.state.appState.isCompacting,
      });
      if (busyReason !== undefined) {
        host.showError(slashBusyMessage(name, busyReason));
        return;
      }
      await host.createNewSession();
      host.state.ui.requestRender();
      return;
    }
    case 'sessions':
      void host.showSessionPicker();
      return;
    case 'tasks':
      void host.tasksBrowserController.show();
      return;
    case 'mcp':
      void showMcpServers(host);
      return;
    case 'plugins':
      // `handlePluginsCommand` throws when no session is active (its own
      // requireSession), so catch here instead of letting the `void` call
      // reject unhandled.
      try {
        await handlePluginsCommand(host, args);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
    case 'add-dir':
      await handleAddDirCommand(host, args);
      return;
    case 'experiments':
      await showExperimentsPanel(host);
      return;
    case 'reload':
      await handleReloadCommand(host);
      return;
    case 'reload-tui':
      await handleReloadTuiCommand(host);
      return;
    case 'editor':
      await handleEditorCommand(host, args);
      return;
    case 'theme':
      await handleThemeCommand(host, args);
      return;
    case 'model':
      await handleModelCommand(host, args);
      return;
    case 'secondary_model':
      await handleSecondaryModelCommand(host, args);
      return;
    case 'effort':
      await handleEffortCommand(host, args);
      return;
    case 'provider':
      await handleProviderCommand(host);
      return;
    case 'permission':
      showPermissionPicker(host);
      return;
    case 'settings':
      showSettingsSelector(host);
      return;
    case 'usage':
      void showUsage(host);
      return;
    case 'status':
      void showStatusReport(host);
      return;
    case 'feedback':
      await handleFeedbackCommand(host);
      return;
    case 'btw':
      await handleBtwCommand(host, args);
      return;
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'yolo':
      await handleYoloCommand(host, args);
      return;
    case 'auto':
      await handleAutoCommand(host, args);
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'swarm':
      await handleSwarmCommand(host, args);
      return;
    case 'compact':
      await handleCompactCommand(host, args);
      return;
    case 'goal':
      await handleGoalCommand(host, args);
      return;
    case 'init':
      await handleInitCommand(host);
      return;
    case 'fork':
      await handleForkCommand(host, args);
      return;
    case 'export-md':
      await handleExportMdCommand(host, args);
      return;
    case 'export-debug-zip':
      await handleExportDebugZipCommand(host);
      return;
    case 'copy':
      await handleCopyCommand(host);
      return;
    case 'login':
      await handleLoginCommand(host);
      return;
    case 'logout':
      await handleLogoutCommand(host);
      return;
    case 'undo':
      await handleUndoCommand(host, args);
      return;
    case 'web':
      await handleWebCommand(host);
      return;
    default:
      host.showError(`Unknown slash command: /${String(name)}`);
      return;
  }
}
