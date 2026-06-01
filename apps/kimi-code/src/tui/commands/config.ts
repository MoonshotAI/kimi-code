import type { PermissionMode, Session } from '@moonshot-ai/kimi-code-sdk';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { saveTuiConfig } from '../config';
import type { Theme } from '../theme';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { isTheme } from '../theme/index';
import { formatErrorMessage } from '../utils/event-payload';
import { showUsage } from './info';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

const PERMISSION_COMMAND_USAGE =
  'Usage: /permission [manual|auto|yolo] or /permission default <manual|auto|yolo>';

function parsePermissionMode(value: string): PermissionMode | undefined {
  if (value === 'manual' || value === 'auto' || value === 'yolo') return value;
  return undefined;
}

export async function handlePlanCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  if (subcmd === 'clear') {
    await session.clearPlan();
    host.showNotice('Plan cleared');
    return;
  }

  let enabled: boolean;
  if (subcmd.length === 0) enabled = !host.state.appState.planMode;
  else if (subcmd === 'on') enabled = true;
  else if (subcmd === 'off') enabled = false;
  else {
    host.showError(`Unknown plan subcommand: ${subcmd}`);
    return;
  }

  await applyPlanMode(host, session, enabled);
}

async function applyPlanMode(host: SlashCommandHost, session: Session, enabled: boolean): Promise<void> {
  try {
    await session.setPlanMode(enabled);
    host.setAppState({ planMode: enabled });
    if (enabled) {
      const plan = await session.getPlan().catch(() => null);
      host.showNotice(
        'Plan mode: ON',
        plan?.path !== undefined ? `Plan will be created here: ${plan.path}` : undefined,
      );
      return;
    }
    host.showNotice('Plan mode: OFF');
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set plan mode: ${msg}`);
  }
}

export async function handleYoloCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'yolo') {
      host.showNotice('YOLO mode is already on');
      return;
    }
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice('YOLO mode: ON', 'Workspace tools auto-approved.');
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'yolo') {
      host.showNotice('YOLO mode is already off');
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('YOLO mode: OFF');
    return;
  }

  // toggle
  if (currentMode === 'yolo') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('YOLO mode: OFF');
  } else {
    await session.setPermission('yolo');
    host.setAppState({ permissionMode: 'yolo' });
    host.showNotice('YOLO mode: ON', 'Workspace tools auto-approved.');
  }
}

export async function handleAutoCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const subcmd = args.trim().toLowerCase();
  const currentMode = host.state.appState.permissionMode;

  if (subcmd === 'on') {
    if (currentMode === 'auto') {
      host.showNotice('Auto mode is already on');
      return;
    }
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice('Auto mode: ON', 'Tools auto-approved. Agent will not ask questions.');
    return;
  }

  if (subcmd === 'off') {
    if (currentMode !== 'auto') {
      host.showNotice('Auto mode is already off');
      return;
    }
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('Auto mode: OFF');
    return;
  }

  // toggle
  if (currentMode === 'auto') {
    await session.setPermission('manual');
    host.setAppState({ permissionMode: 'manual' });
    host.showNotice('Auto mode: OFF');
  } else {
    await session.setPermission('auto');
    host.setAppState({ permissionMode: 'auto' });
    host.showNotice('Auto mode: ON', 'Tools auto-approved. Agent will not ask questions.');
  }
}

export async function handlePermissionCommand(host: SlashCommandHost, args: string): Promise<void> {
  const tokens = args
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    showPermissionPicker(host);
    return;
  }

  if (tokens[0] === 'default') {
    const mode = tokens.length === 2 ? parsePermissionMode(tokens[1] ?? '') : undefined;
    if (mode === undefined) {
      host.showError(PERMISSION_COMMAND_USAGE);
      return;
    }
    await applyDefaultPermissionChoice(host, mode);
    return;
  }

  const mode = tokens.length === 1 ? parsePermissionMode(tokens[0] ?? '') : undefined;
  if (mode === undefined) {
    host.showError(PERMISSION_COMMAND_USAGE);
    return;
  }
  await applyPermissionChoice(host, mode);
}

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const customInstruction = args.trim() || undefined;
  await session.compact({ instruction: customInstruction });
}

export async function handleEditorCommand(host: SlashCommandHost, args: string): Promise<void> {
  const command = args.trim();
  if (command.length === 0) {
    showEditorPicker(host);
    return;
  }
  await applyEditorChoice(host, command);
}

export async function handleThemeCommand(host: SlashCommandHost, args: string): Promise<void> {
  const theme = args.trim();
  if (theme.length === 0) {
    showThemePicker(host);
    return;
  }
  if (!isTheme(theme)) {
    host.showError(`Unknown theme: ${theme}`);
    return;
  }
  await applyThemeChoice(host, theme);
}

export function handleModelCommand(host: SlashCommandHost, args: string): void {
  const alias = args.trim();
  if (alias.length === 0) {
    showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  showModelPicker(host, alias);
}

// ---------------------------------------------------------------------------
// Pickers & config apply
// ---------------------------------------------------------------------------

function showEditorPicker(host: SlashCommandHost): void {
  const currentValue = host.state.appState.editorCommand ?? '';
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyEditorChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyEditorChoice(host: SlashCommandHost, value: string): Promise<void> {
  const previous = host.state.appState.editorCommand ?? '';
  if (value === previous && value.length > 0) {
    host.showStatus(`Editor unchanged: ${value.length > 0 ? value : 'auto-detect'}`);
    return;
  }

  const editorCommand = value.length > 0 ? value : null;
  try {
    await saveTuiConfig({
      theme: host.state.appState.theme,
      editorCommand,
      notifications: host.state.appState.notifications,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save editor: ${formatErrorMessage(error)}`,
      host.state.theme.colors.error,
    );
    return;
  }

  host.setAppState({ editorCommand });
  host.showStatus(
    value.length > 0
      ? `Editor set to "${value}".`
      : 'Editor set to auto-detect ($VISUAL / $EDITOR).',
  );
}

export function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): void {
  const entries = Object.entries(host.state.appState.availableModels);
  if (entries.length === 0) {
    host.showNotice(
      'No models configured',
      'Run /login to sign in to Kimi, or /connect to add another provider from a model catalog.',
    );
    return;
  }
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models: host.state.appState.availableModels,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinking: host.state.appState.thinking,
      colors: host.state.theme.colors,
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, thinking);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performModelSwitch(host: SlashCommandHost, alias: string, thinking: boolean): Promise<void> {
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const level = thinking ? 'on' : 'off';
  const prevModel = host.state.appState.model;
  const prevThinking = host.state.appState.thinking;
  const runtimeChanged = alias !== prevModel || thinking !== prevThinking;

  const session = host.session;
  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, thinking);
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
    host.showError(`Failed to switch model: ${msg}`);
    return;
  }

  host.setAppState({ model: alias, thinking });
  if (session === undefined && runtimeChanged) {
    if (alias !== prevModel) {
      host.track('model_switch', { model: alias });
    }
    if (thinking !== prevThinking) {
      host.track('thinking_toggle', { enabled: thinking });
    }
  }

  let persisted = false;
  try {
    persisted = await persistModelSelection(host, alias, thinking);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Switched to ${alias}, but failed to save default: ${msg}`);
    return;
  }

  const status = runtimeChanged
    ? `Switched to ${alias} with thinking ${level}.`
    : persisted
      ? `Saved ${alias} with thinking ${level} as default.`
      : `Already using ${alias} with thinking ${level}.`;
  host.showStatus(status, host.state.theme.colors.success);
}

async function persistModelSelection(host: SlashCommandHost, alias: string, thinking: boolean): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  if (config.defaultModel === alias && config.defaultThinking === thinking) {
    return false;
  }
  await host.harness.setConfig({
    defaultModel: alias,
    defaultThinking: thinking,
  });
  return true;
}

function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyThemeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyThemeChoice(host: SlashCommandHost, theme: Theme): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === 'auto') host.refreshTerminalThemeTracking();
    host.showStatus(`Theme unchanged: "${theme}".`);
    return;
  }

  try {
    await saveTuiConfig({
      theme,
      editorCommand: host.state.appState.editorCommand,
      notifications: host.state.appState.notifications,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save theme: ${formatErrorMessage(error)}`,
      host.state.theme.colors.error,
    );
    return;
  }

  const resolved = theme === 'auto' ? host.state.theme.resolvedTheme : theme;
  host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.track('theme_switch', { theme });
  const detail = theme === 'auto' ? ` (tracking terminal; current: ${resolved})` : '';
  host.showStatus(`Theme set to "${theme}"${detail}.`);
}

export function showPermissionPicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      colors: host.state.theme.colors,
      onSelect: (value) => {
        host.restoreEditor();
        void applyPermissionChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  if (mode === host.state.appState.permissionMode) {
    host.showStatus(`Permission mode unchanged: ${mode}.`);
    return;
  }

  try {
    await session.setPermission(mode);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set permission mode: ${msg}`);
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(`Permission mode: ${mode}`);
}

function showDefaultPermissionPicker(host: SlashCommandHost): void {
  void (async () => {
    let currentValue: PermissionMode = 'manual';
    try {
      const config = await host.harness.getConfig({ reload: true });
      currentValue = config.defaultPermissionMode ?? 'manual';
    } catch {
      currentValue = host.state.appState.permissionMode;
    }

    host.mountEditorReplacement(
      new PermissionSelectorComponent({
        currentValue,
        colors: host.state.theme.colors,
        onSelect: (value) => {
          host.restoreEditor();
          void applyDefaultPermissionChoice(host, value);
        },
        onCancel: () => {
          host.restoreEditor();
        },
      }),
    );
  })();
}

async function applyDefaultPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  let persisted = false;
  try {
    const config = await host.harness.getConfig({ reload: true });
    if (config.defaultPermissionMode !== mode) {
      await host.harness.setConfig({ defaultPermissionMode: mode });
      persisted = true;
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to save default permission mode: ${msg}`);
    return;
  }

  let currentUpdated = false;
  const session = host.session;
  if (session !== undefined && mode !== host.state.appState.permissionMode) {
    try {
      await session.setPermission(mode);
      host.setAppState({ permissionMode: mode });
      currentUpdated = true;
    } catch (error) {
      const msg = formatErrorMessage(error);
      const prefix = persisted
        ? `Default permission mode set to ${mode}`
        : `Default permission mode already ${mode}`;
      host.showError(`${prefix}, but failed to update current session: ${msg}`);
      return;
    }
  }

  const status = persisted
    ? `Default permission mode set to ${mode}.`
    : `Default permission mode already ${mode}.`;
  const detail = currentUpdated ? ' Current session updated.' : '';
  host.showStatus(`${status}${detail}`, host.state.theme.colors.success);
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
      colors: host.state.theme.colors,
      onSelect: (value) => {
        handleSettingsSelection(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function handleSettingsSelection(host: SlashCommandHost, value: SettingsSelection): void {
  host.restoreEditor();
  switch (value) {
    case 'model': showModelPicker(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'default-permission': showDefaultPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}
