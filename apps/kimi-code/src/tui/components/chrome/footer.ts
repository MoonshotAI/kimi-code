/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout:
 *   Line 1: [yolo] [plan] <model> <cwd>  <git-badge>  <shortcut hints>
 *   Line 2: context: XX.X% (tokens/max)
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState } from '#/tui/types';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import { formatTokenCount, safeUsageRatio } from '#/utils/usage/usage-format';

const MAX_CWD_SEGMENTS = 3;

// Toolbar tips — rotates every 30s, shows 2 tips joined by " | " when
// space allows, falls back to 1.
const TIP_ROTATE_INTERVAL_MS = 30_000;
const TIP_SEPARATOR = ' | ';
const TOOLBAR_TIPS: readonly string[] = [
  'shift+tab: plan mode',
  '/yolo: toggle yolo',
  'ctrl+c: cancel',
  '/help: show commands',
  '/model: switch model',
  '@: mention files',
];

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

function twoRotatingTips(index: number): string {
  const n = TOOLBAR_TIPS.length;
  if (n === 0) return '';
  if (n === 1) return TOOLBAR_TIPS[0]!;
  const offset = ((index % n) + n) % n;
  return TOOLBAR_TIPS[offset]! + TIP_SEPARATOR + TOOLBAR_TIPS[(offset + 1) % n]!;
}

function oneRotatingTip(index: number): string {
  const n = TOOLBAR_TIPS.length;
  if (n === 0) return '';
  const offset = ((index % n) + n) % n;
  return TOOLBAR_TIPS[offset]!;
}

function shortenModel(model: string): string {
  if (!model) return model;
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  return model?.displayName ?? model?.model ?? state.model;
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

function safeUsage(usage: number): number {
  return safeUsageRatio(usage);
}

function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  const pct = `${(safeUsage(usage) * 100).toFixed(1)}%`;
  if (maxTokens && maxTokens > 0 && tokens !== undefined) {
    return `context: ${pct} (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `context: ${pct}`;
}

function formatTokenThroughput(tokensPerSecond: number | null): string | undefined {
  if (
    tokensPerSecond === null ||
    !Number.isFinite(tokensPerSecond) ||
    tokensPerSecond <= 0
  ) {
    return undefined;
  }

  const value =
    tokensPerSecond >= 100
      ? String(Math.round(tokensPerSecond))
      : tokensPerSecond >= 10
        ? tokensPerSecond.toFixed(1)
        : tokensPerSecond.toFixed(2);
  return `speed: ${value} tok/s`;
}

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.status)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  private state: AppState;
  private colors: ColorPalette;
  private readonly onGitStatusChange: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  /**
   * Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents). Either zero hides its
   * respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;

  constructor(state: AppState, colors: ColorPalette, onGitStatusChange: () => void = () => {}) {
    this.state = state;
    this.colors = colors;
    this.onGitStatusChange = onGitStatusChange;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onGitStatusChange });
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onGitStatusChange });
    }
    this.state = state;
  }

  setColors(colors: ColorPalette): void {
    this.colors = colors;
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
    const colors = this.colors;
    const state = this.state;

    // ── Line 1: mode badges + model + [N task(s) running] + [N agent(s) running] + cwd + git + hints ──
    const left: string[] = [];
    if (state.permissionMode === 'auto') left.push(chalk.hex(colors.warning).bold('auto'));
    if (state.permissionMode === 'yolo') left.push(chalk.hex(colors.warning).bold('yolo'));
    if (state.planMode) left.push(chalk.hex(colors.primary).bold('plan'));

    const model = shortenModel(modelDisplayName(state));
    if (model) {
      const thinkingLabel = state.thinking ? ' thinking' : '';
      left.push(chalk.hex(colors.text)(`${model}${thinkingLabel}`));
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
    if (cwd) left.push(chalk.hex(colors.status)(cwd));

    const git = this.gitCache.getStatus();
    if (git !== null) {
      left.push(formatFooterGitBadge(git, colors));
    }

    const leftLine = left.join('  ');
    const leftWidth = visibleWidth(leftLine);

    // Rotating hint tips, fill remaining space on line 1.
    const tipIndex = currentTipIndex();
    const tipTwo = twoRotatingTips(tipIndex);
    const tipOne = oneRotatingTip(tipIndex);
    const gap = 2;
    const remaining = Math.max(0, width - leftWidth - gap);
    let tipText = '';
    if (tipTwo && visibleWidth(tipTwo) <= remaining) {
      tipText = tipTwo;
    } else if (tipOne && visibleWidth(tipOne) <= remaining) {
      tipText = tipOne;
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

    // ── Line 2: transient hint / token speed (bottom-left) + context (right) ──
    const contextText = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const contextWidth = visibleWidth(contextText);
    let line2: string;
    const throughputText = formatTokenThroughput(state.outputTokensPerSecond);
    const leftStatus = this.transientHint ?? throughputText;
    if (leftStatus) {
      const maxHintWidth = Math.max(0, width - contextWidth - 1);
      const shownHint =
        visibleWidth(leftStatus) <= maxHintWidth
          ? leftStatus
          : truncateToWidth(leftStatus, maxHintWidth, '…');
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - contextWidth);
      const statusStyle =
        this.transientHint === null
          ? chalk.hex(colors.textMuted)
          : chalk.hex(colors.warning).bold;
      line2 =
        statusStyle(shownHint) + ' '.repeat(pad) + chalk.hex(colors.text)(contextText);
    } else {
      const leftPad = Math.max(0, width - contextWidth);
      line2 = ' '.repeat(leftPad) + chalk.hex(colors.text)(contextText);
    }

    return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
  }
}
