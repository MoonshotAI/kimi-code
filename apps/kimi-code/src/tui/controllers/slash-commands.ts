import type { Component, Focusable } from '@earendil-works/pi-tui';
import type { DeviceAuthorization } from '@moonshot-ai/kimi-code-oauth';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import type { Theme } from '../theme';
import type { ResolvedTheme } from '../theme/colors';
import {
  LLM_NOT_SET_MESSAGE,
} from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  parseSlashInput,
  resolveSlashCommandInput,
  slashBusyMessage,
  type BuiltinSlashCommandName,
} from '../commands';
import type { AuthFlowController } from './auth-flow';
import type { StreamingUIController } from './streaming-ui';
import type { TasksBrowserController } from './tasks-browser';
import type { AppState, LoginProgressSpinnerHandle, QueuedMessage } from '../types';
import type { TUIState } from '../tui-state';

import { handleConnectCommand, handleLoginCommand, handleLogoutCommand } from './auth-commands';
import {
  handleCompactCommand,
  handleEditorCommand,
  handleModelCommand,
  handlePlanCommand,
  handleThemeCommand,
  handleYoloCommand,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config-commands';
import { handleFeedbackCommand, showMcpServers, showStatusReport, showUsage } from './info-commands';
import { handleForkCommand, handleInitCommand, handleTitleCommand } from './session-commands';

// ---------------------------------------------------------------------------
// Re-exports — keep existing consumers working
// ---------------------------------------------------------------------------

export {
  handleConnectCommand,
  handleLoginCommand,
  handleLogoutCommand,
} from './auth-commands';
export {
  handleCompactCommand,
  handleEditorCommand,
  handleModelCommand,
  handlePlanCommand,
  handleThemeCommand,
  handleYoloCommand,
  showModelPicker,
  showPermissionPicker,
  showSettingsSelector,
} from './config-commands';
export {
  handleFeedbackCommand,
  showMcpServers,
  showStatusReport,
  showUsage,
} from './info-commands';
export {
  handleForkCommand,
  handleInitCommand,
  handleTitleCommand,
} from './session-commands';

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

export interface SlashCommandHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  cancelInFlight: (() => void) | undefined;
  deferUserMessages: boolean;

  setAppState(patch: Partial<AppState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: string): void;
  showNotice(title: string, detail?: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;

  // Session
  requireSession(): Session;
  switchToSession(session: Session, message: string): Promise<void>;
  beginSessionRequest(): void;
  failSessionRequest(message: string): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;

  // UI
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: Theme, resolved?: ResolvedTheme): void;
  refreshTerminalThemeTracking(): void;

  // Dispatch
  stop(exitCode?: number): Promise<void>;
  showHelpPanel(): void;
  createNewSession(): Promise<void>;
  showSessionPicker(): Promise<void>;
  sendNormalUserInput(text: string): void;
  sendSkillActivation(session: Session, skillName: string, skillArgs: string): void;
  readonly skillCommandMap: Map<string, string>;

  // Controller refs
  readonly streamingUI: StreamingUIController;
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
    case 'skill': {
      const session = host.session;
      if (host.state.appState.model.trim().length === 0 || session === undefined) {
        host.showError(LLM_NOT_SET_MESSAGE);
        return;
      }
      host.track('input_command', {
        command: intent.commandName,
        skill_name: intent.skillName,
      });
      host.sendSkillActivation(session, intent.skillName, intent.args);
      return;
    }
    case 'message':
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

async function handleBuiltInSlashCommand(
  host: SlashCommandHost,
  name: BuiltinSlashCommandName,
  args: string,
): Promise<void> {
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
    case 'new':
      await host.createNewSession();
      host.state.ui.requestRender();
      return;
    case 'sessions':
      void host.showSessionPicker();
      return;
    case 'tasks':
      void host.tasksBrowserController.show();
      return;
    case 'mcp':
      void showMcpServers(host);
      return;
    case 'editor':
      await handleEditorCommand(host, args);
      return;
    case 'theme':
      await handleThemeCommand(host, args);
      return;
    case 'model':
      handleModelCommand(host, args);
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
    case 'title':
      await handleTitleCommand(host, args);
      return;
    case 'yolo':
      await handleYoloCommand(host, args);
      return;
    case 'plan':
      await handlePlanCommand(host, args);
      return;
    case 'compact':
      await handleCompactCommand(host, args);
      return;
    case 'init':
      await handleInitCommand(host);
      return;
    case 'fork':
      await handleForkCommand(host, args);
      return;
    case 'login':
      await handleLoginCommand(host);
      return;
    case 'connect':
      await handleConnectCommand(host, args);
      return;
    case 'logout':
      await handleLogoutCommand(host);
      return;
    default:
      host.showError(`Unknown slash command: /${String(name)}`);
      return;
  }
}
