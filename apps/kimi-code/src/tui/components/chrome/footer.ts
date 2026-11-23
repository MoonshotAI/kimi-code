import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { effectiveModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { ALL_TIPS, TRANSCRIPT_GROUPING_TIP, type ToolbarTip } from '#/tui/constant/tips';
import type { TodoItem } from '#/tui/components/messages/tool-renderers/todo';
import { transcriptGroupingActive } from '#/tui/config';
import { isRainbowDancing, renderDanceFooterModel } from '#/tui/easter-eggs/dance';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, EnvironmentSlotState } from '#/tui/types';
import { PERMISSION_MODE_DISPLAY_NAMES } from '#/tui/utils/permission-mode';
import { sessionWorkDir } from '#/tui/utils/session-work-dir';
import { SpinnerTicker } from '#/tui/utils/spinner-ticker';
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
  type GitStatusSource,
} from '#/utils/git/git-status';
import {
  formatTokenCount,
  usagePercent,
  usagePercentFromRatio,
} from '#/utils/usage/usage-format';

export type ToolOutputExpandHint = 'expand' | 'collapse';

const DEFAULT_STATUS_LINE_ITEMS = ['mode', 'goal', 'model', 'tasks', 'environment', 'cwd', 'git'] as const;

const MAX_CWD_SEGMENTS = 3;
const MAX_ENVIRONMENT_REASON_WIDTH = 40;
const MAX_TODO_TITLE_WIDTH = 32;
const GOAL_TIMER_INTERVAL_MS = 1_000;

const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = ' | ';

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
const GROUPING_ROTATION: readonly ToolbarTip[] = buildWeightedTips([
  ...ALL_TIPS,
  TRANSCRIPT_GROUPING_TIP,
]);

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

function showsGroupingTip(state: AppState, fullscreen: boolean): boolean {
  return transcriptGroupingActive({ ...state.transcript, fullscreen });
}

function tipsForIndex(
  index: number,
  groupingTip: boolean,
): { primary: string; pair: string | null } {
  const rotation = groupingTip ? GROUPING_ROTATION : ROTATION;
  const n = rotation.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = rotation[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = rotation[(offset + 1) % n]!;
  if (next.solo || next.text === current.text) return { primary: current.text, pair: null };
  return { primary: current.text, pair: current.text + TIP_SEPARATOR + next.text };
}

function formatGoalBadge(
  goal: AppState['goal'],
  colors: ColorPalette,
  wallClockMs?: number,
): string | null {
  if (goal === null || goal === undefined) return null;
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

function formatTodoBadge(todos: readonly TodoItem[] | null, colors: ColorPalette): string | null {
  if (todos === null || todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === 'done').length;
  const counts = `[todo ${String(done)}/${String(todos.length)}`;
  const current =
    todos.find((todo) => todo.status === 'in_progress') ??
    todos.find((todo) => todo.status === 'pending');
  if (current === undefined) return chalk.hex(colors.primary)(`${counts}]`);
  const title = truncateToWidth(current.title, MAX_TODO_TITLE_WIDTH, '…');
  return chalk.hex(colors.primary)(`${counts} · ${title}]`);
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

function isRemoteEnvironment(environment: AppState['environment']): environment is EnvironmentSlotState {
  return environment !== undefined && environment.environmentId !== 'local';
}

function shortenCwd(path: string, home: string | undefined): string {
  if (!path) return path;
  let work = path;
  if (home !== undefined && home.length > 0 && path === home) {
    return '~';
  }
  if (home !== undefined && home.length > 0 && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

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

export interface FooterGitBinding {
  readonly key: string;
  readonly source: GitStatusSource;
}

export class FooterComponent implements Component {
  private state: AppState;
  private readonly onRefresh: () => void;
  private readonly runningFullscreen: boolean;
  private gitBinding: ((state: AppState) => FooterGitBinding | null) | null = null;
  private gitCache: GitStatusCache | null = null;
  private gitCacheKey: string | null = null;
  private transientHint: string | null = null;
  private warningHint: string | null = null;
  private expandHintProvider: (() => ToolOutputExpandHint | null) | null = null;
  private goalSnapshotKey: string | null = null;
  private goalObservedAtMs = Date.now();
  private goalTimer: ReturnType<typeof setInterval> | null = null;
  private readonly environmentSpinner = new SpinnerTicker(() => {
    this.onRefresh();
  });
  private statusLineRunner: StatusLineCommandRunner | null = null;
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(state: AppState, onRefresh: () => void = () => {}, runningFullscreen = false) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.runningFullscreen = runningFullscreen;
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncEnvironmentSpinner(state.environment);
    this.syncStatusLineRunner(state);
  }

  setState(state: AppState): void {
    this.syncGitCache(state);
    if (state.environment?.status === 'ready' && this.state.environment?.status !== 'ready') {
      this.gitCache?.refresh();
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncEnvironmentSpinner(state.environment);
    this.syncStatusLineRunner(state);
    this.state = state;
  }

  setGitBinding(resolve: (state: AppState) => FooterGitBinding | null): void {
    this.gitBinding = resolve;
    this.syncGitCache(this.state);
  }

  private syncGitCache(state: AppState): void {
    const binding = this.gitBinding?.(state) ?? null;
    const key = binding?.key ?? null;
    if (key === this.gitCacheKey) return;
    this.gitCache?.dispose();
    this.gitCacheKey = key;
    this.gitCache = binding === null ? null : createGitStatusCache(binding.source, { onChange: this.onRefresh });
  }

  private syncStatusLineRunner(state: AppState): void {
    const command = state.statusLine?.command ?? null;
    if (command === null) {
      this.statusLineRunner?.dispose();
      this.statusLineRunner = null;
      return;
    }
    if (this.statusLineRunner?.command !== command) {
      this.statusLineRunner?.dispose();
      this.statusLineRunner = new StatusLineCommandRunner(command, this.onRefresh);
    }
  }

  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
  }

  getTransientHint(): string | null {
    return this.transientHint;
  }

  setWarningHint(hint: string | null): void {
    this.warningHint = hint;
  }

  setExpandHintProvider(provider: () => ToolOutputExpandHint | null): void {
    this.expandHintProvider = provider;
  }

  setBackgroundCounts(counts: { bashTasks: number; agentTasks: number }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
  }

  refreshGitStatus(): void {
    this.gitCache?.refresh();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const colors = currentTheme.palette;
    const state = this.state;

    let line1: string;
    let customLine: string | null = null;
    if (this.statusLineRunner !== null) {
      this.statusLineRunner.maybeRefresh(this.statusLinePayload());
      customLine = this.statusLineRunner.current();
    }

    if (customLine !== null) {
      line1 = chalk.hex(colors.text)(customLine);
    } else {
      const slots = this.buildSlots(colors);
      const configured = this.state.statusLine?.items ?? null;
      const order: readonly string[] = configured ?? DEFAULT_STATUS_LINE_ITEMS;
      const composeLeft = (withTips: boolean): string => {
        const left: string[] = [];
        for (const slot of order) {
          if (!withTips && slot === 'tips') continue;
          const pieces = slots[slot as keyof typeof slots];
          if (pieces !== undefined) left.push(...pieces);
        }
        return left.join('  ');
      };
      let leftLine = composeLeft(true);
      let leftWidth = visibleWidth(leftLine);

      const tipsInline = order.includes('tips');
      const shortcut = this.expandShortcut();
      if (tipsInline && shortcut !== null && leftWidth + 2 + visibleWidth(shortcut) > width) {
        leftLine = composeLeft(false);
        leftWidth = visibleWidth(leftLine);
      }
      const showTips = !tipsInline && (configured === null || configured.includes('tips'));
      const tipCandidates: string[] = [];
      if (showTips) {
        const { primary, pair } = tipsForIndex(
          currentTipIndex(),
          showsGroupingTip(state, this.runningFullscreen),
        );
        if (pair) tipCandidates.push(pair);
        if (primary) tipCandidates.push(primary);
      }
      const remaining = Math.max(0, width - leftWidth - 2);
      const rightText = this.buildRightText(tipCandidates, remaining, colors);

      if (rightText.length > 0) {
        const pad = width - leftWidth - visibleWidth(rightText);
        line1 = leftLine + ' '.repeat(Math.max(0, pad)) + rightText;
      } else if (leftWidth <= width) {
        line1 = leftLine;
      } else {
        line1 = truncateToWidth(leftLine, width, '…');
      }
    }

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
      const shortcut = customLine !== null ? this.expandShortcut() : null;
      const left =
        shortcut !== null && visibleWidth(shortcut) + 1 + contextWidth <= width
          ? chalk.hex(colors.textDim)(shortcut)
          : '';
      const leftPad = Math.max(0, width - visibleWidth(left) - contextWidth);
      line2 = left + ' '.repeat(leftPad) + chalk.hex(colors.text)(contextText);
    }

    return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
  }

  private expandShortcut(): string | null {
    const hint = this.expandHintProvider?.() ?? null;
    return hint === null ? null : `ctrl+o ${hint}`;
  }

  private buildRightText(tips: readonly string[], remaining: number, colors: ColorPalette): string {
    const shortcut = this.expandShortcut();
    if (shortcut === null) {
      const tip = tips.find((candidate) => visibleWidth(candidate) <= remaining);
      return tip === undefined ? '' : chalk.hex(colors.textMuted)(tip);
    }
    for (const tip of tips) {
      if (visibleWidth(`${shortcut}${TIP_SEPARATOR}${tip}`) <= remaining) {
        return (
          chalk.hex(colors.textDim)(shortcut) + chalk.hex(colors.textMuted)(`${TIP_SEPARATOR}${tip}`)
        );
      }
    }
    return visibleWidth(shortcut) <= remaining ? chalk.hex(colors.textDim)(shortcut) : '';
  }

  private buildSlots(colors: ColorPalette): Record<string, string[]> {
    const state = this.state;
    const slots: Record<string, string[]> = {
      mode: [],
      goal: [],
      model: [],
      tasks: [],
      todos: [],
      environment: [],
      cwd: [],
      git: [],
      tips: [],
    };

    {
      const { primary, pair } = tipsForIndex(
        currentTipIndex(),
        showsGroupingTip(state, this.runningFullscreen),
      );
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

    const todoBadge = formatTodoBadge(state.todos ?? null, colors);
    if (todoBadge !== null) slots['todos'] = [todoBadge];

    const environment = state.environment;
    const remote = isRemoteEnvironment(environment);
    if (remote) {
      const tone =
        environment.status === 'disconnected'
          ? colors.error
          : environment.status === 'ready' || environment.status === 'pending'
            ? colors.textDim
            : colors.warning;
      const label = environment.environmentId;
      const reason =
        environment.status === 'disconnected' && environment.connectError !== undefined
          ? environment.connectError.split('\n', 1)[0]
          : undefined;
      const spinner =
        environment.status === 'connecting' ? `${this.environmentSpinner.current} ` : '';
      slots['environment'] = [
        chalk.hex(tone)(
          reason === undefined
            ? `${spinner}${label}`
            : `${spinner}${label} (${truncateToWidth(reason, MAX_ENVIRONMENT_REASON_WIDTH, '…')})`,
        ),
      ];
    }

    const bindingCwd = remote ? environment.cwd : undefined;
    const cwd =
      bindingCwd !== undefined
        ? shortenCwd(bindingCwd, undefined)
        : shortenCwd(state.workDir, process.env['HOME']);
    if (cwd) slots['cwd'] = [chalk.hex(colors.textDim)(cwd)];

    const git = this.gitCache?.getStatus() ?? null;
    if (git !== null) slots['git'] = [formatFooterGitBadge(git, colors)];

    return slots;
  }

  private statusLinePayload(): StatusLinePayload {
    const state = this.state;
    return {
      model: modelDisplayName(state),
      cwd: sessionWorkDir(state),
      gitBranch: this.gitCache?.getStatus()?.branch ?? null,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
      contextUsage: state.contextUsage,
      contextTokens: state.contextTokens,
      maxContextTokens: state.maxContextTokens,
      sessionId: state.sessionId,
      version: state.version,
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

  private syncEnvironmentSpinner(environment: AppState['environment']): void {
    const connecting =
      environment !== undefined &&
      environment.environmentId !== 'local' &&
      environment.status === 'connecting';
    if (connecting) {
      this.environmentSpinner.start();
    } else {
      this.environmentSpinner.stop();
    }
  }

  dispose(): void {
    this.gitCache?.dispose();
    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
    this.environmentSpinner.dispose();
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
