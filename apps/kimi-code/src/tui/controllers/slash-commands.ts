import { release as osRelease, type as osType } from 'node:os';

import {
  applyOpenPlatformConfig,
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
  catalogProviderModels,
  CatalogFetchError,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  log,
  type Catalog,
  type KimiHarness,
  type McpServerInfo,
  type PermissionMode,
  type Session,
  type SessionStatus,
  type SessionUsage,
} from '@moonshot-ai/kimi-code-sdk';

import type { Component, Focusable } from '@earendil-works/pi-tui';

import { BUILT_IN_CATALOG_JSON } from '../../built-in-catalog';
import type { ChoiceOption } from '../components/dialogs/choice-picker';
import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { ModelSelectorComponent } from '../components/dialogs/model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { buildMcpStatusReportLines } from '../components/messages/mcp-status-panel';
import { buildStatusReportLines } from '../components/messages/status-panel';
import { buildUsageReportLines, UsagePanelComponent, type ManagedUsageReport } from '../components/messages/usage-panel';
import { saveTuiConfig } from '../config';
import type { Theme } from '../theme';
import type { ResolvedTheme } from '../theme/colors';
import {
  promptApiKey,
  promptCatalogProviderSelection,
  promptFeedbackInput,
  promptLogoutProviderSelection,
  promptModelSelectionForCatalog,
  promptModelSelectionForOpenPlatform,
  promptPlatformSelection,
} from './slash-command-prompts';
import {
  DEFAULT_OAUTH_PROVIDER_NAME,
  LLM_NOT_SET_MESSAGE,
  NO_ACTIVE_SESSION_MESSAGE,
  PRODUCT_NAME,
} from '../constant/kimi-tui';
import {
  FEEDBACK_ISSUE_URL,
  FEEDBACK_STATUS_CANCELLED,
  FEEDBACK_STATUS_FALLBACK,
  FEEDBACK_STATUS_NOT_SIGNED_IN,
  FEEDBACK_STATUS_SUBMITTING,
  FEEDBACK_STATUS_SUCCESS,
  FEEDBACK_TELEMETRY_EVENT,
  feedbackSessionLine,
  withFeedbackVersionPrefix,
} from '../constant/feedback';
import { isManagedUsageProvider } from '../constant/kimi-tui';
import { isTheme } from '../theme/index';
import { resolveConnectCatalogRequest } from '../utils/connect-catalog';
import { isAbortError } from '../utils/errors';
import { formatErrorMessage } from '../utils/event-payload';
import { openUrl } from '../utils/open-url';
import type { AuthFlowController } from './auth-flow';
import type { AppState, QueuedMessage } from '../types';
import type { TUIState, LoginProgressSpinnerHandle } from '../kimi-tui';

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
  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;

  // UI
  showLoginProgressSpinner(label: string): LoginProgressSpinnerHandle;
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle;

  // Theme
  applyTheme(theme: Theme, resolved?: ResolvedTheme): void;
  refreshTerminalThemeTracking(): void;

  // Controller refs
  readonly authFlow: AuthFlowController;

}

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

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

  let enabled: boolean;
  if (args === 'on') enabled = true;
  else if (args === 'off') enabled = false;
  else enabled = !host.state.appState.yolo;

  await session.setPermission(enabled ? 'yolo' : 'manual');
  host.setAppState({ yolo: enabled, permissionMode: enabled ? 'yolo' : 'manual' });
  if (enabled) {
    host.showNotice(
      'YOLO mode: ON',
      'All actions will be approved automatically. Use with caution.',
    );
    return;
  }
  host.showNotice('YOLO mode: OFF');
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
// Session commands
// ---------------------------------------------------------------------------

export async function handleTitleCommand(host: SlashCommandHost, args: string): Promise<void> {
  const title = args.trim();
  if (title.length === 0) {
    const current = host.state.appState.sessionTitle;
    host.showStatus(
      current !== null && current.length > 0
        ? `Session title: ${current}`
        : `Session title: (not set) — id: ${host.state.appState.sessionId}`,
    );
    return;
  }

  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const newTitle = title.slice(0, 200);
  try {
    await host.harness.renameSession({ id: session.id, title: newTitle });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set title: ${msg}`);
    return;
  }
  host.showStatus(`Session title set to: ${newTitle}`);
}

export async function handleForkCommand(host: SlashCommandHost, args: string): Promise<void> {
  void args;
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const sourceTitle = forkSourceTitle(host, session);
  let forked: Session;
  try {
    forked = await host.harness.forkSession({
      id: session.id,
      title: `Fork: ${sourceTitle}`,
    });
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to fork session: ${msg}`);
    return;
  }

  try {
    await host.switchToSession(forked, `Session forked (${forked.id}).`);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch to forked session: ${msg}`);
  }
}

function forkSourceTitle(host: SlashCommandHost, session: Session): string {
  const currentTitle = host.state.appState.sessionTitle?.trim();
  if (currentTitle !== undefined && currentTitle.length > 0) return currentTitle;

  const summaryTitle =
    typeof session.summary?.title === 'string' ? session.summary.title.trim() : '';
  return summaryTitle.length > 0 ? summaryTitle : session.id;
}

export async function handleInitCommand(host: SlashCommandHost): Promise<void> {
  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  host.deferUserMessages = true;
  host.beginSessionRequest();
  try {
    await session.init();
    host.track('init_complete');
    host.finalizeTurn((item) => {
      host.sendQueuedMessage(session, item);
    });
  } catch (error) {
    if (isAbortError(error)) {
      host.setAppState({ isStreaming: false, streamingPhase: 'idle' });
      host.resetLivePane();
      return;
    }
    const msg = error instanceof Error ? error.message : String(error);
    host.failSessionRequest(`Init failed: ${msg}`);
  } finally {
    host.deferUserMessages = false;
  }
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export async function handleFeedbackCommand(host: SlashCommandHost): Promise<void> {
  const fallback = (reason: string): void => {
    host.showStatus(reason);
    host.showStatus(FEEDBACK_ISSUE_URL);
    openUrl(FEEDBACK_ISSUE_URL);
  };

  const providerKey = host.state.appState.availableModels[host.state.appState.model]?.provider;
  if (!isManagedUsageProvider(providerKey)) {
    fallback(FEEDBACK_STATUS_NOT_SIGNED_IN);
    return;
  }

  const content = await promptFeedbackInput(host);
  if (content === undefined) {
    host.showStatus(FEEDBACK_STATUS_CANCELLED);
    return;
  }

  const spinner = host.showLoginProgressSpinner(FEEDBACK_STATUS_SUBMITTING);
  const res = await host.harness.auth.submitFeedback({
    content,
    sessionId: host.state.appState.sessionId,
    version: withFeedbackVersionPrefix(host.state.appState.version),
    os: `${osType()} ${osRelease()}`,
    model: host.state.appState.model.length > 0 ? host.state.appState.model : null,
  });

  if (res.kind === 'ok') {
    spinner.stop({ ok: true, label: FEEDBACK_STATUS_SUCCESS });
    host.showStatus(feedbackSessionLine(host.state.appState.sessionId));
    host.track(FEEDBACK_TELEMETRY_EVENT);
    return;
  }

  spinner.stop({ ok: false, label: res.message });
  fallback(FEEDBACK_STATUS_FALLBACK);
}


// ---------------------------------------------------------------------------
// Auth: login / logout / connect
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  const platformId = await promptPlatformSelection(host);
  if (platformId === undefined) return;

  if (platformId === 'kimi-code') {
    await handleKimiCodeOAuthLogin(host);
    return;
  }

  const platform = getOpenPlatformById(platformId);
  if (platform === undefined) return;
  await handleOpenPlatformLogin(host, platform);
}

async function handleKimiCodeOAuthLogin(host: SlashCommandHost): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    spinner?.stop({ ok: true, label: 'Logged in.' });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(`Authentication successful, but failed to refresh config: ${message}`);
      return;
    }
    host.track('login', {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      already_logged_in: alreadyLoggedIn,
    });
    if (alreadyLoggedIn) {
      host.showStatus('Already logged in. Model configuration refreshed.');
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
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

async function handleOpenPlatformLogin(
  host: SlashCommandHost,
  platform: OpenPlatformDefinition,
): Promise<void> {
  const apiKey = await promptApiKey(host, platform.name);
  if (apiKey === undefined) return;

  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;

  let models: ManagedKimiCodeModelInfo[];
  try {
    models = await fetchOpenPlatformModels(platform, apiKey, fetch, controller.signal);
    models = filterModelsByPrefix(models, platform);
  } catch (error) {
    if (controller.signal.aborted) return;
    const msg = formatErrorMessage(error);
    host.showError(`Failed to verify API key: ${msg}`);
    if (
      error instanceof OpenPlatformApiError &&
      error.status === 401
    ) {
      host.showStatus(
        'Hint: If your API key was obtained from Kimi Code, please select "Kimi Code" instead.',
      );
    }
    return;
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }

  if (models.length === 0) {
    host.showError('No models available for this platform.');
    return;
  }

  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[platform.id] !== undefined) {
    await host.harness.removeProvider(platform.id);
  }

  const config = await host.harness.getConfig();
  applyOpenPlatformConfig(config as ManagedKimiConfigShape, {
    platform,
    models,
    selectedModel: selection.model,
    thinking: selection.thinking,
    apiKey,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('login', { provider: platform.id, method: 'api_key' });
  host.showStatus(`Setup complete: ${platform.name} · ${selection.model.id}`);
}

export async function handleConnectCommand(host: SlashCommandHost, args: string): Promise<void> {
  const resolution = resolveConnectCatalogRequest(args);
  if (resolution.kind === 'error') {
    host.showError(resolution.message);
    return;
  }
  const { url, preferBuiltIn, allowBuiltInFallback } = resolution.request;

  let catalog: Catalog | undefined;

  if (preferBuiltIn) {
    const builtIn = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
    if (builtIn !== undefined) {
      host.showStatus('Loaded built-in catalog. Run /connect refresh for the latest.');
      catalog = builtIn;
    }
  }

  if (catalog === undefined) {
    const controller = new AbortController();
    const cancel = (): void => {
      controller.abort();
    };
    host.cancelInFlight = cancel;

    const spinner = host.showLoginProgressSpinner(`Fetching catalog from ${url}`);
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
          host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
        } else {
          const fallback = loadBuiltInCatalog(BUILT_IN_CATALOG_JSON);
          if (fallback !== undefined) {
            spinner.stop({ ok: true, label: 'Using built-in catalog (offline mode).' });
            catalog = fallback;
          } else {
            spinner.stop({ ok: false, label: 'Failed to load catalog.' });
            host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
          }
        }
      }
    } finally {
      if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
    }
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(`Provider "${providerId}" has no usable models in this catalog.`);
    return;
  }

  const selection = await promptModelSelectionForCatalog(host, providerId, models);
  if (selection === undefined) return;

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  const wire = inferWireType(entry);
  if (wire === undefined) return;
  const baseUrl = catalogBaseUrl(entry, wire);

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: selection.model.id,
    thinking: selection.thinking,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('connect', { provider: providerId, model: selection.model.id });
  host.showStatus(`Connected: ${entry.name ?? providerId} · ${selection.model.id}`);
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const oauthStatus = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const hasOAuthToken = oauthStatus.providers.some(
    (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
  );
  const config = await host.harness.getConfig();
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
    host.showStatus('Nothing to logout.');
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(host, options, currentProvider);
  if (target === undefined) return;

  if (target === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
  } else {
    await host.harness.removeProvider(target);
  }

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }

  host.track('logout', { provider: target });
  const label = target === DEFAULT_OAUTH_PROVIDER_NAME ? PRODUCT_NAME : target;
  host.showStatus(`Logged out from ${label}.`);
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
    new ModelSelectorComponent({
      models: host.state.appState.availableModels,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinking: host.state.appState.thinking,
      colors: host.state.theme.colors,
      searchable: true,
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
  if (host.state.appState.isStreaming) {
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
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(`Permission mode unchanged: ${mode}.`);
    return;
  }

  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set permission mode: ${msg}`);
    return;
  }

  host.setAppState({ permissionMode: mode, yolo: mode === 'yolo' });
  host.showNotice(`Permission mode: ${mode}`);
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
    case 'theme': showThemePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}

// ---------------------------------------------------------------------------
// Info commands
// ---------------------------------------------------------------------------

interface SessionUsageResult {
  readonly usage?: SessionUsage;
  readonly error?: string;
}

interface RuntimeStatusResult {
  readonly status?: SessionStatus;
  readonly error?: string;
}

interface ManagedUsageResult {
  readonly usage?: ManagedUsageReport;
  readonly error?: string;
}

export async function showUsage(host: SlashCommandHost): Promise<void> {
  const sessionUsage = await loadSessionUsageReport(host);
  const managedUsage = await loadManagedUsageReport(host);
  const lines = buildUsageReportLines({
    colors: host.state.theme.colors,
    sessionUsage: sessionUsage.usage,
    sessionUsageError: sessionUsage.error,
    contextUsage: host.state.appState.contextUsage,
    contextTokens: host.state.appState.contextTokens,
    maxContextTokens: host.state.appState.maxContextTokens,
    managedUsage: managedUsage?.usage,
    managedUsageError: managedUsage?.error,
  });
  const panel = new UsagePanelComponent(lines, host.state.theme.colors.primary);
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function showStatusReport(host: SlashCommandHost): Promise<void> {
  const [runtimeStatus, managedUsage] = await Promise.all([
    loadRuntimeStatusReport(host),
    loadManagedUsageReport(host),
  ]);
  const appState = host.state.appState;
  const lines = buildStatusReportLines({
    colors: host.state.theme.colors,
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
  const panel = new UsagePanelComponent(lines, host.state.theme.colors.primary, ' Status ');
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

export async function showMcpServers(host: SlashCommandHost): Promise<void> {
  let servers: readonly McpServerInfo[];
  try {
    servers = await host.requireSession().listMcpServers();
  } catch (error) {
    host.showError(`Failed to load MCP servers: ${formatErrorMessage(error)}`);
    return;
  }

  const lines = buildMcpStatusReportLines({
    colors: host.state.theme.colors,
    servers,
  });
  const title = servers.length > 0 ? ` MCP (${servers.length}) ` : ' MCP ';
  const panel = new UsagePanelComponent(lines, host.state.theme.colors.primary, title);
  host.state.transcriptContainer.addChild(panel);
  host.state.ui.requestRender();
}

async function loadSessionUsageReport(host: SlashCommandHost): Promise<SessionUsageResult> {
  try {
    return { usage: await host.requireSession().getUsage() };
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
}

async function loadRuntimeStatusReport(host: SlashCommandHost): Promise<RuntimeStatusResult> {
  try {
    return { status: await host.requireSession().getStatus() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadManagedUsageReport(host: SlashCommandHost): Promise<ManagedUsageResult | undefined> {
  const alias = host.state.appState.model;
  const providerKey = host.state.appState.availableModels[alias]?.provider;
  if (!isManagedUsageProvider(providerKey)) return undefined;

  let res;
  try {
    res = await host.harness.auth.getManagedUsage(providerKey);
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
  if (res.kind === 'error') {
    return { error: res.message };
  }
  return { usage: { summary: res.summary, limits: res.limits } };
}

