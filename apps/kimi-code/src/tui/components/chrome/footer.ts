/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1: [yolo] [plan] <model> [vX.Y.Z] <cwd>  <git-badge>  <shortcut hints>
 *   Line 2: [plan usage] context: N% (tokens/max)
 *
 * The version badge and plan-usage quota are opt-in via `[footer]` in
 * tui.toml (both default off).
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { effectiveModelAlias } from '@moonshot-ai/kimi-code-sdk';

import {
  severityColor,
  type ManagedUsageReport,
  type ManagedUsageRow,
} from '#/tui/components/messages/usage-panel';
import { ALL_TIPS, type ToolbarTip } from '#/tui/constant/tips';
import { isRainbowDancing, renderDanceFooterModel } from '#/tui/easter-eggs/dance';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { FooterConfig } from '#/tui/config';
import type { AppState } from '#/tui/types';
import type { ManagedUsageFetchResult } from '#/tui/utils/managed-usage';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
  usagePercent,
  usagePercentFromRatio,
} from '#/utils/usage/usage-format';

const MAX_CWD_SEGMENTS = 3;
const GOAL_TIMER_INTERVAL_MS = 1_000;
const PLAN_USAGE_BAR_WIDTH = 8;
/**
 * Fixed poll cadence used while no plan-usage fetch has succeeded yet
 * (startup races, transient errors). After the first success the poller
 * settles into the configured `plan_usage_refresh_seconds` period.
 */
export const PLAN_USAGE_RETRY_MS = 5_000;

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

/**
 * Injected managed-plan usage loader (see `tui/utils/managed-usage.ts`).
 * `undefined` means the feature does not apply (non-managed provider —
 * hide the segment); `{ error }` means the fetch failed and the footer
 * keeps its last successful report.
 */
export type ManagedUsageFetcher = () => Promise<ManagedUsageFetchResult | undefined>;

/**
 * One compact quota row, e.g. `week ███░░░░░ 40% (21h)`. The label comes
 * from the API verbatim; bar and percent share the severity color; the
 * reset hint is muted in parentheses.
 */
function formatPlanUsageRow(row: ManagedUsageRow, colors: ColorPalette): string {
  const ratio = safeUsageRatio(row.limit > 0 ? row.used / row.limit : 0);
  const severity = severityColor(ratioSeverity(ratio));
  const bar = currentTheme.fg(severity, renderProgressBar(ratio, PLAN_USAGE_BAR_WIDTH));
  const pct = currentTheme.fg(severity, `${String(usagePercent(row.used, row.limit))}%`);
  const reset = row.resetHint ? chalk.hex(colors.textMuted)(` (${row.resetHint})`) : '';
  return `${chalk.hex(colors.textDim)(row.label)} ${bar} ${pct}${reset}`;
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
  private planUsageFetcher: ManagedUsageFetcher | null = null;
  private planUsageReport: ManagedUsageReport | null = null;
  private planUsageTimer: ReturnType<typeof setTimeout> | null = null;
  private planUsageTimerKey: string | null = null;
  private planUsageGeneration = 0;
  private planUsageInFlight = false;

  constructor(state: AppState, onRefresh: () => void = () => {}) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.state = state;
    this.syncPlanUsageTimer(state.footer);
  }

  /**
   * Injects the managed-plan usage loader. Called once at startup with
   * the harness-backed implementation; tests inject their own.
   */
  setManagedUsageFetcher(fetcher: ManagedUsageFetcher): void {
    this.planUsageFetcher = fetcher;
    this.syncPlanUsageTimer(this.state.footer);
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

    if (state.footer.showVersion && state.version.length > 0) {
      left.push(chalk.hex(colors.textDim)(`v${state.version}`));
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

    // ── Line 2: transient hint or plan usage (bottom-left) + context (right) ──
    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const contextWidth = visibleWidth(contextText);
    let line2: string;
    if (this.transientHint) {
      // The transient hint wins the left slot; the quota segment yields.
      const maxHintWidth = Math.max(0, width - contextWidth - 1);
      const shownHint =
        visibleWidth(this.transientHint) <= maxHintWidth
          ? this.transientHint
          : truncateToWidth(this.transientHint, maxHintWidth, '…');
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - contextWidth);
      line2 =
        chalk.hex(colors.warning).bold(shownHint) +
        ' '.repeat(pad) +
        chalk.hex(colors.text)(contextText);
    } else {
      const planUsage = state.footer.showPlanUsage
        ? this.formatPlanUsage(colors, Math.max(0, width - contextWidth - 1))
        : null;
      const leftSegment = planUsage ?? '';
      const leftPad = Math.max(0, width - visibleWidth(leftSegment) - contextWidth);
      line2 = leftSegment + ' '.repeat(leftPad) + chalk.hex(colors.text)(contextText);
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

  dispose(): void {
    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
    this.stopPlanUsageTimer();
  }

  /**
   * Keeps the plan-usage poller in sync with the footer config. The poll
   * runs only when the feature is enabled and a fetcher was injected;
   * a refresh-period change restarts the schedule.
   */
  private syncPlanUsageTimer(config: FooterConfig): void {
    if (!config.showPlanUsage || this.planUsageFetcher === null) {
      this.stopPlanUsageTimer();
      this.planUsageReport = null;
      return;
    }

    const key = String(config.planUsageRefreshSeconds);
    if (key === this.planUsageTimerKey) return;
    this.stopPlanUsageTimer();
    this.planUsageTimerKey = key;
    void this.pollPlanUsage(this.planUsageGeneration);
  }

  private stopPlanUsageTimer(): void {
    // Bumping the generation also stops an in-flight poll from
    // scheduling its follow-up when it settles.
    this.planUsageGeneration += 1;
    if (this.planUsageTimer !== null) {
      clearTimeout(this.planUsageTimer);
      this.planUsageTimer = null;
    }
    this.planUsageTimerKey = null;
  }

  /**
   * Schedules the next poll. Unsuccessful polls (undefined/error/throw)
   * retry after `PLAN_USAGE_RETRY_MS` instead of the full configured
   * period — startup races (provider list not populated yet, token not
   * refreshed) would otherwise hide the segment for a whole period.
   */
  private schedulePlanUsagePoll(generation: number, delayMs: number): void {
    if (generation !== this.planUsageGeneration) return;
    this.planUsageTimer = setTimeout(() => {
      this.planUsageTimer = null;
      void this.pollPlanUsage(generation);
    }, delayMs);
    this.planUsageTimer.unref?.();
  }

  private async pollPlanUsage(generation: number): Promise<void> {
    const fetcher = this.planUsageFetcher;
    if (fetcher === null || this.planUsageInFlight) return;
    this.planUsageInFlight = true;
    let succeeded = false;
    try {
      const result = await fetcher();
      if (result === undefined) {
        // Not a managed provider (anymore): hide the segment entirely.
        if (this.planUsageReport !== null) {
          this.planUsageReport = null;
          this.onRefresh();
        }
        return;
      }
      if (result.usage !== undefined) {
        this.planUsageReport = result.usage;
        this.onRefresh();
        succeeded = true;
      }
      // `{ error }`: keep the last successful report, stay silent.
    } catch {
      // Injected fetchers report errors in-band; a throw is treated the
      // same — keep the last successful report.
    } finally {
      this.planUsageInFlight = false;
      this.schedulePlanUsagePoll(
        generation,
        succeeded
          ? this.state.footer.planUsageRefreshSeconds * 1_000
          : PLAN_USAGE_RETRY_MS,
      );
    }
  }

  /**
   * Compact plan-quota segment for line 2, e.g.
   * `week ███░░░░░ 40% (21h) · 5h █░░░░░░░ 8% (17m)`. When it does not
   * fit, rolling-window rows drop off from the right first — the summary
   * row is the last one standing (then plain truncation).
   */
  private formatPlanUsage(colors: ColorPalette, maxWidth: number): string | null {
    const report = this.planUsageReport;
    if (report === null) return null;
    const rows: ManagedUsageRow[] = [];
    if (report.summary !== null) rows.push(report.summary);
    rows.push(...report.limits);
    if (rows.length === 0) return null;

    const separator = chalk.hex(colors.textDim)(' · ');
    const parts = rows.map((row) => formatPlanUsageRow(row, colors));
    let keep = parts.length;
    let segment = parts.slice(0, keep).join(separator);
    while (keep > 1 && visibleWidth(segment) > maxWidth) {
      keep -= 1;
      segment = parts.slice(0, keep).join(separator);
    }
    return visibleWidth(segment) <= maxWidth
      ? segment
      : truncateToWidth(segment, maxWidth, '…');
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
