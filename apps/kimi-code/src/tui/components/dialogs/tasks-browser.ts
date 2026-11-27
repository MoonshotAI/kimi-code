import {
  Box,
  HStack,
  Key,
  matchesKey,
  type Component,
  type Focusable,
  type Terminal,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  VStack,
} from '@moonshot-ai/pi-tui';
import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ModelAlias,
} from '@moonshot-ai/kimi-code-sdk';

import {
  createInteractiveChildView,
  OverflowScrollView,
} from '#/tui/components/chrome/dock-section';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedMouse,
  handleActionBarMouse,
  rowIndexAt,
  type MouseActionSpan,
  type MouseRowRegion,
} from '#/tui/utils/mouse-hit-test';
import { printableChar } from '#/tui/utils/printable-key';
import { formatRelativeTime } from '#/tui/utils/relative-time';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';
import { isSettlingClick } from '#/tui/utils/terminal-focus';
import {
  fitViewerLine as fitExactly,
  formatActionHint,
  ScrollFrameBox,
  type ActionHintState,
  type ViewerFooterItem,
} from './framed-scroll-viewer';
import { paintHoverRow } from './hover-row';
import { modelDisplayName } from './model-selector';
import { STATUS_LABEL, statusColor } from './task-output-viewer';

const ELLIPSIS = '…';

export type TasksFilter = 'all' | 'active';

export interface TasksBrowserProps {
  readonly tasks: readonly BackgroundTaskInfo[];
  readonly filter: TasksFilter;
  readonly selectedTaskId: string | undefined;
  readonly tailOutput: string | undefined;
  readonly tailLoading: boolean;
  readonly flashMessage: string | undefined;
  readonly availableModels: Record<string, ModelAlias>;
  readonly onSelect: (taskId: string) => void;
  readonly onToggleFilter: () => void;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  readonly onStopConfirmed: (taskId: string) => void;
  readonly onOpenOutput: (taskId: string) => void;
  readonly onStopIgnored?: (taskId: string, reason: 'terminal') => void;
  readonly requestRender?: () => void;
}

const STOP_CONFIRM_TIMEOUT_MS = 5_000;

const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

const paintPrimary = (text: string): string => currentTheme.fg('primary', text);

function formatFrameTitle(title: string, innerWidth?: number): string | undefined {
  const titleStyled = currentTheme.boldFg('textStrong', title);
  const segmentWidth = visibleWidth(`─ ${titleStyled} `);
  if (innerWidth !== undefined && (visibleWidth(titleStyled) === 0 || segmentWidth > innerWidth)) {
    return undefined;
  }
  return currentTheme.fg('primary', '─ ') + titleStyled + ' ';
}

function computeListWidth(width: number): number {
  return Math.max(LIST_COL_MIN, Math.min(LIST_COL_MAX, Math.floor(width * LIST_COL_RATIO)));
}

function computeDetailHeight(bodyHeight: number): number {
  return Math.min(
    Math.max(10, Math.min(Math.floor(bodyHeight * 0.4), bodyHeight - 5)),
    Math.max(3, bodyHeight - 3),
  );
}

function isTerminal(status: BackgroundTaskStatus): boolean {
  return status !== 'running';
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export function isVisibleTask(task: BackgroundTaskInfo, filter: TasksFilter): boolean {
  if (task.detached === false) return task.kind === 'agent' && !isTerminal(task.status);
  return filter === 'all' || !isTerminal(task.status);
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

class SplitRow extends HStack {
  setFirstBasis(basis: number): void {
    const first = this.entries[0];
    if (first !== undefined) first.basis = basis;
  }
}

class SplitColumn extends VStack {
  setFirstBasis(basis: number): void {
    const first = this.entries[0];
    if (first !== undefined) first.basis = basis;
  }
}

type TasksHoverTarget =
  | { readonly zone: 'none' }
  | { readonly zone: 'header'; readonly index: number }
  | { readonly zone: 'footer'; readonly index: number }
  | { readonly zone: 'list'; readonly index: number };

export class TasksBrowserApp extends VStack implements Focusable {
  focused = false;
  capturesViewportInput = true;

  private props: TasksBrowserProps;
  private readonly terminal: Terminal;
  private sortedVisible: BackgroundTaskInfo[];
  private selectedIndex = 0;
  private displayedTaskId: string | undefined;
  private pendingEnsureSelection = false;
  private listScroll = 0;
  private pendingStopTaskId: string | undefined;
  private pendingStopTimer: NodeJS.Timeout | undefined;
  private readonly shownAt = Date.now();
  private hover: TasksHoverTarget = { zone: 'none' };

  private readonly leftBox: ScrollFrameBox;
  private readonly detailBox: ScrollFrameBox;
  private readonly previewBox: ScrollFrameBox;
  private readonly listScrollView: OverflowScrollView;
  private readonly detailScrollView: OverflowScrollView;
  private readonly previewScrollView: OverflowScrollView;
  private readonly middleRow: SplitRow;
  private readonly rightStack: SplitColumn;

  private taskRegions: readonly MouseRowRegion[] = [];
  private headerSpans: readonly MouseActionSpan[] = [];
  private footerSpans: readonly MouseActionSpan[] = [];

  constructor(props: TasksBrowserProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.sortedVisible = props.tasks
      .filter((task) => isVisibleTask(task, props.filter))
      .toSorted(compareTasks);
    this.syncSelectionFromProps();
    this.displayedTaskId = this.sortedVisible[this.selectedIndex]?.taskId;
    this.pendingEnsureSelection = this.selectedIndex > 0;

    const isTooSmall = (vp: { width: number; height: number }): boolean =>
      vp.width < MIN_WIDTH || vp.height < MIN_HEIGHT;
    const isNormal = (vp: { width: number; height: number }): boolean => !isTooSmall(vp);

    const tooSmallView: Component = {
      render: (width) => this.renderTooSmall(width, Math.max(1, this.terminal.rows)),
      invalidate: () => {},
    };

    const clearHover = (): boolean => this.setHover({ zone: 'none' });

    const headerView = createInteractiveChildView(
      this,
      (width) => {
        const listWidth = computeListWidth(width);
        const rightWidth = Math.max(4, width - listWidth);
        this.middleRow.setFirstBasis(listWidth);
        const bodyHeight = Math.max(4, this.terminal.rows - 2);
        this.rightStack.setFirstBasis(computeDetailHeight(bodyHeight));
        this.leftBox.setTitle(formatFrameTitle(`Tasks [${this.props.filter}]`, listWidth - 2));
        this.detailBox.setTitle(formatFrameTitle('Detail', rightWidth - 2));
        this.previewBox.setTitle(formatFrameTitle('Preview Output', rightWidth - 2));
        return [this.renderHeader(width)];
      },
      (event) =>
        handleActionBarMouse({
          event,
          focused: this.focused,
          shownAt: this.shownAt,
          spans: this.headerSpans,
          onHover: (index) =>
            this.setHover(index === undefined ? { zone: 'none' } : { zone: 'header', index }),
        }),
    );

    const listBodyView = createInteractiveChildView(
      this,
      (innerWidth) => this.buildListLines(Math.max(1, innerWidth)),
      (event) => this.handleListMouse(event),
    );
    this.listScrollView = new OverflowScrollView(listBodyView, {
      onScroll: () => {
        this.pendingEnsureSelection = false;
      },
      onLayout: () => {
        if (!this.pendingEnsureSelection) return;
        this.pendingEnsureSelection = false;
        this.ensureSelectedTaskVisibleInScrollView();
      },
    });
    this.leftBox = new ScrollFrameBox(this.listScrollView, {
      borderColor: paintPrimary,
      title: formatFrameTitle(`Tasks [${props.filter}]`),
      onPointerEnter: clearHover,
    });

    const detailBodyView: Component = {
      render: (innerWidth) =>
        this.buildDetailLines().map((line) => fitExactly(line, Math.max(1, innerWidth))),
      invalidate: () => {},
    };
    this.detailScrollView = new OverflowScrollView(detailBodyView);
    this.detailBox = new ScrollFrameBox(this.detailScrollView, {
      borderColor: paintPrimary,
      title: formatFrameTitle('Detail'),
      onPointerEnter: clearHover,
    });

    const previewBodyView: Component = {
      render: (innerWidth) =>
        this.buildPreviewLines().map((line) => fitExactly(line, Math.max(1, innerWidth))),
      invalidate: () => {},
    };
    this.previewScrollView = new OverflowScrollView(previewBodyView, { follow: 'end' });
    this.previewBox = new ScrollFrameBox(this.previewScrollView, {
      borderColor: paintPrimary,
      title: formatFrameTitle('Preview Output'),
      onPointerEnter: clearHover,
    });

    this.rightStack = new SplitColumn();
    this.rightStack.addChild(this.detailBox, { basis: 10, shrink: 1, minSize: 3 });
    this.rightStack.addChild(this.previewBox, { basis: 0, grow: 1, shrink: 1, minSize: 3 });

    this.middleRow = new SplitRow();
    this.middleRow.addChild(this.leftBox, { basis: 38, shrink: 0 });
    this.middleRow.addChild(this.rightStack, { basis: 0, grow: 1, shrink: 1 });

    const footerView = createInteractiveChildView(
      this,
      (width) => [this.renderFooter(width)],
      (event) =>
        handleActionBarMouse({
          event,
          focused: this.focused,
          shownAt: this.shownAt,
          spans: this.footerSpans,
          onHover: (index) =>
            this.setHover(index === undefined ? { zone: 'none' } : { zone: 'footer', index }),
        }),
    );

    this.addChild(tooSmallView, { basis: 0, grow: 1, shrink: 1, visible: isTooSmall });
    this.addChild(headerView, { basis: 1, shrink: 0, visible: isNormal });
    this.addChild(this.middleRow, { basis: 0, grow: 1, shrink: 1, minSize: 4, visible: isNormal });
    this.addChild(footerView, { basis: 1, shrink: 0, visible: isNormal });
  }

  setProps(next: TasksBrowserProps): void {
    const prevSelectedIndex = this.selectedIndex;
    const prevTaskId = this.displayedTaskId;
    const prevTail = this.props.tailOutput;
    this.props = next;
    this.sortedVisible = next.tasks
      .filter((task) => isVisibleTask(task, next.filter))
      .toSorted(compareTasks);
    this.syncSelectionFromProps();
    if (this.hover.zone === 'list' && this.hover.index >= this.sortedVisible.length) {
      this.hover = { zone: 'none' };
    }
    const nextTaskId = this.sortedVisible[this.selectedIndex]?.taskId;
    this.displayedTaskId = nextTaskId;
    if (nextTaskId !== prevTaskId) {
      this.detailScrollView.scrollToStart();
      this.previewScrollView.scrollToEnd();
    } else if (next.tailOutput !== prevTail && this.previewScrollView.isFollowingEnd) {
      this.previewScrollView.scrollToEnd();
    }
    if (nextTaskId !== prevTaskId || this.selectedIndex !== prevSelectedIndex) {
      this.pendingEnsureSelection = true;
      this.ensureSelectedTaskVisibleInScrollView();
    }
    if (this.pendingStopTaskId !== undefined) {
      const task = next.tasks.find((t) => t.taskId === this.pendingStopTaskId);
      if (task === undefined || isTerminal(task.status)) this.clearPendingStop();
    }
    this.invalidate();
  }

  private setHover(next: TasksHoverTarget): boolean {
    if (
      this.hover.zone === next.zone &&
      (next.zone === 'none' || (this.hover.zone !== 'none' && this.hover.index === next.index))
    ) {
      return false;
    }
    this.hover = next;
    this.invalidate();
    return true;
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
    if (this.hover.zone === 'footer' || this.hover.zone === 'header') {
      this.hover = { zone: 'none' };
    }
    if (this.pendingStopTimer !== undefined) {
      clearTimeout(this.pendingStopTimer);
      this.pendingStopTimer = undefined;
    }
  }

  private confirmPendingStop(): void {
    const taskId = this.pendingStopTaskId;
    if (taskId === undefined) return;
    this.clearPendingStop();
    this.props.onStopConfirmed(taskId);
    this.invalidate();
    this.props.requestRender?.();
  }

  private requestStopSelected(): void {
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined || task.detached === false) return;
    if (isTerminal(task.status)) {
      this.props.onStopIgnored?.(task.taskId, 'terminal');
      return;
    }
    this.pendingStopTaskId = task.taskId;
    if (this.hover.zone === 'footer' || this.hover.zone === 'header') {
      this.hover = { zone: 'none' };
    }
    this.pendingStopTimer = setTimeout(() => {
      this.clearPendingStop();
      this.invalidate();
      this.props.requestRender?.();
    }, STOP_CONFIRM_TIMEOUT_MS);
    this.invalidate();
    this.props.requestRender?.();
  }

  private emitSelect(): void {
    const task = this.sortedVisible[this.selectedIndex];
    if (task) this.props.onSelect(task.taskId);
  }

  private ensureSelectedTaskVisibleInScrollView(): void {
    if (this.listScrollView.viewportHeight <= 0) return;
    const { starts, total } = this.taskLineStarts();
    const start = starts[this.selectedIndex] ?? 0;
    const end = starts[this.selectedIndex + 1] ?? total;
    if (start < this.listScrollView.scrollTop) {
      this.listScrollView.scrollTo(start);
    } else if (end > this.listScrollView.scrollTop + this.listScrollView.viewportHeight) {
      this.listScrollView.scrollTo(Math.max(0, end - this.listScrollView.viewportHeight));
    }
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.pendingStopTaskId !== undefined) {
      if (k === 'y' || k === 'Y') {
        this.confirmPendingStop();
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
      this.stepSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.stepSelection(1);
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
      this.requestStopSelected();
      return;
    }
    if (k === 'o' || k === 'O' || matchesKey(data, Key.enter)) {
      const task = this.sortedVisible[this.selectedIndex];
      if (task) this.props.onOpenOutput(task.taskId);
    }
  }

  private stepSelection(delta: -1 | 1): void {
    if (this.sortedVisible.length === 0) return;
    const prevTaskId = this.sortedVisible[this.selectedIndex]?.taskId;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.sortedVisible.length - 1, this.selectedIndex + delta),
    );
    const nextTaskId = this.sortedVisible[this.selectedIndex]?.taskId;
    if (nextTaskId !== prevTaskId) {
      this.displayedTaskId = nextTaskId;
      this.detailScrollView.scrollToStart();
      this.previewScrollView.scrollToEnd();
    }
    this.pendingEnsureSelection = true;
    this.ensureSelectedTaskVisibleInScrollView();
    this.emitSelect();
    this.invalidate();
  }

  private handleListMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedMouse(event);
    if (event.type === 'wheel') return undefined;
    if (this.pendingStopTaskId !== undefined) {
      if (event.type === 'move') {
        return { handled: true, render: this.setHover({ zone: 'none' }) };
      }
      return undefined;
    }

    const index = rowIndexAt(this.taskRegions, event.y);
    if (event.type === 'move') {
      const next: TasksHoverTarget =
        index === undefined ? { zone: 'none' } : { zone: 'list', index };
      return { handled: true, render: this.setHover(next) };
    }
    if (event.button !== 'left' || index === undefined) return undefined;
    if (event.type === 'press') {
      return { handled: true, render: this.setHover({ zone: 'list', index }) };
    }
    if (event.type === 'click' && !isSettlingClick(this.shownAt)) {
      const task = this.sortedVisible[index];
      if (task === undefined) return { handled: true };
      const changedSelection = index !== this.selectedIndex || task.taskId !== this.displayedTaskId;
      this.selectedIndex = index;
      if (changedSelection) {
        this.displayedTaskId = task.taskId;
        this.detailScrollView.scrollToStart();
        this.previewScrollView.scrollToEnd();
        this.props.onSelect(task.taskId);
      }
      if ((event.clickCount ?? 1) >= 2) {
        this.props.onOpenOutput(task.taskId);
      }
      return { handled: true, render: true };
    }
    return { handled: true };
  }

  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) {
      return this.renderTooSmall(width, rows);
    }

    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyHeight = rows - 2;

    const listWidth = computeListWidth(width);
    const rightWidth = width - listWidth;

    const listFrame = this.renderListFrame(listWidth, bodyHeight);
    const rightFrames = this.renderRightStack(rightWidth, bodyHeight);

    const lines: string[] = [header];
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        (listFrame[i] ?? ' '.repeat(listWidth)) + (rightFrames[i] ?? ' '.repeat(rightWidth)),
      );
    }
    lines.push(footer);
    return lines;
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', ' TASK BROWSER ');
    const filterLabel = `filter=${this.props.filter === 'all' ? 'ALL' : 'ACTIVE'}`;
    const titleWidth = visibleWidth(title);
    const filterWidth = visibleWidth(` ${filterLabel} `);
    const filterInteractive = this.pendingStopTaskId === undefined && titleWidth < width;
    const filterHovered = filterInteractive && this.hover.zone === 'header' && this.hover.index === 0;
    const filterStyled = !filterInteractive
      ? currentTheme.fg('textMuted', filterLabel)
      : filterHovered
        ? currentTheme.underline(currentTheme.boldFg('textStrong', filterLabel))
        : currentTheme.fg('text', filterLabel);
    const filterText = ` ${filterStyled} `;
    this.headerSpans = filterInteractive
      ? [
          {
            start: titleWidth + 1,
            end: Math.min(width, titleWidth + filterWidth - 1),
            onClick: () => {
              this.props.onToggleFilter();
            },
          },
        ]
      : [];

    const visible = this.sortedVisible;
    const counts = countByStatus(visible);
    const countSegments: string[] = [];
    if (counts.running > 0)
      countSegments.push(currentTheme.fg('success', ` ${String(counts.running)} running `));
    if (counts.completed > 0)
      countSegments.push(currentTheme.fg('textDim', ` ${String(counts.completed)} completed `));
    if (counts.terminalFailed > 0)
      countSegments.push(
        currentTheme.fg('error', ` ${String(counts.terminalFailed)} interrupted `),
      );
    const totals = currentTheme.fg('textMuted', ` ${String(visible.length)} total `);

    const composed = title + filterText + countSegments.join('') + totals;
    return fitExactly(composed, width);
  }

  private renderFooter(width: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    if (this.pendingStopTaskId !== undefined) {
      const warn = (text: string): string => currentTheme.boldFg('warning', text);
      const prefix = ` ${warn('Stop')} ${currentTheme.fg('text', this.pendingStopTaskId)}? `;
      const prefixW = visibleWidth(prefix);
      const spans: MouseActionSpan[] = [];
      const confirmHovered = this.hover.zone === 'footer' && this.hover.index === 0;
      const confirmItem = formatActionHint('Y', 'confirm', confirmHovered ? 'hovered' : 'clickable');
      const confirmW = visibleWidth(confirmItem);
      if (prefixW < width) {
        spans.push({
          start: prefixW,
          end: Math.min(width, prefixW + confirmW),
          onClick: () => {
            this.confirmPendingStop();
          },
        });
      }
      const cancelStart = prefixW + confirmW + 2;
      const cancelHovered = this.hover.zone === 'footer' && this.hover.index === spans.length;
      const cancelBase = `${key('N')}${dim('/')}${key('esc')} ${
        cancelHovered ? currentTheme.boldFg('textStrong', 'cancel') : currentTheme.fg('text', 'cancel')
      }`;
      const cancelItem = cancelHovered ? currentTheme.underline(cancelBase) : cancelBase;
      const cancelW = visibleWidth(cancelItem);
      if (cancelStart < width) {
        spans.push({
          start: cancelStart,
          end: Math.min(width, cancelStart + cancelW),
          onClick: () => {
            this.clearPendingStop();
            this.invalidate();
            this.props.requestRender?.();
          },
        });
      }
      this.footerSpans = spans;
      return fitExactly(`${prefix}${confirmItem}  ${cancelItem} `, width);
    }

    const items: ViewerFooterItem[] = [
      { keys: '↑↓', label: 'select' },
      {
        keys: 'Enter/O',
        label: 'output',
        onClick: () => {
          const selected = this.sortedVisible[this.selectedIndex];
          if (selected) this.props.onOpenOutput(selected.taskId);
        },
      },
      { keys: 'R', label: 'refresh', onClick: () => this.props.onRefresh() },
      { keys: 'Tab', label: 'filter', onClick: () => this.props.onToggleFilter() },
      { keys: 'Q/Esc', label: 'cancel', onClick: () => this.props.onCancel() },
    ];
    const selectedTask = this.sortedVisible[this.selectedIndex];
    if (selectedTask !== undefined && selectedTask.detached !== false) {
      items.splice(2, 0, {
        keys: 'S',
        label: 'stop',
        onClick: () => this.requestStopSelected(),
      });
    }

    const spans: MouseActionSpan[] = [];
    let col = 1;
    const renderedParts: string[] = [];
    for (const item of items) {
      const spanIndex = spans.length;
      const state: ActionHintState =
        item.onClick === undefined
          ? 'passive'
          : this.hover.zone === 'footer' && this.hover.index === spanIndex
            ? 'hovered'
            : 'clickable';
      const text = formatActionHint(item.keys, item.label, state);
      const itemW = visibleWidth(text);
      if (item.onClick !== undefined && col < width) {
        spans.push({
          start: col,
          end: Math.min(width, col + itemW),
          onClick: item.onClick,
        });
      }
      renderedParts.push(text);
      col += itemW + 2;
    }
    this.footerSpans = spans;

    const left = ` ${renderedParts.join('  ')} `;
    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = currentTheme.fg('warning', ` ${flash} `);
      const total = visibleWidth(left) + visibleWidth(flashStyled);
      if (total <= width) {
        return left + ' '.repeat(width - total) + flashStyled;
      }
    }
    return fitExactly(left, width);
  }

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
    const innerWidth = width - 2;
    const innerHeight = height - 2;
    const paddedLines: string[] = [];
    for (let i = 0; i < innerHeight; i++) {
      paddedLines.push(fitExactly(content[i] ?? '', innerWidth));
    }
    const box = new Box({
      border: true,
      borderColor: paintPrimary,
      title: formatFrameTitle(title, innerWidth),
    });
    box.addChild({
      render: () => paddedLines,
      invalidate: () => {},
    });
    return [...box.render(width)];
  }

  private buildListLines(innerWidth: number): string[] {
    if (this.sortedVisible.length === 0) {
      this.taskRegions = [];
      const empty =
        this.props.filter === 'active'
          ? 'No active tasks. Tab = show all.'
          : 'No tasks in this session.';
      return [fitExactly(currentTheme.fg('textMuted', empty), innerWidth)];
    }

    const allLines: string[] = [];
    const regions: MouseRowRegion[] = [];
    const hoverBg = this.focused ? currentTheme.hoverBackground() : undefined;
    for (const [index, task] of this.sortedVisible.entries()) {
      const startRow = allLines.length;
      const hovered = this.hover.zone === 'list' && this.hover.index === index;
      const rowLine = this.renderListRow(task, index === this.selectedIndex, hovered, innerWidth);
      allLines.push(
        hovered && hoverBg !== undefined ? paintHoverRow(rowLine, innerWidth, hoverBg) : rowLine,
      );
      const modelText = this.agentModelText(task);
      if (modelText !== undefined) {
        const modelLine = fitExactly(this.renderModelRow(modelText, innerWidth), innerWidth);
        allLines.push(
          hovered && hoverBg !== undefined
            ? paintHoverRow(modelLine, innerWidth, hoverBg)
            : modelLine,
        );
      }
      regions.push({ start: startRow, end: allLines.length, index });
    }
    this.taskRegions = regions;
    return allLines;
  }

  private renderListFrame(width: number, height: number): string[] {
    const title = `Tasks [${this.props.filter}]`;
    const innerHeight = Math.max(0, height - 2);
    const innerWidth = Math.max(1, width - 2);
    const allLines = this.buildListLines(innerWidth);

    if (this.sortedVisible.length === 0) {
      return this.renderFrame(title, allLines, width, height);
    }

    this.adjustScroll(innerHeight);
    const lines = allLines.slice(this.listScroll, this.listScroll + innerHeight);
    return this.renderFrame(title, lines, width, height);
  }

  private renderListRow(
    task: BackgroundTaskInfo,
    selected: boolean,
    hovered: boolean,
    innerWidth: number,
  ): string {
    const pointer = selected ? `${SELECT_POINTER} ` : '  ';
    const pointerStyled = currentTheme.fg(selected ? 'primary' : 'textDim', pointer);

    const idColor = selected
      ? 'primary'
      : task.kind === 'agent'
        ? 'success'
        : task.kind === 'question'
          ? 'warning'
          : 'accent';
    const idText = selected
      ? currentTheme.boldFg(idColor, task.taskId)
      : hovered
        ? currentTheme.underline(currentTheme.boldFg(idColor, task.taskId))
        : currentTheme.fg(idColor, task.taskId);
    const idPad = ' '.repeat(Math.max(0, 17 - task.taskId.length));

    const status = STATUS_LABEL[task.status];
    const statusBadge = currentTheme.fg(statusColor(task.status), status);

    const prefix = `${pointerStyled}${idText}${idPad} ${statusBadge}`;
    const prefixWidth = visibleWidth(prefix);
    const descBudget = Math.max(0, innerWidth - prefixWidth - 1);
    if (descBudget < 4) return fitExactly(prefix, innerWidth);

    const description =
      singleLine(task.description) ||
      (task.kind === 'process' ? singleLine(task.command) : '') ||
      '(no description)';
    const desc = truncateToWidth(description, descBudget, ELLIPSIS);
    return fitExactly(
      `${prefix} ${currentTheme.fg(hovered && !selected ? 'textStrong' : 'text', desc)}`,
      innerWidth,
    );
  }

  private agentModelText(task: BackgroundTaskInfo): string | undefined {
    if (task.kind !== 'agent' || task.model === undefined) return undefined;
    const name = modelDisplayName(task.model, this.props.availableModels[task.model]);
    return name.length === 0 ? undefined : name;
  }

  private renderModelRow(text: string, innerWidth: number): string {
    const indent = '  ';
    const clipped = truncateToWidth(text, Math.max(0, innerWidth - indent.length), ELLIPSIS);
    return indent + currentTheme.fg('textMuted', clipped);
  }

  private taskLineStarts(): { starts: number[]; total: number } {
    const starts: number[] = [];
    let total = 0;
    for (const task of this.sortedVisible) {
      starts.push(total);
      total += this.agentModelText(task) === undefined ? 1 : 2;
    }
    return { starts, total };
  }

  private adjustScroll(visibleRows: number): void {
    if (visibleRows <= 0) {
      this.listScroll = 0;
      return;
    }
    const { starts, total } = this.taskLineStarts();
    const selectedStart = starts[this.selectedIndex] ?? 0;
    const selectedEnd = (starts[this.selectedIndex + 1] ?? total) - 1;
    if (selectedStart < this.listScroll) {
      this.listScroll = selectedStart;
    } else if (selectedEnd >= this.listScroll + visibleRows) {
      this.listScroll = selectedEnd - visibleRows + 1;
    }
    const maxScroll = Math.max(0, total - visibleRows);
    if (this.listScroll < 0) this.listScroll = 0;
    if (this.listScroll > maxScroll) this.listScroll = maxScroll;
  }

  private renderRightStack(width: number, height: number): string[] {
    const detailHeight = computeDetailHeight(height);
    const previewHeight = height - detailHeight;
    return [
      ...this.renderDetailFrame(width, detailHeight),
      ...this.renderPreviewFrame(width, previewHeight),
    ];
  }

  private buildDetailLines(): string[] {
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      return [currentTheme.fg('textMuted', 'Select a task from the list.')];
    }

    const label = (text: string): string => currentTheme.fg('textMuted', text.padEnd(14));
    const value = (text: string): string => currentTheme.fg('text', text);

    const lines: string[] = [
      `${label('Task ID:')}${value(task.taskId)}`,
      `${label('Status:')}${currentTheme.fg(statusColor(task.status), STATUS_LABEL[task.status])}`,
      `${label('Description:')}${value(singleLine(task.description) || '—')}`,
    ];
    if (task.detached === false) {
      lines.push(`${label('Mode:')}${value('Foreground')}`);
    }
    if (task.kind === 'process' && task.command && task.command !== task.description) {
      lines.push(`${label('Command:')}${value(singleLine(task.command))}`);
    }
    if (task.kind === 'agent' && task.agentId !== undefined) {
      lines.push(`${label('Agent ID:')}${value(task.agentId)}`);
    }
    if (task.kind === 'agent' && task.subagentType !== undefined) {
      lines.push(`${label('Agent type:')}${value(task.subagentType)}`);
    }
    if (task.kind === 'agent' && task.model !== undefined) {
      lines.push(`${label('Model:')}${value(this.agentModelText(task) ?? task.model)}`);
    }
    if (task.kind === 'agent' && task.thinkingEffort !== undefined) {
      lines.push(`${label('Effort:')}${value(task.thinkingEffort)}`);
    }
    if (task.kind === 'question') {
      lines.push(`${label('Questions:')}${currentTheme.fg('textMuted', String(task.questionCount))}`);
      if (task.toolCallId !== undefined) {
        lines.push(`${label('Tool call:')}${currentTheme.fg('textMuted', task.toolCallId)}`);
      }
    }
    const timing =
      task.status === 'running'
        ? `running ${formatRelativeTime(task.startedAt)}`
        : task.endedAt !== null && task.endedAt !== undefined
          ? `finished ${formatRelativeTime(task.endedAt)}`
          : '';
    if (timing.length > 0) lines.push(`${label('Time:')}${currentTheme.fg('textMuted', timing)}`);
    if (task.kind === 'process' && task.pid > 0) {
      lines.push(`${label('Pid:')}${currentTheme.fg('textMuted', String(task.pid))}`);
    }
    if (task.kind === 'process' && task.exitCode !== null) {
      lines.push(`${label('Exit code:')}${currentTheme.fg('textMuted', String(task.exitCode))}`);
    }
    if (task.stopReason !== undefined && task.stopReason.length > 0) {
      lines.push(`${label('Reason:')}${currentTheme.fg('textMuted', task.stopReason)}`);
    }
    return lines;
  }

  private renderDetailFrame(width: number, height: number): string[] {
    return this.renderFrame('Detail', this.buildDetailLines(), width, height);
  }

  private buildPreviewLines(): string[] {
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      return [currentTheme.fg('textMuted', 'No task selected.')];
    }

    let body: string;
    if (this.props.tailLoading) body = '[loading…]';
    else if (this.props.tailOutput === undefined || this.props.tailOutput.length === 0)
      body = '[no output captured]';
    else body = sanitizeShellOutput(this.props.tailOutput);

    return body.split('\n').map((line) => currentTheme.fg('textDim', line));
  }

  private renderPreviewFrame(width: number, height: number): string[] {
    const innerHeight = Math.max(0, height - 2);
    const allLines = this.buildPreviewLines();
    const tailLines = innerHeight > 0 ? allLines.slice(-innerHeight) : [];
    return this.renderFrame('Preview Output', tailLines, width, height);
  }

  private renderTooSmall(width: number, rows: number): string[] {
    const lines: string[] = [];
    const msg = currentTheme.fg(
      'error',
      `Terminal too small (need ≥ ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)})`,
    );
    lines.push(fitExactly(msg, width));
    for (let i = 1; i < rows; i++) lines.push(' '.repeat(width));
    return lines;
  }
}
