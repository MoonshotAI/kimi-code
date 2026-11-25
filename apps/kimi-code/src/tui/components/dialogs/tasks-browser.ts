import {
  HStack,
  Key,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Terminal,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ModelAlias,
} from '@moonshot-ai/kimi-code-sdk';

import {
  FramedScrollPane,
  ScreenTakeoverView,
  fitLineExactly,
  renderViewerFooter,
} from '#/tui/components/chrome/screen-takeover-view';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import {
  ListMouseTracker,
  SpanHitMap,
  focusOnUnfocusedClick,
  renderInlineSegments,
  type InlineSegment,
} from '#/tui/utils/mouse-regions';
import { printableChar } from '#/tui/utils/printable-key';
import { formatRelativeTime } from '#/tui/utils/relative-time';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

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
}

type HeaderAction = 'toggle-filter';

type FooterAction =
  | 'open'
  | 'stop'
  | 'refresh'
  | 'filter'
  | 'close'
  | 'confirm-stop'
  | 'cancel-stop';

const STOP_CONFIRM_TIMEOUT_MS = 5_000;

const MIN_WIDTH = 48;
const MIN_HEIGHT = 10;

const LIST_COL_MIN = 28;
const LIST_COL_MAX = 44;
const LIST_COL_RATIO = 0.32;

function isTerminal(status: BackgroundTaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'killed' ||
    status === 'lost'
  );
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function listColumnWidth(totalWidth: number): number {
  return Math.max(
    LIST_COL_MIN,
    Math.min(LIST_COL_MAX, Math.floor(totalWidth * LIST_COL_RATIO)),
  );
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

class SplitHStack extends HStack {
  constructor(left: Component, right: Component) {
    super([], { align: 'stretch' });
    this.addChild(left, {
      basis: LIST_COL_MIN,
      grow: 0,
      shrink: 0,
      minSize: LIST_COL_MIN,
      maxSize: LIST_COL_MAX,
      visible: (viewport) => {
        const entry = this.entries[0];
        if (entry !== undefined) entry.basis = listColumnWidth(viewport.width);
        return true;
      },
    });
    this.addChild(right, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
  }
}

export class TasksBrowserApp extends ScreenTakeoverView {
  private props: TasksBrowserProps;
  private sortedVisible: BackgroundTaskInfo[];
  private selectedIndex = 0;
  private pendingRevealSelection = true;
  private previewRawLines: string[];
  private pendingStopTaskId: string | undefined = undefined;
  private pendingStopTimer: NodeJS.Timeout | undefined = undefined;
  private readonly listTracker = new ListMouseTracker<string>();
  private readonly headerHits = new SpanHitMap<HeaderAction>();
  private readonly footerHits = new SpanHitMap<FooterAction>();
  private readonly listPane: FramedScrollPane;
  private readonly detailPane: FramedScrollPane;
  private readonly previewPane: FramedScrollPane;

  constructor(props: TasksBrowserProps, terminal: Terminal) {
    super(terminal, { minRows: 1 });
    this.props = props;
    this.sortedVisible = props.tasks
      .filter((task) => isVisibleTask(task, props.filter))
      .toSorted(compareTasks);
    this.syncSelectionFromProps();
    this.previewRawLines = this.buildPreviewLines(props);

    this.listPane = this.registerPane(
      new FramedScrollPane({
        padX: 0,
        follow: 'none',
        initialPosition: 'start',
        primary: false,
        title: () => `Tasks [${this.props.filter}]`,
        borderColor: () => currentTheme.palette.primary,
        renderContent: (width) => this.renderListContent(width),
        handleContentMouse: (event) => this.handleListMouse(event),
      }),
    );

    this.detailPane = this.registerPane(
      new FramedScrollPane({
        padX: 0,
        follow: 'none',
        initialPosition: 'start',
        primary: false,
        title: () => 'Detail',
        borderColor: () => currentTheme.palette.primary,
        renderContent: (width) => this.renderDetailContent(width),
      }),
    );

    this.previewPane = this.registerPane(
      new FramedScrollPane({
        padX: 0,
        follow: 'end',
        initialPosition: 'end',
        primary: true,
        title: () => 'Preview Output',
        borderColor: () => currentTheme.palette.primary,
        renderContent: (width) => this.renderPreviewContent(width),
      }),
    );

    const rightVStack = new VStack();
    rightVStack.addChild(this.detailPane, { basis: 10, grow: 40, minSize: 3 });
    rightVStack.addChild(this.previewPane, { basis: 15, grow: 60, minSize: 3 });

    const bodyHStack = new SplitHStack(this.listPane, rightVStack);

    const normalLayout = new VStack();
    normalLayout.addChild(
      this.ownedView(
        (width) => [this.renderHeader(width)],
        (event) => this.handleHeaderMouse(event),
      ),
      { basis: 1, shrink: 0 },
    );
    normalLayout.addChild(bodyHStack, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
    normalLayout.addChild(
      this.ownedView(
        (width) => [this.renderFooter(width)],
        (event) =>
          this.footerHits.handle(event, {
            focused: this.focused,
            onActivate: (action) => this.handleFooterAction(action),
          }),
      ),
      { basis: 1, shrink: 0 },
    );

    const tooSmallView = this.ownedView((width) => [
      fitLineExactly(
        currentTheme.fg(
          'error',
          `Terminal too small (need ≥ ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)})`,
        ),
        width,
      ),
    ]);

    this.addChild(tooSmallView, {
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 0,
      visible: (vp) => vp.width < MIN_WIDTH || vp.height < MIN_HEIGHT,
    });
    this.addChild(normalLayout, {
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 0,
      visible: (vp) => vp.width >= MIN_WIDTH && vp.height >= MIN_HEIGHT,
    });
  }

  setProps(next: TasksBrowserProps): void {
    const prevSelectedId = this.currentSelectedTaskId();
    const prevTailLoading = this.props.tailLoading;
    const prevTailOutput = this.props.tailOutput;
    this.props = next;
    this.sortedVisible = next.tasks
      .filter((task) => isVisibleTask(task, next.filter))
      .toSorted(compareTasks);
    this.syncSelectionFromProps();
    const nextSelectedId = this.currentSelectedTaskId();
    if (nextSelectedId !== prevSelectedId) {
      this.pendingRevealSelection = true;
      this.detailPane.scrollView.scrollToStart();
      this.previewPane.scrollView.scrollToEnd();
    }
    if (next.tailLoading !== prevTailLoading || next.tailOutput !== prevTailOutput) {
      this.previewRawLines = this.buildPreviewLines(next);
    }
    if (this.pendingStopTaskId !== undefined) {
      const task = next.tasks.find((t) => t.taskId === this.pendingStopTaskId);
      if (task === undefined || isTerminal(task.status)) this.clearPendingStop();
    }
    this.invalidate();
  }

  private currentSelectedTaskId(): string | undefined {
    return this.sortedVisible[this.selectedIndex]?.taskId;
  }

  private buildPreviewLines(props: TasksBrowserProps): string[] {
    if (props.tailLoading) return ['[loading…]'];
    if (props.tailOutput === undefined || props.tailOutput.length === 0) {
      return ['[no output captured]'];
    }
    return sanitizeShellOutput(props.tailOutput).split('\n');
  }

  private syncSelectionFromProps(): void {
    if (this.sortedVisible.length === 0) {
      this.selectedIndex = 0;
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

  private confirmPendingStop(): void {
    if (this.pendingStopTaskId === undefined) return;
    const taskId = this.pendingStopTaskId;
    this.clearPendingStop();
    this.props.onStopConfirmed(taskId);
    this.invalidate();
  }

  private cancelPendingStop(): void {
    if (this.pendingStopTaskId === undefined) return;
    this.clearPendingStop();
    this.invalidate();
  }

  private requestStopSelected(): void {
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined || task.detached === false) return;
    if (isTerminal(task.status)) {
      this.props.onStopIgnored?.(task.taskId, 'terminal');
      return;
    }
    this.pendingStopTaskId = task.taskId;
    this.footerHits.resetSettling();
    this.pendingStopTimer = setTimeout(() => {
      this.clearPendingStop();
      this.invalidate();
    }, STOP_CONFIRM_TIMEOUT_MS);
    this.invalidate();
  }

  private openSelectedOutput(): void {
    const task = this.sortedVisible[this.selectedIndex];
    if (task !== undefined) this.props.onOpenOutput(task.taskId);
  }

  private selectIndex(nextIndex: number): void {
    if (this.sortedVisible.length === 0) return;
    const prevTaskId = this.currentSelectedTaskId();
    this.selectedIndex = Math.max(0, Math.min(this.sortedVisible.length - 1, nextIndex));
    this.pendingRevealSelection = true;
    const nextTaskId = this.currentSelectedTaskId();
    if (nextTaskId !== prevTaskId) {
      this.detailPane.scrollView.scrollToStart();
      this.previewPane.scrollView.scrollToEnd();
    }
    if (nextTaskId !== undefined) this.props.onSelect(nextTaskId);
    this.invalidate();
  }

  private selectTaskById(taskId: string): void {
    const index = this.sortedVisible.findIndex((task) => task.taskId === taskId);
    if (index === -1) return;
    const prevTaskId = this.currentSelectedTaskId();
    this.selectedIndex = index;
    if (taskId !== prevTaskId) {
      this.pendingRevealSelection = true;
      this.detailPane.scrollView.scrollToStart();
      this.previewPane.scrollView.scrollToEnd();
      this.props.onSelect(taskId);
    } else if (this.props.selectedTaskId !== taskId) {
      this.props.onSelect(taskId);
    }
    this.invalidate();
  }

  private handleFooterAction(action: FooterAction): void {
    switch (action) {
      case 'open':
        this.openSelectedOutput();
        return;
      case 'stop':
        this.requestStopSelected();
        return;
      case 'refresh':
        this.props.onRefresh();
        return;
      case 'filter':
        this.props.onToggleFilter();
        return;
      case 'close':
        this.props.onCancel();
        return;
      case 'confirm-stop':
        this.confirmPendingStop();
        return;
      case 'cancel-stop':
        this.cancelPendingStop();
        return;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  private handleHeaderMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (this.pendingStopTaskId !== undefined) return undefined;
    return this.headerHits.handle(event, {
      focused: true,
      onActivate: () => {
        this.props.onToggleFilter();
      },
    });
  }

  private handleListMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (this.pendingStopTaskId !== undefined) return undefined;
    return this.listTracker.handle(event, {
      focused: true,
      onWheel: 'passthrough',
      onActivate: (taskId, mouseEvent) => {
        this.selectTaskById(taskId);
        if ((mouseEvent.clickCount ?? 1) >= 2) {
          this.props.onOpenOutput(taskId);
        }
      },
    });
  }

  handleInput(data: string): void {
    const k = printableChar(data);

    if (this.pendingStopTaskId !== undefined) {
      if (k === 'y' || k === 'Y') {
        this.confirmPendingStop();
        return;
      }
      this.cancelPendingStop();
      return;
    }

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.selectIndex(this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.selectIndex(this.selectedIndex + 1);
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
      this.openSelectedOutput();
      return;
    }
  }

  private renderHeader(width: number): string {
    const visible = this.sortedVisible;
    const counts = countByStatus(visible);
    const segments: InlineSegment<HeaderAction>[] = [
      { text: currentTheme.boldFg('primary', ' TASK BROWSER ') },
      {
        text: currentTheme.fg(
          'textMuted',
          ` filter=${this.props.filter === 'all' ? 'ALL' : 'ACTIVE'} `,
        ),
        value: 'toggle-filter',
      },
    ];
    if (counts.running > 0) {
      segments.push({ text: currentTheme.fg('success', ` ${String(counts.running)} running `) });
    }
    if (counts.completed > 0) {
      segments.push({
        text: currentTheme.fg('textDim', ` ${String(counts.completed)} completed `),
      });
    }
    if (counts.terminalFailed > 0) {
      segments.push({
        text: currentTheme.fg('error', ` ${String(counts.terminalFailed)} interrupted `),
      });
    }
    segments.push({ text: currentTheme.fg('textMuted', ` ${String(visible.length)} total `) });
    return renderViewerFooter(width, segments, '', this.headerHits);
  }

  private renderFooter(width: number): string {
    const safeWidth = Math.max(0, Math.floor(width));
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    if (this.pendingStopTaskId !== undefined) {
      const warn = (text: string): string => currentTheme.boldFg('warning', text);
      const segments: InlineSegment<FooterAction>[] = [
        { text: ` ${warn('Stop')} ${currentTheme.fg('text', this.pendingStopTaskId)}? ` },
        { text: `${key('Y')} ${dim('confirm')}`, value: 'confirm-stop' },
        { text: '  ' },
        { text: `${key('N')}${dim('/')}${key('esc')} ${dim('cancel')}`, value: 'cancel-stop' },
        { text: ' ' },
      ];
      return renderViewerFooter(safeWidth, segments, '', this.footerHits);
    }

    const segments: InlineSegment<FooterAction>[] = [
      { text: ' ' },
      { text: `${key('↑↓')} ${dim('select')}` },
      { text: '  ' },
      { text: `${key('Enter/O')} ${dim('output')}`, value: 'open' },
    ];
    const task = this.sortedVisible[this.selectedIndex];
    if (task !== undefined && task.detached !== false) {
      segments.push({ text: '  ' }, { text: `${key('S')} ${dim('stop')}`, value: 'stop' });
    }
    segments.push(
      { text: '  ' },
      { text: `${key('R')} ${dim('refresh')}`, value: 'refresh' },
      { text: '  ' },
      { text: `${key('Tab')} ${dim('filter')}`, value: 'filter' },
      { text: '  ' },
      { text: `${key('Q/Esc')} ${dim('cancel')}`, value: 'close' },
      { text: ' ' },
    );

    const { line, targets } = renderInlineSegments(segments, safeWidth);
    this.footerHits.reset();
    this.footerHits.addRow(0, targets);
    const flash = this.props.flashMessage;
    if (flash !== undefined && flash.length > 0) {
      const flashStyled = currentTheme.fg('warning', ` ${flash} `);
      const total = visibleWidth(line) + visibleWidth(flashStyled);
      if (total <= safeWidth) {
        return line + ' '.repeat(safeWidth - total) + flashStyled;
      }
    }
    return fitLineExactly(line, safeWidth);
  }

  private renderListContent(width: number): string[] {
    const innerWidth = Math.max(1, width);
    this.listTracker.reset();

    if (this.sortedVisible.length === 0) {
      this.pendingRevealSelection = false;
      const empty =
        this.props.filter === 'active'
          ? 'No active tasks. Tab = show all.'
          : 'No tasks in this session.';
      return [fitLineExactly(currentTheme.fg('textMuted', empty), innerWidth)];
    }

    const lines: string[] = [];
    for (const [index, task] of this.sortedVisible.entries()) {
      this.listTracker.track(lines, task.taskId, () => {
        lines.push(this.renderListRow(task, index === this.selectedIndex, innerWidth));
        const modelText = this.agentModelText(task);
        if (modelText !== undefined) {
          lines.push(this.renderModelRow(modelText, innerWidth));
        }
      });
    }

    if (this.pendingRevealSelection) {
      this.pendingRevealSelection = false;
      const selected = this.sortedVisible[this.selectedIndex];
      const range = selected === undefined ? undefined : this.listTracker.rangeOf(selected.taskId);
      if (range !== undefined) {
        this.listPane.scrollView.scrollIntoView(range.start, range.end, { silent: true });
      }
    }
    return lines;
  }

  private renderListRow(task: BackgroundTaskInfo, selected: boolean, innerWidth: number): string {
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
      : currentTheme.fg(idColor, task.taskId);
    const idPad = ' '.repeat(Math.max(0, 17 - task.taskId.length));

    const status = STATUS_LABEL[task.status];
    const statusBadge = currentTheme.fg(statusColor(task.status), status);

    const prefix = `${pointerStyled}${idText}${idPad} ${statusBadge}`;
    const prefixWidth = visibleWidth(prefix);
    const descBudget = Math.max(0, innerWidth - prefixWidth - 1);
    if (descBudget < 4) return fitLineExactly(prefix, innerWidth);

    const description =
      singleLine(task.description) ||
      (task.kind === 'process' ? singleLine(task.command) : '') ||
      '(no description)';
    const desc = truncateToWidth(description, descBudget, ELLIPSIS);
    return fitLineExactly(`${prefix} ${currentTheme.fg('text', desc)}`, innerWidth);
  }

  private agentModelText(task: BackgroundTaskInfo): string | undefined {
    if (task.kind !== 'agent' || task.model === undefined) return undefined;
    const name = modelDisplayName(task.model, this.props.availableModels[task.model]);
    return name.length === 0 ? undefined : name;
  }

  private renderModelRow(text: string, innerWidth: number): string {
    const indent = '  ';
    const clipped = truncateToWidth(text, Math.max(0, innerWidth - indent.length), ELLIPSIS);
    return fitLineExactly(indent + currentTheme.fg('textMuted', clipped), innerWidth);
  }

  private renderDetailContent(width: number): string[] {
    const innerWidth = Math.max(1, width);
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      return [fitLineExactly(currentTheme.fg('textMuted', 'Select a task from the list.'), innerWidth)];
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
      lines.push(
        `${label('Questions:')}${currentTheme.fg('textMuted', String(task.questionCount))}`,
      );
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
    return lines.map((line) => fitLineExactly(line, innerWidth));
  }

  private renderPreviewContent(width: number): string[] {
    const innerWidth = Math.max(1, width);
    const task = this.sortedVisible[this.selectedIndex];
    if (task === undefined) {
      return [fitLineExactly(currentTheme.fg('textMuted', 'No task selected.'), innerWidth)];
    }
    return this.previewRawLines.map((line) => fitLineExactly(currentTheme.fg('textDim', line), innerWidth));
  }
}
