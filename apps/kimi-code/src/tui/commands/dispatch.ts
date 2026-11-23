import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import type { ReverseRpcModalOwner } from '../reverse-rpc/modal-coordinator';

import type { KimiHarness, Session, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import type { ColorToken, ThemeName } from '#/tui/theme';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import type { AuthFlowController } from '../controllers/auth-flow';
import type { BtwPanelController } from '../controllers/btw-panel';
import type { ModelMigrationController } from '../controllers/model-migration';
import type { StreamingUIController } from '../controllers/streaming-ui';
import type { TasksBrowserController } from '../controllers/tasks-browser';
import { tryHandleDanceCommand } from '../easter-eggs/dance';
import type { FollowUpDelivery } from '../config';
import type { ResolvedTheme } from '../theme/colors';
import type { TUIState } from '../tui-state';
import type {
  AppState,
  InlineSkillActivation,
  LoginProgressSpinnerHandle,
  ModelSwitchPersistence,
  QueuedMessage,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage } from '../utils/event-payload';
import type { ExtractionResult } from '../utils/image-placeholder';
import { handleLoginCommand, handleLogoutCommand } from './auth';
import { handleBtwCommand } from './btw';
import { handleCopyCommand } from './copy';
import { handleDesktopCommand } from './desktop';
import {
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleModelCommand,
  handlePlanCommand,
  handleSecondaryModelCommand,
  handleThemeCommand,
  showExperimentsPanel,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
import { handleGoalCommand } from './goal';
import { handleImportSessionsCommand } from './import-sessions';
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
  canRestoreSubmittedInput,
  resolveUserInput,
  type SlashCommandIntent,
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
import { handleTowerCommand } from './tower';
import { handleUndoCommand } from './undo';
import { handleRemoteControlCommand, handleWebCommand } from './web';

export { handleLoginCommand, handleLogoutCommand } from './auth';
export { handleBtwCommand } from './btw';
export { handleCopyCommand } from './copy';
export { handleDesktopCommand } from './desktop';
export { handleAddDirCommand } from './add-dir';
export {
  handleCompactCommand,
  handleEditorCommand,
  handleEffortCommand,
  handleModelCommand,
  handlePlanCommand,
  handleSecondaryModelCommand,
  handleThemeCommand,
  showModelPicker,
  showExperimentsPanel,
  showPermissionPicker,
  showSettingsSelector,
} from './config';
export { handleSwarmCommand } from './swarm';
export { handleTowerCommand } from './tower';
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
export { handleRemoteControlCommand, handleWebCommand } from './web';

export interface SlashCommandHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(
    panel: Component & Focusable,
    onDisplaced?: () => void,
    onReplaced?: () => void,
    owner?: ReverseRpcModalOwner,
  ): void;
  restoreEditor(): void;
  restoreInputText(text: string, inlineSkillActivations?: readonly InlineSkillActivation[]): void;
  refreshSlashCommandAutocomplete(): void;
  refreshPluginCommands(session?: Session): Promise<void>;
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  hydrateLazyConfigDefaults(includeModel?: boolean): Promise<void>;

  requireSession(): Session;
  ensureSession(): Promise<Session | undefined>;
  waitForSessionAssembly(): Promise<void>;
  readonly sessionReplacementInFlight: boolean;
  switchToSession(session: Session, message: string): Promise<void>;
  reloadCurrentSessionView(session: Session, message: string): Promise<void>;
  refreshWorkLocation(): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  drainQueueIfIdle(): void;
  completedCompactionSerial: number;
  enqueueCompactCommand(args: string): boolean;
  enqueueModelSwitch(
    alias: string,
    thinking: ThinkingEffort,
    persist: ModelSwitchPersistence,
  ): void;
  requestQueuedGoalPromotion?(): void;

  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle;
  beginAuthBlock(): () => void;
  setAuthRequired(required: boolean): void;
  showProgressSpinner(label: string): LoginProgressSpinnerHandle;

  applyTheme(theme: ThemeName, resolved?: ResolvedTheme): Promise<void>;
  refreshTerminalThemeTracking(): void;

  stop(exitCode?: number): Promise<void>;
  requestExit(): Promise<void>;
  setExitOpenUrl(url: string): void;
  setExitForegroundTask(task: (exitCode: number) => Promise<void>): void;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  showWorktreePanel(): Promise<void>;
  sendNormalUserInput(text: string, preExtracted?: ExtractionResult, delivery?: FollowUpDelivery): void;
  sendInlineSkillUserInput(
    text: string,
    activations: readonly InlineSkillActivation[],
    preExtracted?: ExtractionResult,
    delivery?: FollowUpDelivery,
  ): Promise<void>;
  activatePluginCommand(
    session: Session,
    pluginId: string,
    commandName: string,
    args: string,
  ): void;
  readonly skillCommandMap: Map<string, string>;
  readonly pluginCommandMap: Map<string, string>;
  readonly skillVariantPathForCommand?: (commandName: string, tokenStart: number) => string | undefined;
  readonly defaultSkillPathForCommand?: (commandName: string) => string | undefined;

  readonly streamingUI: StreamingUIController;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
  readonly authFlow: AuthFlowController;
  readonly modelMigration: ModelMigrationController;
}

export function dispatchInput(
  host: SlashCommandHost,
  text: string,
  delivery: FollowUpDelivery = 'default',
): void {
  const { intent, activations } = resolveUserInput({
    input: text,
    skillCommandMap: host.skillCommandMap,
    pluginCommandMap: host.pluginCommandMap,
    isStreaming: host.state.appState.streamingPhase !== 'idle',
    isCompacting: host.state.appState.isCompacting,
    skillVariantPathForCommand: host.skillVariantPathForCommand === undefined
      ? undefined
      : (commandName, tokenStart) => host.skillVariantPathForCommand!(commandName, tokenStart),
    defaultSkillPathForCommand: host.defaultSkillPathForCommand === undefined
      ? undefined
      : (commandName) => host.defaultSkillPathForCommand!(commandName),
  });
  if (intent.kind === 'skill' || (activations.length > 0 && intent.kind !== 'builtin')) {
    const leading = activations[0];
    if (intent.kind === 'skill' && leading?.args !== undefined && host.state.appState.model.trim().length > 0) {
      host.track('input_command', {
        command: intent.commandName,
        skill_name: leading.skillName,
      });
    }
    void host.sendInlineSkillUserInput(text, activations, undefined, delivery);
    return;
  }
  if (intent.kind !== 'not-command') {
    void executeSlashCommand(host, text, intent, activations, delivery);
    return;
  }
  host.sendNormalUserInput(text, undefined, delivery);
}

async function executeSlashCommand(
  host: SlashCommandHost,
  input: string,
  intent: Exclude<SlashCommandIntent, { readonly kind: 'skill' | 'not-command' }>,
  activations: readonly InlineSkillActivation[],
  delivery: FollowUpDelivery,
): Promise<void> {
  const parsedCommand = parseSlashInput(input);

  switch (intent.kind) {
    case 'blocked':
      host.track('input_command_invalid', { reason: 'blocked', command: intent.commandName });
      host.showError(slashBusyMessage(intent.commandName, intent.reason));
      host.restoreInputText(input);
      return;
    case 'invalid':
      host.track('input_command_invalid', {
        reason: intent.reason,
        command: intent.commandName,
      });
      host.showError(`Invalid slash command: /${intent.commandName}`);
      return;
    case 'plugin-command': {
      if (host.state.appState.model.trim().length === 0) {
        host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      let session = host.session;
      if (session === undefined) {
        session = await ensureSessionForCommand(host);
        if (session === undefined) return;
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
      if (parsedCommand !== null && tryHandleDanceCommand(host, parsedCommand)) {
        return;
      }
      host.sendNormalUserInput(intent.input, undefined, delivery);
      return;
    case 'builtin':
      if (intent.enqueue === true) {
        if (!host.enqueueCompactCommand(intent.args)) {
          host.track('input_command_invalid', { reason: 'duplicate-compact', command: intent.name });
          host.showError('A /compact is already queued.');
          host.restoreInputText(input);
          return;
        }
        host.track('input_queue');
        return;
      }
      host.track('input_command', { command: intent.name });
      if (intent.name === 'new' && parsedCommand?.name === 'clear') {
        host.track('clear');
      }
      try {
        await handleBuiltInSlashCommand(host, intent.name, intent.args, input, activations);
      } catch (error) {
        host.showError(formatErrorMessage(error));
      }
      return;
  }
}

async function ensureSessionForCommand(host: SlashCommandHost): Promise<Session | undefined> {
  return host.ensureSession();
}

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
  input: string,
  activations: readonly InlineSkillActivation[],
): Promise<void> {
  if (host.session === undefined && SESSION_REQUIRING_COMMANDS.has(name)) {
    const session = await ensureSessionForCommand(host);
    if (session === undefined) {
      if (canRestoreSubmittedInput(host)) host.restoreInputText(input, activations);
      return;
    }
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
      if (name === 'compact' && busyReason === 'streaming' && !host.state.appState.isCompacting) {
        if (!host.enqueueCompactCommand(args)) {
          host.showError('A /compact is already queued.');
          if (canRestoreSubmittedInput(host)) host.restoreInputText(input);
        }
        return;
      }
      host.showError(slashBusyMessage(name, busyReason));
      if (canRestoreSubmittedInput(host)) host.restoreInputText(input);
      return;
    }
  }
  switch (name) {
    case 'exit':
      void host.requestExit();
      return;
    case 'help':
      host.showHelpPanel();
      return;
    case 'version':
      host.showStatus(`Kimi Code v${host.state.appState.version}`);
      return;
    case 'new': {
      await host.waitForSessionAssembly();
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
    case 'worktree':
      await host.showWorktreePanel();
      return;
    case 'tasks':
      void host.tasksBrowserController.show();
      return;
    case 'mcp':
      void showMcpServers(host);
      return;
    case 'plugins':
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
    case 'secondary-model':
      await handleSecondaryModelCommand(host, args);
      return;
    case 'effort':
      await handleEffortCommand(host, args);
      return;
    case 'provider':
      await handleProviderCommand(host, args);
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
      await handleBtwCommand(host, args, activations);
      return;
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'yolo':
      showPermissionPicker(host, 'yolo');
      return;
    case 'auto':
      showPermissionPicker(host, 'auto');
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'swarm':
      await handleSwarmCommand(host, args);
      return;
    case 'tower':
      await handleTowerCommand(host, args);
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
    case 'import-sessions':
      handleImportSessionsCommand(host);
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
    case 'desktop':
      await handleDesktopCommand(host);
      return;
    case 'remote-control':
      await handleRemoteControlCommand(host);
      return;
    default:
      host.showError(`Unknown slash command: /${String(name)}`);
      return;
  }
}
