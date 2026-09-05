import {
  effectiveModelAlias,
  PRIMARY_SUBAGENT_MODEL_CHOICE,
  SECONDARY_DERIVED_MODEL_ALIAS,
  type ExperimentalFeatureState,
  type ModelAlias,
  type PermissionMode,
  type Session,
  type SessionSummary,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';
import type { SessionModelOverrideKind } from '@moonshot-ai/agent-core-v2/agent/profile/profile';

import { EditorSelectorComponent } from '../components/dialogs/editor-selector';
import { EffortSelectorComponent } from '../components/dialogs/effort-selector';
import {
  ExperimentsSelectorComponent,
  type ExperimentalFeatureDraftChange,
} from '../components/dialogs/experiments-selector';
import { modelDisplayName, defaultThinkingEffortFor, segmentsFor } from '../components/dialogs/model-selector';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { PermissionSelectorComponent } from '../components/dialogs/permission-selector';
import { SettingsSelectorComponent, type SettingsSelection } from '../components/dialogs/settings-selector';
import { SurveyPreferenceSelectorComponent } from '../components/dialogs/survey-preference-selector';
import { ThemeSelectorComponent } from '../components/dialogs/theme-selector';
import { UpdatePreferenceSelectorComponent } from '../components/dialogs/update-preference-selector';
import { ConfirmDialogComponent } from '../components/dialogs/confirm-dialog';
import { DEFAULT_TUI_CONFIG, saveTuiConfig, type TuiConfig } from '../config';
import type { ThemeName } from '#/tui/theme';
import { currentTheme, isBuiltInTheme, lightColors, loadCustomThemeMerged } from '#/tui/theme';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import { PERMISSION_MODE_DESCRIPTIONS, PERMISSION_MODE_DISPLAY_NAMES } from '../utils/permission-mode';
import { thinkingEffortToConfig } from '../utils/thinking-config';
import { showUsage } from './info';
import { setExperimentalFeatures } from './experimental-flags';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Plan / Config commands
// ---------------------------------------------------------------------------

const MODEL_PICKER_REFRESH_TIMEOUT_MS = 2_000;

const MODEL_SWITCH_CACHE_WARNING =
  'Note: Switching models invalidates the existing prompt cache. Use /new to avoid extra token costs.';
const EFFORT_SWITCH_CACHE_WARNING =
  'Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.';

/** True once the conversation has at least one user message: a switch from
 * then on resends the accumulated context, losing the cache. Shell-command
 * echoes are also 'user' transcript entries but carry an empty `bullet`, so
 * they're excluded. */
function hasConversationHistory(host: SlashCommandHost): boolean {
  return host.state.transcriptEntries.some(
    (entry) => entry.kind === 'user' && entry.bullet !== '',
  );
}

export function currentTuiConfig(host: Pick<SlashCommandHost, 'state'>): TuiConfig {
  return {
    theme: host.state.appState.theme,
    editorCommand: host.state.appState.editorCommand,
    disablePasteBurst: host.state.appState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    renderLatex: host.state.appState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true,
    cacheExpiryHint: host.state.appState.cacheExpiryHint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    disableFeedbackSurvey:
      host.state.appState.disableFeedbackSurvey ?? DEFAULT_TUI_CONFIG.disableFeedbackSurvey,
    favoriteModels: [...(host.state.appState.favoriteModels ?? DEFAULT_TUI_CONFIG.favoriteModels ?? [])],
    notifications: host.state.appState.notifications,
    upgrade: host.state.appState.upgrade,
    statusLine: host.state.appState.statusLine ?? DEFAULT_TUI_CONFIG.statusLine,
  };
}

export function effectiveModelForHost(host: SlashCommandHost, model: ModelAlias): ModelAlias {
  const providerType = host.state.appState.availableProviders[model.provider]?.type;
  // Flat models (no named provider, e.g. inline base_url served by a v2
  // backend) have no provider entry to look up; their own protocol declaration
  // plays the provider-identity role, mirroring the resolver.
  return effectiveModelAlias(model, providerType ?? model.protocol);
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
  await session.compact({ instruction: customInstruction });
}

/** Accepted range for `/compact-threshold`; the engine re-validates authoritatively. */
const COMPACT_THRESHOLD_MIN = 0.05;
const COMPACT_THRESHOLD_MAX = 0.99;
/** Built-in auto-compaction trigger ratio used when neither override nor config sets one. */
const COMPACT_THRESHOLD_DEFAULT = 0.85;
const COMPACT_THRESHOLD_USAGE =
  'Usage: /compact-threshold [<ratio 0.05-0.99>|off] — with no argument, shows the current value.';
/** Built-in default compaction token budget used when neither override nor config sets one. */
const COMPACT_TOKEN_BUDGET_DEFAULT = 850_000;
const COMPACT_THRESHOLD_K_USAGE =
  'Usage: /compact-threshold-k [<tokens in 1000s>|off] — with no argument, shows the current value.';

export async function handleCompactThresholdCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const value = args.trim();

  // No argument: read-only display of the effective threshold and its source.
  if (value.length === 0) {
    try {
      const status = await session.getStatus();
      const effective = status.compactionTriggerRatio;
      const source =
        status.compactionTriggerRatioOverridden === true
          ? 'session override — /compact-threshold off clears it'
          : effective !== undefined
            ? 'from config.toml [loop_control] compaction_trigger_ratio'
            : 'built-in default (config.toml key not set)';
      host.showNotice(`Auto-compact threshold: ${effective ?? COMPACT_THRESHOLD_DEFAULT}`, source);
    } catch (error) {
      host.showError(`Failed to read compaction threshold: ${formatErrorMessage(error)}`);
    }
    return;
  }

  // "off" clears the session override and returns to the global value.
  if (value === 'off' || value === 'reset' || value === 'clear') {
    try {
      await session.setCompactionTriggerRatio(undefined);
      host.showNotice(
        'Auto-compact threshold override cleared',
        'The config.toml [loop_control] compaction_trigger_ratio value (or built-in default) applies again.',
      );
    } catch (error) {
      host.showError(`Failed to clear compaction threshold: ${formatErrorMessage(error)}`);
    }
    return;
  }

  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < COMPACT_THRESHOLD_MIN || ratio > COMPACT_THRESHOLD_MAX) {
    host.showError(
      `Invalid threshold "${value}": must be between ${COMPACT_THRESHOLD_MIN} and ${COMPACT_THRESHOLD_MAX}.`,
    );
    host.showStatus(COMPACT_THRESHOLD_USAGE);
    return;
  }

  try {
    await session.setCompactionTriggerRatio(ratio);
    host.showNotice(
      `Auto-compact threshold set to ${ratio} for this session`,
      'Overrides config.toml [loop_control] compaction_trigger_ratio until the session ends.',
    );
  } catch (error) {
    host.showError(`Failed to set compaction threshold: ${formatErrorMessage(error)}`);
  }
}

export async function handleCompactThresholdKCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const value = args.trim();

  if (value.length === 0) {
    try {
      const status = await session.getStatus();
      const effective = status.compactionTokenBudget;
      const source =
        status.compactionTokenBudgetOverridden === true
          ? 'session override — /compact-threshold-k off clears it'
          : effective !== undefined
            ? 'from config.toml [loop_control] compaction_token_budget'
            : 'built-in default (config.toml key not set)';
      host.showNotice(
        `Auto-compact token budget: ${effective ?? COMPACT_TOKEN_BUDGET_DEFAULT}`,
        source,
      );
    } catch (error) {
      host.showError(`Failed to read compaction token budget: ${formatErrorMessage(error)}`);
    }
    return;
  }

  if (value === 'off' || value === 'reset' || value === 'clear') {
    try {
      await session.setCompactionTokenBudget(undefined);
      host.showNotice(
        'Auto-compact token budget override cleared',
        'The config.toml [loop_control] compaction_token_budget value (or built-in default) applies again.',
      );
    } catch (error) {
      host.showError(`Failed to clear compaction token budget: ${formatErrorMessage(error)}`);
    }
    return;
  }

  if (!/^[1-9][0-9]*$/.test(value)) {
    host.showError(
      `Invalid token budget "${value}": must be a positive integer (in thousands).`,
    );
    host.showStatus(COMPACT_THRESHOLD_K_USAGE);
    return;
  }

  const thousands = Number(value);
  try {
    await session.setCompactionTokenBudget(thousands);
    host.showNotice(
      `Auto-compact token budget set to ${thousands * 1_000} for this session`,
      'Absolute cap overrides the ratio path until the session ends.',
    );
  } catch (error) {
    host.showError(`Failed to set compaction token budget: ${formatErrorMessage(error)}`);
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
// Bulk session model switch (`/update-all-session-models`)
// ---------------------------------------------------------------------------

type BulkSessionOutcome =
  | { readonly id: string; readonly status: 'succeeded' }
  | { readonly id: string; readonly status: 'skipped'; readonly reason: string }
  | { readonly id: string; readonly status: 'failed'; readonly reason: string };

/**
 * Enumerate the active sessions the bulk switch will target: the non-archived
 * sessions the harness manages, plus the current session (which listSessions may
 * or may not include). Archived/closed sessions are excluded by the listing, so
 * they are never touched (FR-008); the current session is always in scope
 * (FR-003).
 */
function activeSessionsForBulk(host: SlashCommandHost, listed: readonly SessionSummary[]): SessionSummary[] {
  const current = host.session;
  if (current === undefined) return [...listed];
  const ids = new Set(listed.map((s) => s.id));
  if (ids.has(current.id)) return [...listed];
  // A session the listing does not know yet (e.g. freshly created, nothing
  // persisted) is still switched: synthesize a summary. `workDir` is normally
  // a non-empty string, but fall back to the session id so a missing/empty
  // value can never leak `undefined`/blank fields into downstream handling.
  const dir = current.workDir && current.workDir.length > 0 ? current.workDir : current.id;
  return [
    ...listed,
    {
      id: current.id,
      workDir: dir,
      sessionDir: dir,
      createdAt: 0,
      updatedAt: 0,
      title: 'Current session',
      archived: false,
    },
  ];
}

/** A setModel rejection is a "skip" when the model itself can't be applied to
 * that session (unavailable/invalid); anything else is a hard "failure". */
function classifyModelError(error: unknown): 'skipped' | 'failed' {
  const message = formatErrorMessage(error).toLowerCase();
  const modelProblem =
    message.includes('model') &&
    (message.includes('not found') ||
      message.includes('unknown') ||
      message.includes('invalid') ||
      message.includes('unavailable') ||
      message.includes('unsupported'));
  return modelProblem ? 'skipped' : 'failed';
}

export async function handleUpdateAllSessionModelsCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  if (alias.length > 0 && host.state.appState.availableModels[alias] === undefined) {
    host.showError(`Unknown model alias: ${alias}`);
    return;
  }
  const listed = await host.harness.listSessions();
  const sessions = activeSessionsForBulk(host, listed);
  if (sessions.length === 0) {
    host.showNotice(
      'No active sessions',
      'There are no active sessions to update. Start or resume a session, then try again.',
    );
    return;
  }
  showBulkModelPicker(host, alias, sessions);
}

function showBulkModelPicker(
  host: SlashCommandHost,
  selectedValue: string,
  sessions: readonly SessionSummary[],
): void {
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
      onSelect: ({ alias }) => {
        host.restoreEditor();
        showBulkConfirm(host, alias, sessions);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

function showBulkConfirm(host: SlashCommandHost, alias: string, sessions: readonly SessionSummary[]): void {
  const count = sessions.length;
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  host.mountEditorReplacement(
    new ConfirmDialogComponent({
      title: `Update ${count} active session${count === 1 ? '' : 's'} to ${displayName}?`,
      body: [
        `This switches the working model for every active session${
          count === 1 ? '' : ` (${String(count)})`
        }.`,
        'The new-session default model will also be updated.',
        'This cannot be undone per session — choose Cancel to make no changes.',
      ],
      confirmLabel: 'Update all',
      cancelLabel: 'Cancel',
      onResolve: (confirmed) => {
        host.restoreEditor();
        if (!confirmed) {
          host.showStatus('Cancelled — no sessions were changed.', 'textDim');
          return;
        }
        // The apply loop is long-running (resume/setModel per session); the
        // `.catch` is the last line of defense — the CLI's unhandled-rejection
        // handler exits the whole TUI, so nothing may escape this call.
        void applyModelToAllSessions(host, alias, sessions).catch((error) => {
          host.showError(`Failed to update session models: ${formatErrorMessage(error)}`);
        });
      },
    }),
  );
}

async function applyModelToAllSessions(
  host: SlashCommandHost,
  alias: string,
  sessions: readonly SessionSummary[],
): Promise<void> {
  const currentId = host.session?.id;
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  const results: BulkSessionOutcome[] = [];
  const resumedSessions = new Set<string>();

  try {
    for (const summary of sessions) {
      const id = summary.id;
      let session: Session | undefined;
      if (id === currentId) {
        session = host.session;
      } else {
        // `getSession` is a map lookup in practice, but any throw here must
        // not escape the loop: classify the session as failed and keep going.
        try {
          session = host.harness.getSession(id);
        } catch (error) {
          results.push({ id, status: 'failed', reason: formatErrorMessage(error) });
          continue;
        }
        if (session === undefined) {
          try {
            session = await host.harness.resumeSession({ id });
            resumedSessions.add(id);
          } catch (error) {
            results.push({ id, status: 'failed', reason: formatErrorMessage(error) });
            continue;
          }
        }
      }
      if (session === undefined) {
        results.push({ id, status: 'failed', reason: 'session unavailable' });
        continue;
      }
      try {
        await session.setModel(alias);
        results.push({ id, status: 'succeeded' });
      } catch (error) {
        results.push({ id, status: classifyModelError(error), reason: formatErrorMessage(error) });
      }
    }

    // Reflect the chosen model in the footer. It follows the pick for the
    // current session — including a 'skipped' outcome (model-availability
    // classification on the session side; the alias itself came from the
    // picker's available models) — and for session-less startup, where
    // appState.model is the model the yet-to-be-created session will use
    // (/model updates it in that mode too). Only a hard 'failed' outcome
    // keeps the old model displayed so the footer never lies.
    const currentResult =
      currentId === undefined ? undefined : results.find((r) => r.id === currentId);
    if (currentResult?.status !== 'failed') {
      host.setAppState({ model: alias });
    }
    try {
      await host.harness.setConfig({ defaultModel: alias });
    } catch (error) {
      host.showError(`Switched sessions to ${displayName}, but failed to save default: ${formatErrorMessage(error)}`);
    }

    reportBulkResult(host, displayName, results);
  } catch (error) {
    // Nothing in the apply loop may escape as an unhandled rejection — the
    // CLI's unhandled-rejection handler exits the whole TUI (this is the
    // "kimi is thrown back to the terminal" crash). Report and keep running.
    host.showError(`Failed to update session models: ${formatErrorMessage(error)}`);
  } finally {
    for (const id of resumedSessions) {
      const session = host.harness.getSession(id);
      if (session !== undefined) {
        await session.close().catch(() => {});
      }
    }
  }
}

function reportBulkResult(
  host: SlashCommandHost,
  displayName: string,
  results: readonly BulkSessionOutcome[],
): void {
  const succeeded = results.filter((r) => r.status === 'succeeded').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  const parts = [`Updated ${String(succeeded)} session${succeeded === 1 ? '' : 's'} to ${displayName}`];
  if (skipped > 0) parts.push(`${String(skipped)} skipped`);
  if (failed > 0) parts.push(`${String(failed)} failed`);
  const statusColor = succeeded === 0 ? 'error' : (skipped > 0 || failed > 0) ? 'warning' : 'success';
  host.showStatus(`${parts.join(' · ')}.`, statusColor);

  if (skipped > 0 || failed > 0) {
    const lines = results
      .filter((r) => r.status !== 'succeeded')
      .map((r) => `• ${r.id}: ${r.status} — ${r.reason}`);
    host.showNotice('Some sessions were not updated', lines.join('\n'));
  }
}

export async function handleSecondaryModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
  // The pool reserves `primary` as the symbolic "caller's own model" choice —
  // a user alias with that name can never be the subagent default.
  delete models[PRIMARY_SUBAGENT_MODEL_CHOICE];
  if (alias === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    host.showError(
      `"${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved by the subagent model pool (it always binds the caller's own model) — rename the [models] alias to use it here.`,
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

// ---------------------------------------------------------------------------
// Visual model (`/visual-model`) — persists `[visual_model] model` and enables the `visual-model` experiment flag
// ---------------------------------------------------------------------------

function showVisualModelPicker(
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
      thinkingControl: false,
      title: ' Select a visual model (image inspection)',
      onSelect: ({ alias }) => {
        host.restoreEditor();
        void performVisualModelSave(host, alias);
      },
      onSessionOnlySelect: ({ alias }) => {
        host.restoreEditor();
        void applySessionModelOverride(host, 'visual', alias);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

const SESSION_OVERRIDE_LABELS: Record<string, string> = {
  visual: 'Visual model',
  compaction: 'Squeeze model',
  compactionSecondary: 'Secondary squeeze model',
  fallback: 'Fallback model',
  fallbackSecondary: 'Secondary fallback model',
  substitute: 'Substitute model',
  secondary: 'Secondary (subagent) model',
};

async function applySessionModelOverride(
  host: SlashCommandHost,
  kind: SessionModelOverrideKind,
  alias: string,
): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError('No active session for session-only model override.');
    return;
  }
  try {
    await session.setSessionModelOverride(kind, alias);
  } catch (error) {
    host.showError(`Failed to apply session-only override: ${formatErrorMessage(error)}`);
    return;
  }
  const label = SESSION_OVERRIDE_LABELS[kind] ?? kind;
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  host.showStatus(`${label} set to ${displayName} for this session only.`, 'success');
}

async function performVisualModelSave(host: SlashCommandHost, alias: string): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    // Same contract as /squeeze-model: the engine pointer field is `model`
    // (`[visual_model] model`, resolved by `resolveVisualBinding`), and the
    // `visual-model` experiment flag gates the resolver — enable it on save
    // so the pick actually takes effect.
    await host.harness.setConfig({
      visualModel: { model: alias },
      experimental: { 'visual-model': true },
    });
  } catch (error) {
    host.showError(`Failed to save visual model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Visual model set to ${displayName}. Image inspection will use it.`,
    'success',
  );
}

export async function handleVisualModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
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
  const visual = (await host.harness.getConfig()).visualModel;
  // `model` is the engine-contract pointer; `defaultModel` is the legacy
  // field an older TUI wrote (honored as a resolver fallback).
  const current = visual?.model ?? visual?.defaultModel ?? '';
  showVisualModelPicker(host, models, current, alias.length > 0 ? alias : undefined);
}

// ---------------------------------------------------------------------------
// Squeeze model (`/squeeze-model`) — persists `[compaction_model] model`
// and enables the `compaction-model` experiment flag.
// (Renamed from `compaction-model` so `/comp` + Tab completes to `/compact`.)
// ---------------------------------------------------------------------------

function showSqueezeModelPicker(
  host: SlashCommandHost,
  models: Record<string, ModelAlias>,
  currentValue: string,
  secondary: boolean,
  selectedValue?: string,
): void {
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue,
      selectedValue,
      currentThinkingEffort: 'off',
      thinkingControl: false,
      title: secondary
          ? ' Select a secondary squeeze model (compaction fallback)'
          : ' Select a squeeze model (context summarization)',
      onSelect: ({ alias }) => {
        host.restoreEditor();
        void (secondary
            ? performSqueezeModelSecondarySave(host, alias)
            : performSqueezeModelSave(host, alias));
      },
      onSessionOnlySelect: ({ alias }) => {
        host.restoreEditor();
        void applySessionModelOverride(
          host,
          secondary ? 'compactionSecondary' : 'compaction',
          alias,
        );
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performSqueezeModelSave(host: SlashCommandHost, alias: string): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    // The engine contract pointer field is `model` (`[compaction_model] model`,
    // resolved by `resolveCompactionBinding`); `default_model` is a legacy
    // write from an older TUI that the resolver only treats as a fallback.
    // Saving also enables the `compaction-model` experiment — the resolver
    // short-circuits to the session model while the flag is off, so without
    // this the pick would stay inert on a default build.
    await host.harness.setConfig({
      compactionModel: { model: alias },
      experimental: { 'compaction-model': true },
    });
  } catch (error) {
    host.showError(`Failed to save squeeze model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Squeeze model set to ${displayName}. Context compaction will use it.`,
    'success',
  );
}

/**
 * `/squeeze-model-secondary`: the fallback squeeze model. Compaction tries
 * the squeeze model first, then this secondary pick, and only then falls
 * back to the current conversation model.
 */
async function performSqueezeModelSecondarySave(
  host: SlashCommandHost,
  alias: string,
): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    // `secondaryModel` is the second tier of the compaction cascade
    // (`[compaction_model] secondary_model`): squeeze model → secondary →
    // current model. Saving enables the same `compaction-model` experiment
    // flag the primary pick does.
    await host.harness.setConfig({
      compactionModel: { secondaryModel: alias },
      experimental: { 'compaction-model': true },
    });
  } catch (error) {
    host.showError(`Failed to save secondary squeeze model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Secondary squeeze model set to ${displayName}. Compaction tries the squeeze model, then ${displayName}, then the current model.`,
    'success',
  );
}

export async function handleSqueezeModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
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
  const compaction = (await host.harness.getConfig()).compactionModel;
  // `model` is the engine-contract pointer; `defaultModel` is the legacy
  // field an older TUI wrote (inert until the resolver fallback) — shown as
  // the current value so the picker reflects what compaction will use.
  const current = compaction?.model ?? compaction?.defaultModel ?? '';
  showSqueezeModelPicker(host, models, current, false, alias.length > 0 ? alias : undefined);
}

export async function handleSqueezeModelSecondaryCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
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
  const compaction = (await host.harness.getConfig()).compactionModel;
  const current = compaction?.secondaryModel ?? '';
  showSqueezeModelPicker(host, models, current, true, alias.length > 0 ? alias : undefined);
}

// ---------------------------------------------------------------------------
// Fallback model (`/fallback-model`) — persists `[fallback_model] model` and
// enables the `fallback-model` experiment flag. After the primary model
// exhausts its retry budget, the agent loop transparently retries on this
// alias. Mirrors the `squeeze-model` UX (model picker + persistent save).
// ---------------------------------------------------------------------------

function showFallbackModelPicker(
  host: SlashCommandHost,
  models: Record<string, ModelAlias>,
  currentValue: string,
  secondary: boolean,
  selectedValue?: string,
): void {
  host.mountEditorReplacement(
    new TabbedModelSelectorComponent({
      models,
      currentValue,
      selectedValue,
      currentThinkingEffort: 'off',
      thinkingControl: false,
      title: secondary
        ? ' Select a secondary fallback model (tried after the first fallback)'
        : ' Select a fallback model (used after the primary model fails)',
      onSelect: ({ alias }) => {
        host.restoreEditor();
        void (secondary
          ? performFallbackModelSecondarySave(host, alias)
          : performFallbackModelSave(host, alias));
      },
      onSessionOnlySelect: ({ alias }) => {
        host.restoreEditor();
        void applySessionModelOverride(
          host,
          secondary ? 'fallbackSecondary' : 'fallback',
          alias,
        );
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performFallbackModelSave(host: SlashCommandHost, alias: string): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    await host.harness.setConfig({
      fallbackModel: { model: alias },
      experimental: { 'fallback-model': true },
    });
  } catch (error) {
    host.showError(`Failed to save fallback model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Fallback model set to ${displayName}. After the primary model exhausts its retry budget, the agent will use it.`,
    'success',
  );
}

/**
 * `/fallback-model-secondary`: the second tier of the fallback cascade. The
 * agent tries the primary model first, then the fallback model, then this
 * secondary alias, before surfacing a terminal error.
 */
async function performFallbackModelSecondarySave(
  host: SlashCommandHost,
  alias: string,
): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    await host.harness.setConfig({
      fallbackModel: { secondaryModel: alias },
      experimental: { 'fallback-model': true },
    });
  } catch (error) {
    host.showError(`Failed to save secondary fallback model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Secondary fallback model set to ${displayName}. After the primary and first fallback model both fail, the agent will use it.`,
    'success',
  );
}

export async function handleFallbackModelCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
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
  const fallback = (await host.harness.getConfig()).fallbackModel;
  const current = fallback?.model ?? '';
  showFallbackModelPicker(host, models, current, false, alias.length > 0 ? alias : undefined);
}

export async function handleFallbackModelSecondaryCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
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
  const fallback = (await host.harness.getConfig()).fallbackModel;
  const current = fallback?.secondaryModel ?? '';
  showFallbackModelPicker(host, models, current, true, alias.length > 0 ? alias : undefined);
}

// ---------------------------------------------------------------------------
// Substitute model (`/substitute-model`) — persists `[substitute_model] default_model`
// ---------------------------------------------------------------------------

function showSubstituteModelPicker(
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
      thinkingControl: false,
      title: ' Select a substitute model (rate-limit fallback)',
      onSelect: ({ alias }) => {
        host.restoreEditor();
        void performSubstituteModelSave(host, alias);
      },
      onSessionOnlySelect: ({ alias }) => {
        host.restoreEditor();
        void applySessionModelOverride(host, 'substitute', alias);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function performSubstituteModelSave(host: SlashCommandHost, alias: string): Promise<void> {
  const displayName = modelDisplayName(alias, host.state.appState.availableModels[alias]);
  try {
    const config = await host.harness.getConfig({ reload: true });
    const patch: { defaultModel: string } = {
      defaultModel: alias,
    };
    await host.harness.setConfig({ substituteModel: patch });
  } catch (error) {
    host.showError(`Failed to save substitute model: ${formatErrorMessage(error)}`);
    return;
  }
  host.showStatus(
    `Substitute model set to ${displayName}. It will be used when the primary model hits a rate limit.`,
    'success',
  );
}

export async function handleSubstituteModelCommand(host: SlashCommandHost, args: string): Promise<void> {
  const alias = args.trim();
  await refreshModelsForPicker(host);
  const models = pickerModelsForHost(host);
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
  const substitute = (await host.harness.getConfig()).substituteModel;
  const current = substitute?.defaultModel ?? '';
  showSubstituteModelPicker(host, models, current, alias.length > 0 ? alias : undefined);
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
  await performModelSwitch(host, alias, arg, true);
}

function showEffortPicker(
  host: SlashCommandHost,
  model: ModelAlias,
  segments: readonly string[],
): void {
  const liveEffort = host.state.appState.thinkingEffort;
  const currentValue = segments.includes(liveEffort) ? liveEffort : (segments[0] ?? 'off');
  const alias = host.state.appState.model;
  host.mountEditorReplacement(
    new EffortSelectorComponent({
      efforts: segments,
      currentValue,
      warning: hasConversationHistory(host) ? EFFORT_SWITCH_CACHE_WARNING : undefined,
      onSelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, true);
      },
      onSessionOnlySelect: (effort) => {
        host.restoreEditor();
        void performModelSwitch(host, alias, effort, false);
      },
      onCancel: () => {
        host.restoreEditor();
      },
    }),
  );
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
 * host-effective provider resolution applied, minus the synthesized
 * `__secondary__` derived entry — a runtime artifact of the v1 engine's
 * `[secondary_model]` recipe that must never be selectable as a model.
 */
function pickerModelsForHost(host: SlashCommandHost): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(host.state.appState.availableModels)
      .filter(([alias]) => alias !== SECONDARY_DERIVED_MODEL_ALIAS)
      .map(([alias, model]) => [alias, effectiveModelForHost(host, model)]),
  );
}

export function showModelPicker(host: SlashCommandHost, selectedValue: string = host.state.appState.model): void {
  const models = pickerModelsForHost(host);
  const entries = Object.entries(models);
  if (entries.length === 0) {
    host.showNotice(
      'No models configured',
      'Run /login to sign in to Kimi, or /provider to add another provider from a model catalog.',
    );
    return;
  }
  let picker: TabbedModelSelectorComponent | undefined;
  picker = new TabbedModelSelectorComponent({
    models,
    currentValue: host.state.appState.model,
    selectedValue,
    currentThinkingEffort: host.state.appState.thinkingEffort,
    favoriteAliases: host.state.appState.favoriteModels ?? [],
    onToggleFavorite: (alias) => {
      void toggleFavoriteModel(host, alias, picker);
    },
    warning: hasConversationHistory(host) ? MODEL_SWITCH_CACHE_WARNING : undefined,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void performModelSwitch(host, alias, thinking, true);
    },
    onSessionOnlySelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void performModelSwitch(host, alias, thinking, false);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

/**
 * Toggle a model's favorite state: append at the end on add (add-order drives
 * the Favorites tab and Alt+M rotation), remove on unmark, persist to
 * tui.toml, and live-refresh the open picker so the tab and ★ markers update
 * without reopening the dialog.
 */
async function toggleFavoriteModel(
  host: SlashCommandHost,
  alias: string,
  picker: TabbedModelSelectorComponent | undefined,
): Promise<void> {
  const current = host.state.appState.favoriteModels ?? [];
  const isFavorite = current.includes(alias);
  const next = isFavorite ? current.filter((entry) => entry !== alias) : [...current, alias];
  host.setAppState({ favoriteModels: next });
  picker?.setFavoriteAliases(next);
  host.track('model_favorite_toggle', { alias, enabled: !isFavorite });
  try {
    await saveTuiConfig({ ...currentTuiConfig(host), favoriteModels: [...next] });
  } catch (error) {
    host.showError(`Failed to save favorite models: ${formatErrorMessage(error)}`);
  }
}

/**
 * Next favorite after the current model for the Alt+M rotation. Favorites not
 * present in the available catalog are skipped; the current model need not be
 * a favorite (rotation then starts at the first favorite). Returns undefined
 * when there is nothing useful to rotate to (no favorites, the only favorite
 * is already active, or none resolve in the catalog).
 */
export function nextFavoriteAlias(
  favorites: readonly string[],
  currentModel: string,
  availableAliases: ReadonlySet<string>,
): string | undefined {
  const usable = favorites.filter((alias) => availableAliases.has(alias));
  if (usable.length === 0) return undefined;
  if (usable.length === 1 && usable[0] === currentModel) return undefined;
  const currentIndex = usable.indexOf(currentModel);
  if (currentIndex === -1) return usable[0];
  return usable[(currentIndex + 1) % usable.length]!;
}

/**
 * Alt+M from the editor: switch the session straight to the next favorite
 * model — no dialog, no persistence (the saved default model is untouched;
 * /model remains the way to change the default).
 */
export async function rotateToNextFavoriteModel(host: SlashCommandHost): Promise<void> {
  const favorites = host.state.appState.favoriteModels ?? [];
  const available = new Set(Object.keys(host.state.appState.availableModels));
  const next = nextFavoriteAlias(favorites, host.state.appState.model, available);
  if (next === undefined) {
    host.showNotice(
      'No favorite models to rotate to',
      'Open /model and press Shift+A on a model to add it to Favorites.',
    );
    return;
  }
  const model = host.state.appState.availableModels[next];
  host.track('shortcut_model_rotate', { model: next });
  await performModelSwitch(
    host,
    next,
    model === undefined ? 'on' : defaultThinkingEffortFor(model),
    false,
  );
}

export async function performModelSwitch(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  persist: boolean,
): Promise<void> {
  let session = host.session;
  if (session === undefined && host.engineV2) {
    // A first prompt may still be inside lazy creation: wait it out so the
    // switch lands on the new session instead of being overwritten by its
    // assembly.
    await host.waitForLazyCreation();
    session = host.session;
  }
  if (host.state.appState.streamingPhase !== 'idle') {
    host.showError('Cannot switch models while streaming — press Esc or Ctrl-C first.');
    return;
  }

  const prevModel = host.state.appState.model;
  const prevEffort = host.state.appState.thinkingEffort;
  const modelChanged = alias !== prevModel;
  const effortChanged = effort !== prevEffort;
  const runtimeChanged = modelChanged || effortChanged;
  let effectiveAlias = alias;
  let effectiveEffort = effort;

  try {
    if (session === undefined && runtimeChanged) {
      await host.authFlow.activateModelAfterLogin(alias, effort);
    } else if (session !== undefined) {
      if (alias !== prevModel) {
        await session.setModel(alias);
      }
      if (effort !== prevEffort) {
        await session.setThinking(effort);
      }
      const status = await session.getStatus();
      effectiveAlias = status.model ?? alias;
      effectiveEffort = status.thinkingEffort;
    }
  } catch (error) {
    const msg = formatErrorMessage(error);
    host.showError(`Failed to switch model: ${msg}`);
    return;
  }

  if (session === undefined) {
    effectiveAlias = host.state.appState.model;
    effectiveEffort = host.state.appState.thinkingEffort;
  }
  const effectiveModelChanged = effectiveAlias !== prevModel;
  const effectiveEffortChanged = effectiveEffort !== prevEffort;
  const displayName = modelDisplayName(
    effectiveAlias,
    host.state.appState.availableModels[effectiveAlias],
  );
  host.setAppState({ model: effectiveAlias, thinkingEffort: effectiveEffort });
  if (session === undefined && runtimeChanged) {
    if (effectiveModelChanged) {
      host.track('model_switch', { model: effectiveAlias });
    }
    if (effectiveEffortChanged) {
      host.track('thinking_toggle', {
        enabled: effectiveEffort !== 'off',
        effort: effectiveEffort,
        from: prevEffort,
      });
    }
  }

  let persisted = false;
  if (persist) {
    try {
      persisted = await persistModelSelection(
        host,
        effectiveAlias,
        effectiveEffort,
        effectiveEffortChanged,
      );
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Switched to ${displayName}, but failed to save default: ${msg}`);
      return;
    }
  }

  let status: string;
  if (effectiveModelChanged) {
    status = persist
      ? `Switched to ${displayName} with thinking ${effectiveEffort}.`
      : `Switched to ${displayName} with thinking ${effectiveEffort} for this session only.`;
  } else if (effectiveEffortChanged) {
    status = persist
      ? `Thinking set to ${effectiveEffort}.`
      : `Thinking set to ${effectiveEffort} for this session only.`;
  } else if (persist && persisted) {
    status = `Saved ${displayName} with thinking ${effectiveEffort} as default.`;
  } else {
    status = `Already using ${displayName} with thinking ${effectiveEffort}.`;
  }
  host.showStatus(status, 'success');
}

async function persistModelSelection(
  host: SlashCommandHost,
  alias: string,
  effort: ThinkingEffort,
  effortChanged: boolean,
): Promise<boolean> {
  const config = await host.harness.getConfig({ reload: true });
  const model = host.state.appState.availableModels[alias];
  const full = thinkingEffortToConfig(
    effort,
    model === undefined ? undefined : effectiveModelForHost(host, model),
  );
  // Re-confirming the effort shown when the picker opened is not an explicit
  // choice — persist the model but leave the stored effort preference alone.
  const patch = effortChanged ? full : { enabled: full.enabled };
  if (
    config.defaultModel === alias &&
    config.thinking?.enabled === patch.enabled &&
    (!effortChanged || config.thinking?.effort === patch.effort)
  ) {
    return false;
  }
  await host.harness.setConfig({
    defaultModel: alias,
    thinking: patch,
  });
  return true;
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
      thinkingControl: false,
      title: ' Select a secondary model (subagents)',
      onSelect: ({ alias }) => {
        host.restoreEditor();
        void performSecondaryModelSave(host, alias);
      },
      onSessionOnlySelect: ({ alias }) => {
        host.restoreEditor();
        void applySessionModelOverride(host, 'secondary', alias);
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
    if (host.session !== undefined) {
      const reloadedSession = await host.harness.reloadSession({ id: host.session.id });
      await host.reloadCurrentSessionView(
        reloadedSession,
        'Experimental features updated. Session reloaded.',
      );
    } else {
      host.showStatus('Experimental features updated.', 'success');
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
    } else if (!host.engineV2) {
      host.showError(NO_ACTIVE_SESSION_MESSAGE);
      return;
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
    readonly appState: Pick<
      SlashCommandHost['state']['appState'],
      'theme' | 'editorCommand' | 'notifications' | 'upgrade' | 'disableFeedbackSurvey'
    >;
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
    await saveTuiConfig({
      ...currentTuiConfig(host as unknown as SlashCommandHost),
      disableFeedbackSurvey,
    });
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
    case 'model': showModelPicker(host); return;
    case 'permission': showPermissionPicker(host); return;
    case 'theme': showThemePicker(host); return;
    case 'editor': showEditorPicker(host); return;
    case 'survey': showSurveyPreferencePicker(host); return;
    case 'experiments': void showExperimentsPanel(host); return;
    case 'upgrade': showUpdatePreferencePicker(host); return;
    case 'usage': void showUsage(host); return;
  }
}