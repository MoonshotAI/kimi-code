/**
 * TasksBrowserApp — full-screen alt-screen takeover for browsing
 * background tasks. Three-pane layout (left task list, right top
 * detail, right bottom preview output) framed by a header row and
 * footer key hint.
 *
 * Mounted by `kimi-tui.ts` via container swap rather than `showOverlay`
 * — the main TUI's children are saved, cleared, and this component is
 * added as the sole child so it covers the entire screen. The
 * controller restores the children when the user exits.
 *
 * Data (tasks list, tail output) flows in via `setProps`; user actions
 * fire the `on*` callbacks back to the controller.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@moonshot-ai/kimi-code-sdk';
import chalk from 'chalk';

import { SELECT_POINTER } from '@/tui/constant/symbols';
import type { ColorPalette } from '@/tui/theme/colors';
import { printableChar } from '@/tui/utils/printable-key';

const ELLIPSIS = '…';

export type TasksFilter = 'all' | 'active';

export interface TasksBrowserProps {
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly filter: TasksFilter;
  readonly selectedTaskId: string | undefined;
  readonly tailOutput: string | undefined;
  readonly tailLoading: boolean;
  readonly flashMessage: string | undefined;
  readonly colors: ColorPalette;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleFilter: () => void;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  /** Fired when the user confirms a stop request via the inline `y` prompt. */
  readonly onStopConfirmed: (taskId: string) => void;
  /** Fired when the user presses Enter or O on a selected task. */
  readonly onOpenOutput: (taskId: string) => void;
  /** Fired when stop is requested on a task that cannot be stopped. */
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void;
}

const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed out',
  killed: 'killed',
  lost: 'lost',
};

/** Auto-cancel the inline stop confirmation after this many ms. */
const STOP_CONFIRM_TIMEOUT_MS = 5_000;

/** Minimum dimensions before we just print a "too small" message. */
const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

/** Hard caps so a tiny / huge terminal still gets a sensible left-column width. */
const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

function statusColor(colors: ColorPalette, status: BackgroundTaskStatus): string {
  switch (status) {
    case 'running':
      return colors.success;
    case 'completed':
      return colors.textMuted;
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return colors.error;
  }
}

function isTerminal(status: BackgroundTaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'killed' ||
    status === 'lost'
  );
}

function formatRelativeTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.floor(Math.max(0, Date.now() - ts) / 1000);
  if (diffSec < 60) return 'just now';
  const minutes = Math.floor(diffSec / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

/** Fit `line` into exactly `width` columns, even after CJK-edge truncation. */
function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

function visibleTasks(
  tasks: readonly BackgroundTaskInfo[],
  filter: TasksFilter,
): BackgroundTaskInfo[] {
  if (filter === 'all') return [...tasks];
  return tasks.filter((t) => !isTerminal(t.status));
}

function compareTasks(a: BackgroundTaskInfo, b: BackgroundTaskInfo): number {
  const aTerminal = isTerminal(a.status);
  const bTerminal = isTerminal(b.status);
  if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
  if (!aTerminal) return a.startedAt - b.startedAt;
  return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
}

interface StatusCounts {
  running: number;
  completed: number;
  terminalFailed: number;
}

function countByStatus(tasks: readonly BackgroundTaskInfo[]): StatusCounts {
  const counts: StatusCounts = { running: 0, completed: 0, terminalFailed: 0 };
  for (const t of tasks) {
    switch (t.status) {
      case 'running':
        counts.running += 1;
        break;
      case 'completed':
        counts.completed += 1;
        break;
      case 'failed':
      case 'timed_out':
      case 'killed':
      case 'lost':
        counts.terminalFailed += 1;
        break;
    }
  }
  return counts;
}

export class TasksBrowserApp extends Container implements Focusable {
  focused = false;

  private props: TasksBrowserProps;
  private readonly terminal: Terminal;
  private sortedVisible: BackgroundTaskInfo[];
  private selectedIndex = 0;
  private listScroll = 0;
  private pendingStopTaskId: string | undefined = undefined;
  private pendingStopTimer: NodeJS.Timeout | undefined = undefined;

  constructor(props: TasksBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.sortedVisible = visibleTasks(props.tasks, props.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
  }

  setProps(next: TasksBrowserProps): void {
    this.props = next;
    this.sortedVisible = visibleTasks(next.tasks, next.filter).toSorted(compareTasks);
    this.syncSelectionFromProps();
    if (this.pendingStopTaskId !== undefined) {
      const task = next.tasks.find((t) => t.taskId === this.pendingStopTaskId);
      if (task === undefined || isTerminal(task.status)) this.clearPendingStop();
    }
    this.invalidate();
  }

  private syncSelectionFromProps(): void {
    if (this.sortedVisible.length === 0) {
      this.selectedIndex = 0;
      this.listScroll = 0;
      return;
    }
    if (this.props.selectedTaskId !== undefined) {
      const idx = this.sortedVisible.findIndex((t) => t.taskId === this.props.selectedTaskId);
      if (idx !== -1) {
        this.selectedIndex = idx;
        return;
      }
    }
    if (this.selectedIndex >= this.sortedVisible.length) {
      this.selectedIndex = this.sortedVisible.length - 1;
    }
  }

  private clearPendingStop(): void {
    this.pendingStopTaskId = undefined;
    if (this.pendingStopTimer !== undefined) {
      clearTimeout(this.pendingStopTimer);
      this.pendingStopTimer = undefined;
    }
  }

  private emitSelect(): void {
    const task = this.sortedVisible[this.selectedIndex];
    if (task) this.props.onSelect(task.taskId);
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.pendingStopTaskId !== undefined) {
      if (k === 'y' || k === 'Y') {
        const taskId = this.pendingStopTaskId;
        this.clearPendingStop();
        this.props.onStopConfirmed(taskId);
        this.invalidate();
        return;
      }
      this.clearPendingStop();
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      if (this.sortedVisible.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.emitSelect();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      if (this.sortedVisible.length === 0) return;
      this.selectedIndex = Math.min(this.sortedVisible.length - 1, this.selectedIndex + 1);
      this.emitSelect();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab) || k === '\t') {
      this.props.onToggleFilter();
      return;
    }
    if (k === 'r' || k === 'R') {
      this.props.onRefresh();
      return;
    }
    if (k === 's' || k === 'S') {
      const task = this.sortedVisible[this.selectedIndex];
      if (task === undefined) return;
      if (isTerminal(task.status)) {
        this.props.onStopIgnored?.(task.taskId, 'terminal');
        return;
      }
      this.pendingStopTaskId = task.taskId;
      this.pendingStopTimer = setTimeout(() => {
        this.clearPendingStop();
        this.invalidate();
      }, STOP_CONFIRM_TIMEOUT_MS);
      this.invalidate();
      return;
    }
    if (k === 'o' || k === 'O' || matchesKey(data, Key.enter)) {
      const task = this.sortedVisible[this.selectedIndex];
      if (task) this.props.onOpenOutput(task.taskId);
      return;
    }
  }

  /**
   * Render the entire screen as `terminal.rows` lines of `width` cols.
   * Layout: header(1) + body(rows-2) + footer(1).
   */
  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return this.renderTooSmall(width, rows);
    }

    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyHeight = rows - 2;

    const listWidth = Math.max(
      LIST_COL_MIN,
      Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)),
    );
    const rightWidth = width - listWidth;

    const listFrame = this.renderListFrame(listWidth, bodyHeight);
    const rightFrames = this.renderRightStack(rightWidth, bodyHeight);

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push((listFrame[i] ?? ' '.repeat(listWidth)) + (rightFrames[i] ?? ' '.repeat(rightWidth)));
    }
    lines.push(footer);
    return lines;
  }

  // ── header / footer ──────────────────────────────────────────────────

  private renderHeader(width: number): string {
    const colors = this.props.colors;
    const title = chalk.hex(colors.primary).bold(' TASK BROWSER ');
    const filterText = chalk.hex(colors.textMuted)(
      ` filter=${this.props.filter === 'all' ? 'ALL' : 'ACTIVE'} `,
    );
    const counts = countByStatus(this.props.tasks);
    const countSegments: string[] = [];
    if (counts.running > 0)
      countSegments.push(chalk.hex(colors.success)(` ${String(counts.running)} running `));
    if (counts.completed > 0)
      countSegments.push(chalk.hex(colors.textDim)(` ${String(counts.completed)} completed `));
    if (counts.terminalFailed > 0)
      countSegments.push(
        chalk.hex(colors.error)(` ${String(counts.terminalFailed)} interrupted `),
      );
    const totals = chalk.hex(colors.textMuted)(` ${String(this.props.tasks.length)} total `);

    const composed = title + filterText + countSegments.join('') + totals;
    return fitExactly(composed, width);
  }

  private renderFooter(width: number): string {
    const colors = this.props.colors;
    const key = (text: string): string => chalk.hex(colors.primary).bold(text);
    const dim = (text: string): string => chalk.hex(colors.textMuted)(text);

    if (this.pendingStopTaskId !== undefined) {
      const warn = (text: string): string => chalk.hex(colors.warning).bold(text);
      const line =
        ` ${warn('Stop')} ${chalk.hex(colors.text)(this.pendingStopTaskId)}? ` +
        `${key('Y')} ${dim('confirm')}  ${key('N')}${dim('/')}${key('esc')} ${dim('cancel')} `;
      return fitExactly(line, width);
    }

    const parts = [
      ` ${key('↑↓')} ${dim('select')}`,
      `${key('Enter/O')} ${dim('output')}`,
      `${key('S')} ${dim('stop')}`,
      `${key('R')} ${dim('refresh')}`,
      `${key('Tab')} ${dim('filter')}`,
      `${key('Q/Esc')} ${dim('cancel')} `,
    ];
    const left = parts.join('  ');
    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = chalk.hex(colors.warning)(` ${flash} `);
      const total = visibleWidth(left) + visibleWidth(flashStyled);
      if (total <= width) {
        return left + ' '.repeat(width - total) + flashStyled;
      }
    }
    return fitExactly(left, width);
  }

  // ── frame primitive ──────────────────────────────────────────────────

  /**
   * Render a framed box: `┌─ Title ─┐` top, `│ <content> │` sides, `└─┘`
   * bottom. Result is exactly `width × height` cells. `content` is a
   * pre-rendered array of inner-width-sized lines; extra rows are padded.
   */
  private renderFrame(
    title: string,
    content: readonly string[],
    width: number,
    height: number,
  ): string[] {
    if (height < 2 || width < 4) {
      const out: string[] = [];
      for (let i = 0; i < height; i++) out.push(' '.repeat(width));
      return out;
    }
    const stroke = this.props.colors.primary;
    const innerWidth = width - 2;
    const innerHeight = height - 2;

    const titleStyled = chalk.hex(this.props.colors.textStrong).bold(title);
    const titleWidth = visibleWidth(titleStyled);
    const titleSegment = `─ ${titleStyled} `;
    const titleSegmentWidth = visibleWidth(titleSegment);
    const remainingDashes = Math.max(0, innerWidth - titleSegmentWidth);
    const topMid =
      titleWidth > 0 && titleSegmentWidth <= innerWidth
        ? chalk.hex(stroke)('─ ') +
          titleStyled +
          ' ' +
          chalk.hex(stroke)('─'.repeat(remainingDashes))
        : chalk.hex(stroke)('─'.repeat(innerWidth));
    const top = chalk.hex(stroke)('┌') + topMid + chalk.hex(stroke)('┐');
    const bottom = chalk.hex(stroke)('└' + '─'.repeat(innerWidth) + '┘');

    const lines: string[] = [top];
    for (let i = 0; i < innerHeight; i++) {
      const inner = content[i] ?? '';
      lines.push(chalk.hex(stroke)('│') + fitExactly(inner, innerWidth) + chalk.hex(stroke)('│'));
    }
    lines.push(bottom);
    return lines;
  }

  // ── left: task list frame ────────────────────────────────────────────

  private renderListFrame(width: number, height: number): string[] {
    const title = `Tasks [${this.props.filter}]`;
    const innerHeight = Math.max(0, height - 2);

    if (this.sortedVisible.length === 0) {
      const empty =
        this.props.filter === 'active'
          ? 'No active tasks. Tab = show all.'
          : 'No background tasks in this session.';
      const lines: string[] = [chalk.hex(this.props.colors.textMuted)(empty)];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame(title, lines, width, height);
    }

    this.adjustScroll(innerHeight);
    const start = this.listScroll;
    const window = this.sortedVisible.slice(start, start + innerHeight);

    const innerWidth = width - 2;
    const lines: string[] = [];
    for (const [vi, task] of window.entries()) {
      const index = start + vi;
      lines.push(this.renderListRow(task, index === this.selectedIndex, innerWidth));
    }
    while (lines.length < innerHeight) lines.push('');

    return this.renderFrame(title, lines, width, height);
  }

  private renderListRow(task: BackgroundTaskInfo, selected: boolean, innerWidth: number): string {
    const colors = this.props.colors;
    const pointer = selected ? `${SELECT_POINTER} ` : '  ';
    const pointerStyled = chalk.hex(selected ? colors.primary : colors.textDim)(pointer);

    const idColor = selected
      ? colors.primary
      : task.kind === 'agent'
        ? colors.success
        : task.kind === 'question'
          ? colors.warning
          : colors.accent;
    const idText = selected
      ? chalk.hex(idColor).bold(task.taskId)
      : chalk.hex(idColor)(task.taskId);
    const idPad = ' '.repeat(Math.max(0, 17 - task.taskId.length));

    const status = STATUS_LABEL[task.status];
    const statusBadge = chalk.hex(statusColor(colors, task.status))(status);

    const prefix = `${pointerStyled}${idText}${idPad} ${statusBadge}`;
    const prefixWidth = visibleWidth(prefix);
    const descBudget = Math.max(0, innerWidth - prefixWidth - 1);
    if (descBudget < 4) return fitExactly(prefix, innerWidth);

    const description =
      singleLine(task.description) ||
      (task.kind === 'process' ? singleLine(task.command) : '') ||
      '(no description)';
    const desc = truncateToWidth(description, descBudget, ELLIPSIS);
    return fitExactly(`${prefix} ${chalk.hex(colors.text)(desc)}`, innerWidth);
  }

  private adjustScroll(visibleRows: number): void {
    if (visibleRows <= 0) {
      this.listScroll = 0;
      return;
    }
    if (this.selectedIndex < this.listScroll) {
      this.listScroll = this.selectedIndex;
    } else if (this.selectedIndex >= this.listScroll + visibleRows) {
      this.listScroll = this.selectedIndex - visibleRows + 1;
    }
    const maxScroll = Math.max(0, this.sortedVisible.length - visibleRows);
    if (this.listScroll < 0) this.listScroll = 0;
    if (this.listScroll > maxScroll) this.listScroll = maxScroll;
  }

  // ── right: detail + preview stack ────────────────────────────────────

  private renderRightStack(width: number, height: number): string[] {
    // Detail gets ~8 rows (or 40% of body, whichever is larger). Preview
    // takes the rest. Both rendered as separate frames stacked vertically.
    const detailHeight = Math.max(8, Math.min(Math.floor(height * 0.4), height - 5));
    const previewHeight = height - detailHeight;
    return [
      ...this.renderDetailFrame(width, detailHeight),
      ...this.renderPreviewFrame(width, previewHeight),
    ];
  }

  private renderDetailFrame(width: number, height: number): string[] {
    const colors = this.props.colors;
    const innerHeight = Math.max(0, height - 2);
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      const empty = chalk.hex(colors.textMuted)('Select a task from the list.');
      const lines: string[] = [empty];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Detail', lines, width, height);
    }

    const label = (text: string): string => chalk.hex(colors.textMuted)(text.padEnd(14));
    const value = (text: string): string => chalk.hex(colors.text)(text);

    const lines: string[] = [
      `${label('Task ID:')}${value(task.taskId)}`,
      `${label('Status:')}${chalk.hex(statusColor(colors, task.status))(STATUS_LABEL[task.status])}`,
      `${label('Description:')}${value(singleLine(task.description) || '—')}`,
    ];
    if (task.kind === 'process' && task.command && task.command !== task.description) {
      lines.push(`${label('Command:')}${value(singleLine(task.command))}`);
    }
    if (task.kind === 'agent' && task.agentId !== undefined) {
      lines.push(`${label('Agent ID:')}${value(task.agentId)}`);
    }
    if (task.kind === 'agent' && task.subagentType !== undefined) {
      lines.push(`${label('Agent type:')}${value(task.subagentType)}`);
    }
    if (task.kind === 'question') {
      lines.push(`${label('Questions:')}${chalk.hex(colors.textMuted)(String(task.questionCount))}`);
      if (task.toolCallId !== undefined) {
        lines.push(`${label('Tool call:')}${chalk.hex(colors.textMuted)(task.toolCallId)}`);
      }
    }
    const timing =
      task.status === 'running'
        ? `running ${formatRelativeTime(task.startedAt)}`
        : task.endedAt !== null && task.endedAt !== undefined
          ? `finished ${formatRelativeTime(task.endedAt)}`
          : '';
    if (timing.length > 0) lines.push(`${label('Time:')}${chalk.hex(colors.textMuted)(timing)}`);
    if (task.kind === 'process' && task.pid > 0) {
      lines.push(`${label('Pid:')}${chalk.hex(colors.textMuted)(String(task.pid))}`);
    }
    if (task.kind === 'process' && task.exitCode !== null) {
      lines.push(`${label('Exit code:')}${chalk.hex(colors.textMuted)(String(task.exitCode))}`);
    }
    if (task.stopReason !== undefined && task.stopReason.length > 0) {
      lines.push(`${label('Reason:')}${chalk.hex(colors.textMuted)(task.stopReason)}`);
    }
    while (lines.length < innerHeight) lines.push('');
    return this.renderFrame('Detail', lines, width, height);
  }

  private renderPreviewFrame(width: number, height: number): string[] {
    const colors = this.props.colors;
    const innerHeight = Math.max(0, height - 2);
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      const lines: string[] = [chalk.hex(colors.textMuted)('No task selected.')];
      while (lines.length < innerHeight) lines.push('');
      return this.renderFrame('Preview Output', lines, width, height);
    }

    let body: string;
    if (this.props.tailLoading) body = '[loading…]';
    else if (this.props.tailOutput === undefined || this.props.tailOutput.length === 0)
      body = '[no output captured]';
    else body = this.props.tailOutput;

    const rawLines = body.split('\n');
    const tailLines = rawLines.slice(-innerHeight);
    const styled = tailLines.map((line) => chalk.hex(colors.textDim)(line));
    while (styled.length < innerHeight) styled.push('');
    return this.renderFrame('Preview Output', styled, width, height);
  }

  // ── too-small fallback ──────────────────────────────────────────────

  private renderTooSmall(width: number, rows: number): string[] {
    const lines: string[] = [];
    const msg = chalk.hex(this.props.colors.error)(
      `Terminal too small (need ≥ ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)})`,
    );
    lines.push(fitExactly(msg, width));
    for (let i = 1; i < rows; i++) lines.push(' '.repeat(width));
    return lines;
  }
}
