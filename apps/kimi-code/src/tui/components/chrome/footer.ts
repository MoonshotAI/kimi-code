/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1: [ask-when-needed] [plan] <model> <cwd>  <git-badge>  <shortcut hints>
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
import type { AppState, ManagedUsageRowSnapshot } from '#/tui/types';
import { PERMISSION_MODE_DISPLAY_NAMES } from '#/tui/utils/permission-mode';
import {
  StatusLineCommandRunner,
  type StatusLinePayload,
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
  ratioSeverity,
  renderProgressBar,
  usagePercent,
  usagePercentFromRatio,
} from '#/utils/usage/usage-format';

const DEFAULT_STATUS_LINE_ITEMS = ['mode', 'goal', 'model', 'tasks', 'cwd', 'git'] as const;

const MAX_CWD_SEGMENTS = 3;
const GOAL_TIMER_INTERVAL_MS = 1_000;

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

/** Local HH:MM:SS clock time for the usage block's "updated" stamp. */
function formatClockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Quota rows plus layout metadata for the managed-usage block. */
interface UsageBlock {
  readonly rows: readonly ManagedUsageRowSnapshot[];
  readonly labelWidth: number;
  readonly fetchedAt: number;
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
  private warningHint: string | null = null;
  private goalSnapshotKey: string | null = null;
  private goalObservedAtMs = Date.now();
  private goalTimer: ReturnType<typeof setInterval> | null = null;
  private statusLineRunner: StatusLineCommandRunner | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(state: AppState, onRefresh: () => void = () => {}) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineRunner(state);
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineRunner(state);
    this.state = state;
  }

  private syncStatusLineRunner(state: AppState): void {
    const command = state.statusLine?.command ?? null;
    if (command === null) {
      this.statusLineRunner?.dispose();
      this.statusLineRunner = null;
      return;
    }
    if (this.statusLineRunner?.command !== command) {
      // A reload can swap one command for another; the old runner would
      // otherwise keep executing the previous script until restart.
      this.statusLineRunner?.dispose();
      this.statusLineRunner = new StatusLineCommandRunner(command, this.onRefresh);
    }
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
   * Longer-lived warning for line 2 (e.g. the over-long `/goal` objective
   * warning). Unlike the transient hint it has no owner/timeout: the caller
   * sets and clears it directly. A transient hint takes precedence while
   * present; the warning returns as soon as the transient hint clears.
   * Pass `null` to clear.
   */
  setWarningHint(hint: string | null): void {
    this.warningHint = hint;
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

    // ── Line 1: slots composed per status_line.items, or a user command ──
    let line1: string;
    let customLine: string | null = null;
    if (this.statusLineRunner !== null) {
      this.statusLineRunner.maybeRefresh(this.statusLinePayload());
      customLine = this.statusLineRunner.current();
    }

    if (customLine !== null) {
      // status_line.command: the first stdout line takes over line 1.
      line1 = chalk.hex(colors.text)(customLine);
    } else {
      const slots = this.buildSlots(colors);
      const configured = this.state.statusLine?.items ?? null;
      const order: readonly string[] = configured ?? DEFAULT_STATUS_LINE_ITEMS;
      const left: string[] = [];
      for (const slot of order) {
        const pieces = slots[slot as keyof typeof slots];
        if (pieces !== undefined) left.push(...pieces);
      }

      const leftLine = left.join('  ');
      const leftWidth = visibleWidth(leftLine);

      // Rotating hint tips stay on the right unless they were given an
      // inline slot in items (rendered above at their configured position)
      // or the user dropped 'tips' from items.
      let tipText = '';
      const tipsInline = order.includes('tips');
      const showTips = !tipsInline && (configured === null || configured.includes('tips'));
      if (showTips) {
        const { primary, pair } = tipsForIndex(currentTipIndex());
        const gap = 2;
        const remaining = Math.max(0, width - leftWidth - gap);
        if (pair && visibleWidth(pair) <= remaining) {
          tipText = pair;
        } else if (primary && visibleWidth(primary) <= remaining) {
          tipText = primary;
        }
      }

      if (tipText) {
        const pad = width - leftWidth - visibleWidth(tipText);
        line1 = leftLine + ' '.repeat(Math.max(0, pad)) + chalk.hex(colors.textMuted)(tipText);
      } else if (leftWidth <= width) {
        line1 = leftLine;
      } else {
        line1 = truncateToWidth(leftLine, width, '…');
      }
    }

    // ── Line 2: transient hint or first quota row or custom status line (left) + context (right) ──
    const usage = this.usageBlock();
    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const contextWidth = visibleWidth(contextText);
    let line2: string;
    const hint = this.transientHint ?? this.warningHint;
    if (hint) {
      const maxHintWidth = Math.max(0, width - contextWidth - 1);
      const shownHint =
        visibleWidth(hint) <= maxHintWidth ? hint : truncateToWidth(hint, maxHintWidth, '…');
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - contextWidth);
      line2 =
        chalk.hex(colors.warning).bold(shownHint) +
        ' '.repeat(pad) +
        chalk.hex(colors.text)(contextText);
    } else {
      // The managed-usage block owns this slot with its first quota row.
      // A custom status line already renders on line 1, so it is not
      // repeated here.
      const content = usage !== null ? this.renderUsageRow(usage.rows[0]!, usage.labelWidth) : null;
      if (content === null) {
        const leftPad = Math.max(0, width - contextWidth);
        line2 = ' '.repeat(leftPad) + chalk.hex(colors.text)(contextText);
      } else {
        const shown = truncateToWidth(content, Math.max(0, width - contextWidth - 1));
        const pad = Math.max(0, width - visibleWidth(shown) - contextWidth);
        line2 = shown + ' '.repeat(pad) + chalk.hex(colors.text)(contextText);
      }
    }

    return [
      truncateToWidth(line1, width),
      truncateToWidth(line2, width),
      ...this.renderUsageLines(width, usage),
    ];
  }

  /**
   * Quota rows for the managed-usage block, ordered with the windowed
   * limits (5h) first and the weekly summary last — so the first row sits
   * on line 2, the rest follow from line 3. Null when there is no snapshot
   * or no rows to show.
   */
  private usageBlock(): UsageBlock | null {
    const usage = this.state.managedUsage;
    if (usage === null || usage === undefined) return null;
    const rows = [...usage.limits, ...(usage.summary === null ? [] : [usage.summary])];
    if (rows.length === 0) return null;
    return {
      rows,
      labelWidth: Math.max(...rows.map((row) => row.label.length)),
      fetchedAt: usage.fetchedAt,
    };
  }

  /** One quota row: label, severity-coloured bar, percent, reset hint. */
  private renderUsageRow(row: UsageBlock['rows'][number], labelWidth: number): string {
    const colors = currentTheme.palette;
    const ratio = row.limit > 0 ? row.used / row.limit : 0;
    const severity = ratioSeverity(ratio);
    const barColor =
      severity === 'danger' ? colors.error : severity === 'warn' ? colors.warning : colors.success;
    const bar = chalk.hex(barColor)(renderProgressBar(ratio, 20));
    const pct = chalk.hex(colors.text)(`${String(usagePercent(row.used, row.limit))}% used`);
    const reset =
      row.resetHint === undefined ? '' : `  ${chalk.hex(colors.textMuted)(row.resetHint)}`;
    return `${chalk.hex(colors.textDim)(row.label.padEnd(labelWidth, ' '))}  ${bar}  ${pct}${reset}`;
  }

  /**
   * Remaining quota rows (after the first on line 2), then the "Plan usage ·
   * updated HH:MM:SS" stamp at the bottom. Empty array when no usage block.
   */
  private renderUsageLines(width: number, usage: UsageBlock | null): string[] {
    if (usage === null) return [];
    const colors = currentTheme.palette;
    const lines = usage.rows.slice(1).map((row) => this.renderUsageRow(row, usage.labelWidth));
    lines.push(
      chalk.hex(colors.primary).bold('Plan usage') +
        chalk.hex(colors.textMuted)(` · updated ${formatClockTime(usage.fetchedAt)}`),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }

  /**
   * Rendered pieces per status-line slot. Empty-content slots (e.g. no goal,
   * outside a git repo) yield an empty list so composition just skips them.
   */
  private buildSlots(colors: ColorPalette): Record<string, string[]> {
    const state = this.state;
    const slots: Record<string, string[]> = {
      mode: [],
      goal: [],
      model: [],
      usage: [],
      tasks: [],
      cwd: [],
      git: [],
      tips: [],
    };

    {
      const { primary, pair } = tipsForIndex(currentTipIndex());
      const tip = pair ?? primary;
      if (tip) slots['tips'] = [chalk.hex(colors.textMuted)(tip)];
    }

    const modes: string[] = [];
    if (state.permissionMode === 'auto') modes.push(chalk.hex(colors.warning).bold(PERMISSION_MODE_DISPLAY_NAMES.auto));
    if (state.permissionMode === 'yolo') modes.push(chalk.hex(colors.warning).bold(PERMISSION_MODE_DISPLAY_NAMES.yolo));
    if (state.planMode) modes.push(chalk.hex(colors.primary).bold('plan'));
    if (state.swarmMode) modes.push(chalk.hex(colors.accent).bold('swarm'));
    if (state.towerMode) modes.push(chalk.hex(colors.accent).bold('tower'));
    if (modes.length > 0) slots['mode'] = [modes.join(' ')];

    const goalBadge = formatGoalBadge(state.goal, colors, this.goalWallClockMs(state.goal));
    if (goalBadge !== null) slots['goal'] = [goalBadge];

    const model = modelDisplayName(state);
    if (model) {
      const effort = state.thinkingEffort;
      const rawCurrentModel = state.availableModels[state.model];
      const currentModel =
        rawCurrentModel === undefined ? undefined : effectiveModelAlias(rawCurrentModel);
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
      slots['model'] = [renderedModelLabel];
    }

    // Managed-usage quota badge (weekly plan limit). Opt-in via a `usage`
    // entry in status_line.items; the full breakdown renders on lines 2+.
    const usage = state.managedUsage;
    if (usage !== undefined && usage !== null && usage.summary !== null) {
      const ratio = usage.summary.limit > 0 ? usage.summary.used / usage.summary.limit : 0;
      const pct = usagePercentFromRatio(ratio);
      const label = usage.summary.label;
      const severity = ratioSeverity(ratio);
      const usageColor =
        severity === 'danger'
          ? colors.error
          : severity === 'warn'
            ? colors.warning
            : colors.textDim;
      slots['usage'] = [chalk.hex(usageColor)(`${label}: ${String(pct)}%`)];
    }

    // Background-task badges. `bash-*` tasks (shell processes) and `agent-*`
    // tasks (background subagents) stay separate so the user can tell them
    // apart at a glance.
    const taskBadges: string[] = [];
    if (this.backgroundBashTaskCount > 0) {
      const noun = this.backgroundBashTaskCount === 1 ? 'task' : 'tasks';
      taskBadges.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundBashTaskCount)} ${noun} running]`),
      );
    }
    if (this.backgroundAgentCount > 0) {
      const noun = this.backgroundAgentCount === 1 ? 'agent' : 'agents';
      taskBadges.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundAgentCount)} ${noun} running]`),
      );
    }
    slots['tasks'] = taskBadges;

    const cwd = shortenCwd(state.workDir);
    if (cwd) slots['cwd'] = [chalk.hex(colors.textDim)(cwd)];

    const git = this.gitCache.getStatus();
    if (git !== null) slots['git'] = [formatFooterGitBadge(git, colors)];

    return slots;
  }

  private statusLinePayload(): StatusLinePayload {
    const state = this.state;
    const usage = state.managedUsage;
    return {
      model: modelDisplayName(state),
      cwd: state.workDir,
      gitBranch: this.gitCache.getStatus()?.branch ?? null,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
      contextUsage: state.contextUsage,
      contextTokens: state.contextTokens,
      maxContextTokens: state.maxContextTokens,
      sessionId: state.sessionId,
      version: state.version,
      managedUsage:
        usage !== undefined && usage !== null
          ? {
              summary: usage.summary,
              limits: usage.limits,
              fetchedAt: usage.fetchedAt,
            }
          : null,
    };
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
