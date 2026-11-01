import {
  ErrorCodes,
  PRIMARY_SUBAGENT_MODEL_CHOICE,
  type ExperimentalFeatureState,
  type ModelAlias,
  type PermissionMode,
  type Session,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { EffortSelectorComponent } from '../components/dialogs/effort-selector';
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '../components/dialogs/experiments-selector';
import { MermaidPreferenceSelectorComponent } from '../components/dialogs/mermaid-preference-selector';
import { modelDisplayName, segmentsFor } from '../components/dialogs/model-selector';
import { ModelSwitchConfirmDialogComponent } from '../components/dialogs/model-switch-confirm-dialog';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import { SurveyPreferenceSelectorComponent } from '../components/dialogs/survey-preference-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { TuiModeSelectorComponent } from '../components/dialogs/tui-mode-selector';
import { UpdatePreferenceSelectorComponent } from '../components/dialogs/update-preference-selector';
import { DEFAULT_MARKDOWN_CONFIG, DEFAULT_TUI_CONFIG, saveTuiConfig, type MarkdownConfig, type TuiConfig, type TuiMode } from '../config';
import type { ThemeName } from '#/tui/theme';
import { currentTheme, isBuiltInTheme, lightColors, loadCustomThemeMerged } from '#/tui/theme';
import {
  matchModelSwitchRule,
  needsModelSwitchConfirmConfigRefresh,
  peekModelSwitchConfirmConfig,
  refreshModelSwitchConfirmConfig,
  resolveModelSwitchHint,
  resolveModelSwitchWarning,
  type ModelSwitchAction,
  type ModelSwitchRule,
} from '#/utils/model-switch-confirm-config';
import {
  matchEffortSwitchRule,
  needsEffortSwitchConfigRefresh,
  peekEffortSwitchConfig,
  refreshEffortSwitchConfig,
  type EffortSwitchRule,
} from '#/utils/effort-switch-config';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { NO_ACTIVE_SESSION_MESSAGE, TUI_MODE_RESTART_NOTICE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { setMarkdownMermaidMode, type MermaidRenderMode } from '../utils/markdown-options';
import {
  effectiveModelForHost,
  hasConversationHistory,
  MODEL_SWITCH_CACHE_WARNING,
  performModelSwitch,
  type ModelSwitchPersistence,
} from '../utils/model-switch';
import { PERMISSION_MODE_DESCRIPTIONS, PERMISSION_MODE_DISPLAY_NAMES } from '../utils/permission-mode';
import { showUsage } from './info';
import { setExperimentalFeatures } from './experimental-flags';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

const MODEL_PICKER_REFRESH_TIMEOUT_MS = 2_000;

const MODEL_SWITCH_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;

const EFFORT_SWITCH_CACHE_WARNING =
  'Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.';

export function currentTuiConfig(host: Pick<SlashCommandHost, 'state'>): TuiConfig {
  return {
    theme: host.state.appState.theme,
    tuiMode: host.state.appState.tuiMode,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst: host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    renderLatex: host.state.appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true,
    cacheExpiryHint: host.state.appState.cacheExpiryHint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    autoSessionTitle: host.state.appState.autoSessionTitle ?? DEFAULT_TUI_CONFIG.autoSessionTitle,
    notifications: host.state.appState.notifications,
    upgrade: host.state.appState.upgrade,
    statusLine: host.state.appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
    markdown: host.state.appState.markdown ?? DEFAULT_MARKDOWN_CONFIG,
  };
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

  // The session may already be in the requested mode (e.g. it was created
  // with config.defaultPlanMode applied), and re-entering plan mode throws.
  if (host.state.appState.planMode === enabled) {
    host.showNotice(`Plan mode is already ${enabled ? 'on' : 'off'}`);
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

export async function handleCompactCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const customInstruction = args.trim() || undefined;
  try {
    await session.compact({ instruction: customInstruction });
  } catch (error) {
    const message = formatErrorMessage(error);
    host.setAppState({ isCompacting: false });
    host.failSessionRequest(message);
  }
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
  if (!isBuiltInTheme(theme)) {
    const custom = await loadCustomThemeMerged(theme);
    if (custom === null) {
      host.showError(`Unknown theme: ${theme}`);
      return;
    }
  }
  await applyThemeChoice(host, theme);
}

export async function handleModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  if (alias.length === 0) {
    await showModelPicker(host);
    return;
  }
  if (host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  await showModelPicker(host, alias);
}

export async function handleSecondaryModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
  // The pool reserves `primary` for Tower spawn's symbolic "tower's own model"
  // choice — a user alias with that name can never be the subagent default.
  delete models[PRIMARY_SUBAGENT_MODEL_CHOICE];
  if (alias === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    host.showError(
      `"${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved by the subagent model pool — rename the [models] alias to use it here.`,
    );
    return;
  }
  if (Object.keys(models).length === 0) {
    host.showNotice(
      'No models configured',
      'Run /login to sign in to Kimi, or /provider to add another provider from a model catalog.',
    );
    return;
  }
  if (alias.length > 0 && models[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  const secondary = (await host.harness.getConfig()).secondaryModel;
  // The v2 engine honors a lone legacy `model` key as the fallback pool
  // default — reflect it as the picker's current value.
  const current = secondary?.defaultModel ?? secondary?.model ?? '';
  showSecondaryModelPicker(host, models, current, alias.length > 0 ? alias : undefined);
}

export async function handleEffortCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (model === undefined) {
    host.showError('No model selected. Run /model to select one first.');
    return;
  }
  const effective = effectiveModelForHost(host, model);
  const segments = segmentsFor(effective);
  const arg = args.trim().toLowerCase();
  if (arg.length === 0) {
    if (model.provider === DEFAULT_OAUTH_PROVIDER_NAME) await ensureEffortSwitchConfig(host);
    showEffortPicker(host, effective, segments);
    return;
  }
  if (!segments.includes(arg)) {
    const providerType = host.state.appState.availableProviders[effective.provider]?.type;
    const protocol = effective.protocol ?? providerType;
    if (protocol !== 'anthropic') {
      host.showError(
        `Unsupported thinking effort "${arg}" for ${alias}. Available: ${segments.join(', ')}`,
      );
      return;
    }
    const knownEfforts = effective.supportEfforts?.join(', ') ?? 'none declared';
    host.showStatus(
      `Thinking effort "${arg}" is not listed for ${alias} (known: ${knownEfforts}). Sending "${arg}" unchanged; the configured provider will validate it.`,
      'warning',
    );
  }
  await confirmThenPerformEffortSwitch(host, arg, 'model');
}

function showEffortPicker(
  host: SlashCommandHost,
  model: ModelAlias,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort) ? liveEffort : (segments[0] ?? 'off');
  host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      warning: hasConversationHistory(host) ? EFFORT_SWITCH_CACHE_WARNING : undefined,
      descriptions: model.provider === DEFAULT_OAUTH_PROVIDER_NAME ? effortDescriptions() : undefined,
      onSelect: (effort) => {
        host.restoreEditor();
        void confirmThenPerformEffortSwitch(host, effort, 'model');
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor();
        void confirmThenPerformEffortSwitch(host, effort, 'session');
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function confirmThenPerformEffortSwitch(
  host: SlashCommandHost,
  thinking: ThinkingEffort,
  persist: ModelSwitchPersistence,
): Promise<void> {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (
    model?.provider !== DEFAULT_OAUTH_PROVIDER_NAME ||
    thinking === host.state.appState.thinkingEffort ||
    host.state.appState.streamingPhase !== 'idle'
  ) {
    await performModelSwitch(host, alias, thinking, persist);
    return;
  }
  await ensureEffortSwitchConfig(host);
  if (matchedEffortSwitchRule(host, thinking) === undefined) {
    await performModelSwitch(host, alias, thinking, persist);
    return;
  }
  confirmThenPerformModelSwitch(host, alias, thinking, persist);
}

function effortDescriptions(): Record<string, string> | undefined {
  const config = peekEffortSwitchConfig();
  if (config?.descriptions?.enable !== true) return undefined;
  const descriptions: Record<string, string> = {};
  for (const [effort, localized] of Object.entries(config.descriptions.items ?? {})) {
    if (localized.en !== undefined) descriptions[effort] = localized.en;
  }
  return descriptions;
}

async function ensureEffortSwitchConfig(host: SlashCommandHost): Promise<void> {
  if (!needsEffortSwitchConfigRefresh()) return;
  try {
    await refreshEffortSwitchConfig({ accessToken: await host.harness.auth.getCachedAccessToken() });
  } catch {}
}

// ---------------------------------------------------------------------------
// Pickers & config apply
// ---------------------------------------------------------------------------

function showEditorPicker(host: SlashCommandHost): void {
  const currentValue = host.state.appState.editorCommand ?? '';
  host.mountEditorReplacement(
    new EditorSelectorComponent({
      currentValue,
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

async function refreshModelsForPicker(host: SlashCommandHost): Promise<void> {
  try {
    const result = await withTimeout(
      host.authFlow.refreshOAuthProviderModels(),
      MODEL_PICKER_REFRESH_TIMEOUT_MS,
    );
    if (result === undefined) return;
    for (const f of result.failed) {
      host.showStatus(`Skipped refreshing ${f.provider}: ${f.reason}`, 'warning');
    }
  } catch (error) {
    host.showStatus(`Skipped refreshing models: ${formatErrorMessage(error)}`, 'warning');
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
      ...currentTuiConfig(host),
      editorCommand,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save editor: ${formatErrorMessage(error)}`,
      'error',
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

/**
 * The models a picker may offer: the user's configured aliases with
 * host-effective provider resolution applied.
 */
function pickerModelsForHost(host: SlashCommandHost): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(host.state.appState.availableModels).map(([alias, model]) => [
      alias,
      effectiveModelForHost(host, model),
    ]),
  );
}

export async function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): Promise<void> {
  if (needsModelSwitchConfirmConfigRefresh() || needsEffortSwitchConfigRefresh()) {
    try {
      const accessToken = await host.harness.auth.getCachedAccessToken();
      const readiness: Promise<unknown>[] = [];
      if (needsModelSwitchConfirmConfigRefresh()) {
        readiness.push(refreshModelSwitchConfirmConfig({ accessToken }));
      }
      if (needsEffortSwitchConfigRefresh()) readiness.push(refreshEffortSwitchConfig({ accessToken }));
      await Promise.all(readiness);
    } catch {}
  }
  const models = pickerModelsForHost(host);
  const entries = Object.entries(models);
  if (entries.length === 0) {
    host.showNotice(
      'No models configured',
      'Run /login to sign in to Kimi, or /provider to add another provider from a model catalog.',
    );
    return;
  }
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue: host.state.appState.model,
      selectedValue,
      currentThinkingEffort: host.state.appState.thinkingEffort,
      warning: hasConversationHistory(host) ? MODEL_SWITCH_CACHE_WARNING : undefined,
      effortDescriptions: effortDescriptions(),
      onSelect: ({ alias, thinking }) => {
        host.restoreEditor();
        confirmThenPerformModelSwitch(host, alias, thinking, 'model');
      },
      onSessionOnlySelect: ({ alias, thinking }) => {
        host.restoreEditor();
        confirmThenPerformModelSwitch(host, alias, thinking, 'session');
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

/**
 * Cloud-gated confirmation for a model or effort switch. Model changes ignore
 * effort rules; pure effort changes use the effort config and offer only
 * confirm/cancel in either session type.
 */
export function confirmThenPerformModelSwitch(
  host: SlashCommandHost,
  alias: string,
  thinking: ThinkingEffort,
  persist: ModelSwitchPersistence,
): void {
  const effortOnly = alias === host.state.appState.model && thinking !== host.state.appState.thinkingEffort;
  const rule = effortOnly ? matchedEffortSwitchRule(host, thinking) : matchedModelSwitchRule(host, alias);
  if (rule === undefined) {
    void performModelSwitch(host, alias, thinking, persist);
    return;
  }
  const availableModels = host.state.appState.availableModels;
  const fromModel = effortOnly
    ? host.state.appState.thinkingEffort
    : modelDisplayName(host.state.appState.model, availableModels[host.state.appState.model]);
  const toModel = effortOnly ? thinking : modelDisplayName(alias, availableModels[alias]);
  const sessionType = hasConversationHistory(host) ? 'old' : 'new';
  const dismiss = (): void => {
    // Only close while this dialog still owns the editor replacement: an
    // approval/question panel mounted over it must never be wiped out by the
    // async finalizer of a settled action.
    if (host.state.activeDialog !== 'model-switch-confirm') return;
    host.state.activeDialog = null;
    host.restoreEditor();
  };
  let settled = false;
  host.mountEditorReplacement(
    new ModelSwitchConfirmDialogComponent({
      fromModel,
      toModel,
      sessionType,
      kind: effortOnly ? 'effort' : 'model',
      hint: resolveModelSwitchHint(rule),
      warning: resolveModelSwitchWarning(rule),
      onSelect: (action) => {
        if (settled) return;
        settled = true;
        dismiss();
        void runModelSwitchAction(host, action, alias, thinking, persist);
      },
      onCancel: () => {
        if (settled) return;
        settled = true;
        dismiss();
      },
    }),
  );
  host.state.activeDialog = 'model-switch-confirm';
}

function matchedEffortSwitchRule(host: SlashCommandHost, thinking: ThinkingEffort): EffortSwitchRule | undefined {
  const previous = host.state.appState.thinkingEffort;
  const model = host.state.appState.availableModels[host.state.appState.model];
  if (model?.provider !== DEFAULT_OAUTH_PROVIDER_NAME) return undefined;
  if (thinking === previous || host.state.appState.streamingPhase !== 'idle') return undefined;
  return matchEffortSwitchRule(
    peekEffortSwitchConfig(),
    previous,
    thinking,
    hasConversationHistory(host) ? 'old' : 'new',
  );
}

export function matchedModelSwitchRule(host: SlashCommandHost, alias: string): ModelSwitchRule | undefined {
  const prevAlias = host.state.appState.model;
  // Same-alias effort changes use matchedEffortSwitchRule instead. Streaming
  // switches keep the existing error path without a preceding dialog.
  if (alias === prevAlias) return undefined;
  if (host.state.appState.streamingPhase !== 'idle') return undefined;
  const fromModelId = host.state.appState.availableModels[prevAlias]?.model;
  const toModelId = host.state.appState.availableModels[alias]?.model;
  if (fromModelId === undefined || toModelId === undefined) return undefined;
  return matchModelSwitchRule(
    peekModelSwitchConfirmConfig(),
    fromModelId,
    toModelId,
    hasConversationHistory(host) ? 'old' : 'new',
  );
}

/**
 * Fire a compaction and wait for it to settle before the model switch. The
 * compact RPC resolves as soon as the engine *starts* compacting — the
 * completed/cancelled/failed outcome arrives later as an event — and
 * performModelSwitch rejects any switch while the session is busy, so the
 * switch must hold until one of those events lands. True only when the
 * compaction completed on the same session; any other outcome shows a
 * message and leaves the model unchanged.
 */
export async function compactForModelSwitch(
  host: SlashCommandHost,
  session: Session,
): Promise<boolean> {
  type CompactionSettle = 'completed' | 'cancelled' | 'failed' | 'timeout';
  let settle: (outcome: CompactionSettle) => void = () => undefined;
  const settled = new Promise<CompactionSettle>((resolve) => {
    settle = resolve;
  });
  const unsubscribe = session.onEvent((event) => {
    if (event.type === 'compaction.completed') settle('completed');
    else if (event.type === 'compaction.cancelled') settle('cancelled');
    else if (event.type === 'error' && event.code === ErrorCodes.COMPACTION_FAILED) {
      settle('failed');
    }
  });
  const timer = setTimeout(() => {
    settle('timeout');
  }, MODEL_SWITCH_COMPACT_TIMEOUT_MS);
  try {
    await session.compact({});
    const outcome = await settled;
    if (outcome === 'completed' && host.session === session) return true;
    if (outcome === 'completed') {
      host.showNotice('Model switch aborted — session changed.');
    } else if (outcome === 'timeout') {
      host.showError('Timed out waiting for compaction — model unchanged.');
    } else if (outcome === 'cancelled') {
      host.showNotice('Compaction cancelled — model unchanged.');
    } else {
      host.showNotice('Model switch aborted — model unchanged.');
    }
    return false;
  } catch (error) {
    host.showError(`Failed to compact: ${formatErrorMessage(error)}. Model unchanged.`);
    return false;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

async function runModelSwitchAction(
  host: SlashCommandHost,
  action: ModelSwitchAction,
  alias: string,
  thinking: ThinkingEffort,
  persist: ModelSwitchPersistence,
): Promise<void> {
  switch (action) {
    case 'cancel':
      return;
    case 'continue':
      await performModelSwitch(host, alias, thinking, persist);
      return;
    case 'compact': {
      // Compact with the current model first, then switch: the new model
      // starts from the compacted context.
      if (host.session !== undefined && !(await compactForModelSwitch(host, host.session))) {
        return;
      }
      await performModelSwitch(host, alias, thinking, persist);
      return;
    }
  }
}


// ---------------------------------------------------------------------------
// Secondary model (`/secondary-model`) — persists `[secondary_model] default_model`
// ---------------------------------------------------------------------------

function showSecondaryModelPicker(
  host: SlashCommandHost,
  models: Record<string, ModelAlias>,
  currentValue: string,
  selectedValue?: string,
): void {
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue,
      selectedValue,
      currentThinkingEffort: 'off',
      // Subagent pool bindings carry no explicit thinking level, so the picker
      // hides the Thinking footer instead of offering a no-op choice.
      thinkingControl: false,
      title: ' Select a secondary model (subagents)',
      onSelect: ({ alias }) => {
        host.restoreEditor();
        void performSecondaryModelSave(host, alias);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

/**
 * Persists `[secondary_model] default_model`. When a
 * `[secondary_model.models]` pool exists and does not list the alias yet, the
 * alias is added with an empty description — the engine requires the default
 * to be a pool key. Without a pool the default alone forms an implicit
 * single-entry pool, so nothing else is written. No live-apply step: the
 * engine resolves the pool per spawn, so the next subagent dispatch picks the
 * new value up on its own.
 */
async function performSecondaryModelSave(host: SlashCommandHost, alias: string): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    const config = await host.harness.getConfig({ reload: true });
    const existing = config.secondaryModel?.models;
    const patch: { defaultModel: string; models?: Record<string, string> } = {
      defaultModel: alias,
    };
    if (existing !== undefined) {
      patch.models = { ...existing, [alias]: existing[alias] ?? '' };
    }
    await host.harness.setConfig({ secondaryModel: patch });
  } catch (error) {
    host.showError(`Failed to save secondary model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Secondary model set to ${displayName}. Newly spawned subagents will use it by default.`,
    'success',
  );
}

function showThemePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new ThemeSelectorComponent({
      currentValue: host.state.appState.theme,
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

async function applyThemeChoice(host: SlashCommandHost, theme: ThemeName): Promise<void> {
  if (theme === host.state.appState.theme) {
    if (theme === 'auto') host.refreshTerminalThemeTracking();
    host.showStatus(`Theme unchanged: "${theme}".`);
    return;
  }

  // Validate custom themes up front so a missing / malformed file reports an
  // error instead of silently persisting a name that resolves to the dark
  // fallback.
  if (!isBuiltInTheme(theme)) {
    const palette = await loadCustomThemeMerged(theme);
    if (palette === null) {
      host.showStatus(`Theme "${theme}" could not be loaded.`, 'error');
      return;
    }
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host),
      theme,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save theme: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  const resolved = theme === 'auto'
    ? (currentTheme.palette === lightColors ? 'light' : 'dark')
    : undefined;
  await host.applyTheme(theme, resolved);
  host.refreshTerminalThemeTracking();
  host.track('theme_switch', { theme });
  const detail = theme === 'auto' ? ` (tracking terminal; current: ${resolved})` : '';
  host.showStatus(`Theme set to "${theme}"${detail}.`);
}

export function showPermissionPicker(host: SlashCommandHost, initialMode?: PermissionMode): void {
  host.mountEditorReplacement(
    new PermissionSelectorComponent({
      currentValue: host.state.appState.permissionMode,
      initialValue: initialMode,
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

export function showUpdatePreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new UpdatePreferenceSelectorComponent({
      currentValue: host.state.appState.upgrade.autoInstall,
      onSelect: (value) => {
        host.restoreEditor();
        void applyUpdatePreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

export async function showExperimentsPanel(host: SlashCommandHost): Promise<void> {
  let features: readonly ExperimentalFeatureState[];
  try {
    features = await host.harness.getExperimentalFeatures();
  } catch (error) {
    host.showError(`Failed to load experimental features: ${formatErrorMessage(error)}`);
    return;
  }
  mountExperimentsPanel(host, features);
}

export async function applyExperimentalFeatureChanges(
  host: SlashCommandHost,
  changes: readonly ExperimentalFeatureDraftChange[],
): Promise<void> {
  if (changes.length === 0) {
    host.showStatus(
      'No experimental feature changes to apply.',
      'textMuted',
    );
    return;
  }

  const experimental: Record<string, boolean> = {};
  for (const change of changes) {
    experimental[change.id] = change.enabled;
  }

  try {
    await host.harness.setConfig({ experimental });
    const features = await host.harness.getExperimentalFeatures();
    setExperimentalFeatures(features);
    host.refreshSlashCommandAutocomplete();
    host.restoreEditor();
    if (host.session !== undefined && changes.some((change) => change.id !== 'notify_user')) {
      const reloadedSession = await host.harness.reloadSession({ id: host.session.id });
      await host.reloadCurrentSessionView(
        reloadedSession,
        'Experimental features updated. Session reloaded.',
      );
    } else {
      host.showStatus('Experimental features updated.', 'success');
    }
    if (
      host.session !== undefined &&
      changes.some((change) => change.id === 'notify_user' && change.enabled)
    ) {
      host.showNotice(
        'Start a new session to use Updates if this session was created with the feature disabled.',
      );
    }
    if (changes.some((change) => change.id === 'tower')) {
      // TowerFeature assembles its tool/profile contributions once at App
      // scope construction, so a live flag flip cannot install or retract
      // them; only the mode machinery (enter/injection/guards) reacts live.
      host.showNotice('Tower mode takes effect after restarting Kimi Code.');
    }
    host.track('experimental_features_apply', {
      changed: changes.length,
      flags: features
        .filter((feature) => feature.enabled)
        .map((feature) => feature.id)
        .toSorted()
        .join(','),
    });
  } catch (error) {
    host.showError(`Failed to update experimental features: ${formatErrorMessage(error)}`);
  }
}

function mountExperimentsPanel(
  host: SlashCommandHost,
  features: readonly ExperimentalFeatureState[],
): void {
  host.mountEditorReplacement(
    new ExperimentsSelectorComponent({
      features,
      onApply: (changes) => {
        void applyExperimentalFeatureChanges(host, changes);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type UpdatePreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade'
    >;
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'upgrade'>): void;
  showStatus(msg: string, color?: string): void;
  track: SlashCommandHost['track'];
};

export async function applyUpdatePreferenceChoice(
  host: UpdatePreferenceHost,
  autoInstall: boolean,
): Promise<void> {
  if (autoInstall === host.state.appState.upgrade.autoInstall) {
    host.showStatus(`Automatic updates already ${autoInstall ? 'enabled' : 'disabled'}.`);
    return;
  }

  const upgrade = { autoInstall };
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      upgrade,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save automatic update setting: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  host.setAppState({ upgrade });
  host.track('upgrade_preference_changed', { auto_install: autoInstall });
  host.showStatus(`Automatic updates ${autoInstall ? 'enabled' : 'disabled'}.`);
}

async function applyPermissionChoice(host: SlashCommandHost, mode: PermissionMode): Promise<void> {
  if (mode === host.state.appState.permissionMode) {
    host.showStatus(`Permission mode unchanged: ${PERMISSION_MODE_DISPLAY_NAMES[mode]}.`);
    return;
  }

  try {
    if (host.session !== undefined) {
      await host.session.setPermission(mode);
    }
    // v2 session-less: the chosen mode is recorded in appState and passed to
    // the lazy-created session.
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to set permission mode: ${msg}`);
    return;
  }

  host.setAppState({ permissionMode: mode });
  host.showNotice(`Permission mode: ${PERMISSION_MODE_DISPLAY_NAMES[mode]}`);
  if (mode !== 'manual') {
    host.showStatus(PERMISSION_MODE_DESCRIPTIONS[mode], 'warning');
  }
}

export function showSurveyPreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SurveyPreferenceSelectorComponent({
      currentValue: host.state.appState.disableFeedbackSurvey !== true,
      onSelect: (value) => {
        host.restoreEditor();
        void applySurveyPreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type SurveyPreferenceHost = {
  readonly state: {
    readonly appState: Pick<SlashCommandHost['state']['appState'], 'disableFeedbackSurvey'>;
  };
  readonly harness: {
    setConfig(patch: { disableFeedbackSurvey: boolean }): Promise<unknown>;
  };
  setAppState(
    patch: Pick<SlashCommandHost['state']['appState'], 'disableFeedbackSurvey'>,
  ): void;
  showStatus(msg: string, color?: string): void;
};

export async function applySurveyPreferenceChoice(
  host: SurveyPreferenceHost,
  enabled: boolean,
): Promise<void> {
  const disableFeedbackSurvey = !enabled;
  if (disableFeedbackSurvey === (host.state.appState.disableFeedbackSurvey === true)) {
    host.showStatus(`Feedback survey already ${enabled ? 'enabled' : 'disabled'}.`);
    return;
  }

  try {
    await host.harness.setConfig({ disableFeedbackSurvey });
  } catch (error) {
    host.showStatus(
      `Failed to save session rating setting: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  host.setAppState({ disableFeedbackSurvey });
  host.showStatus(`Feedback survey ${enabled ? 'enabled' : 'disabled'}.`);
}

export function showMermaidPreferencePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new MermaidPreferenceSelectorComponent({
      currentValue: host.state.appState.markdown?.mermaid !== 'off',
      onSelect: (value) => {
        host.restoreEditor();
        void applyMermaidPreferenceChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type MermaidPreferenceHost = {
  readonly state: {
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade' | 'markdown'
    >;
    readonly transcriptContainer: { invalidate(): void };
    readonly ui: { requestRender(force?: boolean): void };
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'markdown'>): void;
  showStatus(msg: string, color?: string): void;
};

export async function applyMermaidPreferenceChoice(
  host: MermaidPreferenceHost,
  enabled: boolean,
): Promise<void> {
  const mermaid: MermaidRenderMode = enabled ? 'final' : 'off';
  if (mermaid === (host.state.appState.markdown?.mermaid ?? DEFAULT_MARKDOWN_CONFIG.mermaid)) {
    host.showStatus(`Mermaid diagrams already ${enabled ? 'enabled' : 'disabled'}.`);
    return;
  }

  const markdown: MarkdownConfig = { mermaid };
  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      markdown,
    });
  } catch (error) {
    host.showStatus(
      `Failed to save mermaid diagram setting: ${formatErrorMessage(error)}`,
      'error',
    );
    return;
  }

  setMarkdownMermaidMode(mermaid);
  host.setAppState({ markdown });
  host.state.transcriptContainer.invalidate();
  host.state.ui.requestRender(true);
  host.showStatus(`Mermaid diagrams ${enabled ? 'enabled' : 'disabled'}.`);
}

export function showTuiModePicker(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new TuiModeSelectorComponent({
      currentValue: host.state.appState.tuiMode ?? 'regular',
      onSelect: (value) => {
        host.restoreEditor();
        void applyTuiModeChoice(host, value);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

type TuiModeHost = {
  readonly state: {
    readonly appState: Pick<SlashCommandHost['state']['appState'], 'tuiMode'>;
    readonly ui: Pick<SlashCommandHost['state']['ui'], 'mode'>;
  };
  setAppState(patch: Pick<SlashCommandHost['state']['appState'], 'tuiMode'>): void;
  showStatus(msg: string, color?: string): void;
  showNotice(msg: string): void;
};

export async function applyTuiModeChoice(host: TuiModeHost, tuiMode: TuiMode): Promise<void> {
  if (tuiMode === (host.state.appState.tuiMode ?? 'regular')) {
    host.showStatus(`TUI mode already ${tuiMode}.`);
    return;
  }

  try {
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      tuiMode,
    });
  } catch (error) {
    host.showStatus(`Failed to save TUI mode: ${formatErrorMessage(error)}`, 'error');
    return;
  }

  host.setAppState({ tuiMode });
  host.showStatus(`TUI mode set to ${tuiMode}.`, 'success');
  if (tuiMode !== host.state.ui.mode) {
    host.showNotice(TUI_MODE_RESTART_NOTICE);
  }
}

export function showSettingsSelector(host: SlashCommandHost): void {
  host.mountEditorReplacement(
    new SettingsSelectorComponent({
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
    case 'model': void showModelPicker(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'tuiMode': showTuiModePicker(host); return;
    case 'mermaid': showMermaidPreferencePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'survey': showSurveyPreferencePicker(host); return;
    case 'experiments': void showExperimentsPanel(host); return;
    case 'upgrade': showUpdatePreferencePicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}
