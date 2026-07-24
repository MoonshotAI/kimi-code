/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1: [yolo] [plan] <model> <cwd>  <git-badge>  <shortcut hints>
 *   Line 2: context: N% (tokens/max)
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { effectiveModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { ALL_TIPS, type ToolbarTip } from '#/tui/constant/tips';
import { isRainbowDancing, renderDanceFooterModel } from '#/tui/easter-eggs/dance';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import { DEFAULT_TUI_CONFIG, type StatusLineConfig } from '#/tui/config';
import {
  runStatusLineCommand,
  type StatusLineCommandPayload,
  type StatusLineManagedUsage,
  type StatusLineManagedUsageLoader,
  type StatusLineRateLimit,
} from '#/tui/utils/status-line-command';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import {
  formatTokenCount,
  usagePercent,
  usagePercentFromRatio,
} from '#/utils/usage/usage-format';

const MAX_CWD_SEGMENTS = 3;
const GOAL_TIMER_INTERVAL_MS = 1_000;
const STATUS_LINE_REFRESH_INTERVAL_MS = 1_000;
const STATUS_LINE_RATE_LIMIT_REFRESH_INTERVAL_MS = 30_000;

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " | ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = ' | ';

/**
 * Expand tips into a rotation sequence using smooth weighted round-robin
 * (the nginx SWRR algorithm). Higher-`priority` tips appear more often while
 * staying evenly spread, so a tip generally does not land next to its own
 * duplicate. Deterministic and computed once at module load. Exported for
 * unit testing.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): readonly ToolbarTip[] {
  const items = tips.map((t) => ({
    tip: t,
    weight: Math.max(1, Math.trunc(t.priority ?? 1)),
    current: 0,
  }));
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  const seq: ToolbarTip[] = [];
  for (let n = 0; n < total; n++) {
    let best = items[0]!;
    for (const it of items) {
      it.current += it.weight;
      if (it.current > best.current) best = it;
    }
    best.current -= total;
    seq.push(best.tip);
  }
  return seq;
}

const ROTATION: readonly ToolbarTip[] = buildWeightedTips(ALL_TIPS);

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

/**
 * Pick the tip(s) for a rotation index over the weighted ROTATION sequence.
 * `primary` is always shown when it fits; `pair` (primary + next tip joined
 * by the separator) is offered for wide terminals. Pairing is skipped when
 * the current/next tip is `solo` or when the neighbour is a duplicate of the
 * current tip (which can happen at the wrap boundary), keeping long/important
 * tips on their own and avoiding "X | X".
 */
function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const n = ROTATION.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = ROTATION[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = ROTATION[(offset + 1) % n]!;
  if (next.solo || next.text === current.text) return { primary: current.text, pair: null };
  return { primary: current.text, pair: current.text + TIP_SEPARATOR + next.text };
}

/**
 * Footer goal badge, e.g. `[goal ● active · 4m · 7 turns]`. Only shown for a
 * live (active/paused) goal; terminal/no goal -> no badge. Turn count is a raw
 * count unless an explicit turn budget is set, in which case it shows used/limit.
 */
function formatGoalBadge(
  goal: AppState['goal'],
  colors: ColorPalette,
  wallClockMs?: number,
): string | null {
  if (goal === null || goal === undefined) return null;
  // Show the badge for every persisted, resumable status. `complete` clears the
  // goal, so it never reaches here; only the unset case returns null.
  if (goal.status !== 'active' && goal.status !== 'paused' && goal.status !== 'blocked') {
    return null;
  }
  const dotColor =
    goal.status === 'active'
      ? colors.primary
      : goal.status === 'blocked'
        ? colors.warning
        : colors.textMuted;
  const turns =
    goal.budget.turnBudget !== null
      ? `${goal.turnsUsed}/${goal.budget.turnBudget} turns`
      : `${goal.turnsUsed} ${goal.turnsUsed === 1 ? 'turn' : 'turns'}`;
  const label = `${goal.status} · ${formatBadgeElapsed(wallClockMs ?? goal.wallClockMs)} · ${turns}`;
  return (
    chalk.hex(colors.textMuted)('[goal ') +
    chalk.hex(dotColor)('●') +
    chalk.hex(colors.textMuted)(` ${label}]`)
  );
}

function formatBadgeElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? state.model;
}

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env['HOME'] ?? '';
  let work = path;
  if (home && path === home) {
    return '~';
  }
  if (home && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

/**
 * Footer context readout. Percent comes from the exact token counts when
 * both are known (the ratio can lag a step behind); otherwise it falls
 * back to the precomputed ratio. Counts use the shared 1024-based
 * formatter.
 */
function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  if (maxTokens !== undefined && maxTokens > 0 && tokens !== undefined) {
    const pct = String(usagePercent(tokens, maxTokens));
    return `context: ${pct}% (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `context: ${String(usagePercentFromRatio(usage))}%`;
}

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.textDim)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  private state: AppState;
  private readonly onRefresh: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  private statusLineText: string | null = null;
  private statusLineInFlight = false;
  private statusLineRefreshPending = false;
  private statusLineTimer: ReturnType<typeof setInterval> | null = null;
  private statusLineCommand: string | null = null;
  private statusLineGeneration = 0;
  private statusLineRateLimits: readonly StatusLineRateLimit[] = [];
  private statusLineRateLimitsProvider: string | null = null;
  private statusLineRateLimitsLoadedAt = 0;
  private statusLineRateLimitsInFlight = false;
  private disposed = false;
  private goalSnapshotKey: string | null = null;
  private goalObservedAtMs = Date.now();
  private goalTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(
    state: AppState,
    onRefresh: () => void = () => {},
    private readonly loadStatusLineManagedUsage: StatusLineManagedUsageLoader = async () =>
      undefined,
  ) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineTimer(statusLineConfig(state).command);
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.state = state;
    this.syncStatusLineTimer(statusLineConfig(state).command);
  }

  /**
   * Short-lived hint that replaces the rotating toolbar tips on line 1.
   * Used by the exit-confirmation double-tap flow to show "Press Ctrl+C
   * again to exit" without requiring a toast/overlay subsystem.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  getTransientHint(): string | null {
    return this.transientHint;
  }

  /**
   * Sync both background-task badges with live counts. Each non-zero
   * count produces its own bracketed badge on line 1; zeros hide them
   * independently.
   */
  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const colors = currentTheme.palette;
    const state = this.state;

    // ── Line 1: mode badges + model + [N task(s) running] + [N agent(s) running] + cwd + git + hints ──
    const left: string[] = [];
    const modes: string[] = [];
    if (state.permissionMode === 'auto') modes.push(chalk.hex(colors.warning).bold('auto'));
    if (state.permissionMode === 'yolo') modes.push(chalk.hex(colors.warning).bold('yolo'));
    if (state.planMode) modes.push(chalk.hex(colors.primary).bold('plan'));
    if (state.swarmMode) modes.push(chalk.hex(colors.accent).bold('swarm'));
    if (modes.length > 0) left.push(modes.join(' '));

    const goalBadge = formatGoalBadge(state.goal, colors, this.goalWallClockMs(state.goal));
    if (goalBadge !== null) left.push(goalBadge);

    const model = modelDisplayName(state);
    if (model) {
      const effort = state.thinkingEffort;
      const rawCurrentModel = state.availableModels[state.model];
      const currentModel = rawCurrentModel === undefined ? undefined : effectiveModelAlias(rawCurrentModel);
      // Only effort-capable models (those declaring support_efforts) show the
      // concrete effort; legacy boolean models keep the plain "thinking" suffix.
      const hasEfforts = (currentModel?.supportEfforts?.length ?? 0) > 0;
      const thinkingLabel =
        effort !== 'off'
          ? hasEfforts && effort !== 'on'
            ? ` thinking: ${effort}`
            : ' thinking'
          : '';
      const modelLabel = `${model}${thinkingLabel}`;
      let renderedModelLabel = chalk.hex(colors.text)(modelLabel);
      if (isRainbowDancing()) {
        renderedModelLabel = renderDanceFooterModel(modelLabel);
      }
      left.push(renderedModelLabel);
    }

    // Background-task badges sit immediately before cwd. `bash-*` tasks
    // (shell processes) and `agent-*` tasks (background subagents) get
    // separate badges so the user can distinguish them at a glance.
    if (this.backgroundBashTaskCount > 0) {
      const noun = this.backgroundBashTaskCount === 1 ? 'task' : 'tasks';
      left.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundBashTaskCount)} ${noun} running]`),
      );
    }
    if (this.backgroundAgentCount > 0) {
      const noun = this.backgroundAgentCount === 1 ? 'agent' : 'agents';
      left.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundAgentCount)} ${noun} running]`),
      );
    }

    const cwd = shortenCwd(state.workDir);
    if (cwd) left.push(chalk.hex(colors.textDim)(cwd));

    const git = this.gitCache.getStatus();
    if (git !== null) {
      left.push(formatFooterGitBadge(git, colors));
    }

    const leftLine = left.join('  ');
    const leftWidth = visibleWidth(leftLine);

    // Rotating hint tips, fill remaining space on line 1.
    const { primary, pair } = tipsForIndex(currentTipIndex());
    const gap = 2;
    const remaining = Math.max(0, width - leftWidth - gap);
    let tipText = '';
    if (pair && visibleWidth(pair) <= remaining) {
      tipText = pair;
    } else if (primary && visibleWidth(primary) <= remaining) {
      tipText = primary;
    }

    let line1: string;
    if (tipText) {
      const pad = width - leftWidth - visibleWidth(tipText);
      line1 = leftLine + ' '.repeat(Math.max(0, pad)) + chalk.hex(colors.textMuted)(tipText);
    } else if (leftWidth <= width) {
      line1 = leftLine;
    } else {
      line1 = truncateToWidth(leftLine, width, '…');
    }

    // ── Line 2: transient hint (bottom-left) + status line (right) ──
    const statusLineText =
      this.statusLineText ??
      formatContextStatus(state.contextUsage, state.contextTokens, state.maxContextTokens);
    const renderedStatusLine =
      this.statusLineText === null ? chalk.hex(colors.text)(statusLineText) : statusLineText;
    let line2: string;
    if (this.transientHint) {
      const statusLineWidth = visibleWidth(statusLineText);
      const maxHintWidth = Math.max(0, width - statusLineWidth - 1);
      const shownHint =
        visibleWidth(this.transientHint) <= maxHintWidth
          ? this.transientHint
          : truncateToWidth(this.transientHint, maxHintWidth, '…');
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - statusLineWidth);
      line2 =
        chalk.hex(colors.warning).bold(shownHint) +
        ' '.repeat(pad) +
        renderedStatusLine;
    } else {
      const statusLineWidth = visibleWidth(statusLineText);
      const leftPad = Math.max(0, width - statusLineWidth);
      line2 = ' '.repeat(leftPad) + renderedStatusLine;
    }

    return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
  }

  private syncGoalClock(goal: AppState['goal']): void {
    const key = goalSnapshotKey(goal);
    if (key === this.goalSnapshotKey) return;
    this.goalSnapshotKey = key;
    this.goalObservedAtMs = Date.now();
  }

  private syncGoalTimer(goal: AppState['goal']): void {
    if (goal?.status === 'active') {
      if (this.goalTimer !== null) return;
      this.goalTimer = setInterval(() => {
        this.onRefresh();
      }, GOAL_TIMER_INTERVAL_MS);
      this.goalTimer.unref?.();
      return;
    }

    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
  }

  private syncStatusLineTimer(command: string | null): void {
    const commandChanged = command !== this.statusLineCommand;
    const providerKey = statusLineProvider(this.state);
    const providerChanged = providerKey !== this.statusLineRateLimitsProvider;
    if (command !== this.statusLineCommand) {
      this.statusLineCommand = command;
      this.statusLineGeneration += 1;
      this.statusLineText = null;
    }
    if (providerChanged) {
      this.statusLineRateLimitsProvider = providerKey;
      this.statusLineRateLimits = [];
      this.statusLineRateLimitsLoadedAt = 0;
    }

    if (command !== null) {
      const timerCreated = this.statusLineTimer === null;
      if (this.statusLineTimer === null) {
        this.statusLineTimer = setInterval(() => {
          void this.refreshStatusLineRateLimits();
          void this.refreshStatusLine();
        }, STATUS_LINE_REFRESH_INTERVAL_MS);
        this.statusLineTimer.unref?.();
      }
      void this.refreshStatusLineRateLimits();
      if (commandChanged || timerCreated || providerChanged) {
        void this.refreshStatusLine();
      }
      return;
    }

    if (this.statusLineTimer !== null) {
      clearInterval(this.statusLineTimer);
      this.statusLineTimer = null;
    }
  }

  private async refreshStatusLine(): Promise<void> {
    const { command, timeoutMs } = statusLineConfig(this.state);
    if (command === null) return;
    if (this.statusLineInFlight) {
      this.statusLineRefreshPending = true;
      return;
    }
    this.statusLineRefreshPending = false;
    const generation = this.statusLineGeneration;
    this.statusLineInFlight = true;
    let text: string | null = null;
    try {
      text = await runStatusLineCommand({
        command,
        timeoutMs,
        payload: this.createStatusLinePayload(),
      });
    } catch {
      text = null;
    } finally {
      this.statusLineInFlight = false;
    }

    if (
      this.disposed ||
      generation !== this.statusLineGeneration ||
      statusLineConfig(this.state).command !== command
    ) {
      if (!this.disposed && statusLineConfig(this.state).command !== null) {
        void this.refreshStatusLine();
      }
      return;
    }

    this.statusLineText = text;
    this.onRefresh();
    if (this.statusLineRefreshPending) {
      void this.refreshStatusLine();
    }
  }

  private async refreshStatusLineRateLimits(): Promise<void> {
    const providerKey = this.statusLineRateLimitsProvider;
    if (
      providerKey === null ||
      this.statusLineRateLimitsInFlight ||
      Date.now() - this.statusLineRateLimitsLoadedAt <
        STATUS_LINE_RATE_LIMIT_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    this.statusLineRateLimitsInFlight = true;
    let result: StatusLineManagedUsage | undefined;
    try {
      result = await this.loadStatusLineManagedUsage(providerKey);
    } catch {
      result = undefined;
    } finally {
      this.statusLineRateLimitsInFlight = false;
    }

    if (this.disposed || providerKey !== this.statusLineRateLimitsProvider) return;
    this.statusLineRateLimitsLoadedAt = Date.now();
    this.statusLineRateLimits = managedUsageRateLimits(result);
    if (statusLineConfig(this.state).command !== null) {
      void this.refreshStatusLine();
    }
  }

  private createStatusLinePayload(): StatusLineCommandPayload {
    const state = this.state;
    return {
      session_id: state.sessionId,
      model: state.model,
      display_model: modelDisplayName(state),
      cwd: state.workDir,
      permission_mode: state.permissionMode,
      plan_mode: state.planMode,
      input_mode: state.inputMode,
      swarm_mode: state.swarmMode,
      thinking_effort: state.thinkingEffort,
      context: {
        usage: safeUsage(state.contextUsage),
        tokens: state.contextTokens,
        max_tokens: state.maxContextTokens,
      },
      rate_limits: this.statusLineRateLimits,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
    if (this.statusLineTimer !== null) {
      clearInterval(this.statusLineTimer);
      this.statusLineTimer = null;
    }
  }

  private goalWallClockMs(goal: AppState['goal']): number | undefined {
    if (goal === null || goal === undefined) return undefined;
    if (goal.status !== 'active') return goal.wallClockMs;
    return goal.wallClockMs + Math.max(0, Date.now() - this.goalObservedAtMs);
  }
}

function goalSnapshotKey(goal: AppState['goal']): string | null {
  if (goal === null || goal === undefined) return null;
  return [
    goal.goalId,
    goal.status,
    goal.terminalReason ?? '',
    String(goal.turnsUsed),
    String(goal.tokensUsed),
    String(goal.wallClockMs),
    String(goal.budget.tokenBudget),
    String(goal.budget.turnBudget),
    String(goal.budget.wallClockBudgetMs),
  ].join('\u0000');
}

function statusLineConfig(state: AppState): StatusLineConfig {
  return (state as Partial<AppState>).statusLine ?? DEFAULT_TUI_CONFIG.statusLine;
}

function statusLineProvider(state: AppState): string | null {
  return state.availableModels[state.model]?.provider ?? null;
}

function managedUsageRateLimits(
  result: StatusLineManagedUsage | undefined,
): readonly StatusLineRateLimit[] {
  if (result?.kind !== 'ok') return [];
  const rows = result.summary === null ? result.limits : [result.summary, ...result.limits];
  return rows
    .filter((row) => row.limit > 0)
    .map((row) => ({
      label: row.label,
      used: row.used,
      limit: row.limit,
      reset_hint: row.resetHint,
    }));
}
