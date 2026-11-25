import {
  Key,
  matchesKey,
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import type {
  GoalQueueMoveDirection,
  GoalQueueSnapshot,
  UpcomingGoal,
} from '#/tui/goal-queue-store';
import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedClick,
  forwardEmbeddedMouse,
  isPointInRect,
  ListMouseTracker,
  renderInlineSegments,
  SpanHitMap,
  type EmbeddedRect,
  type InlineSegment,
} from '#/tui/utils/mouse-regions';
import { StableWindow } from '#/tui/utils/paging';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const MAX_EDIT_INPUT_LINES = 8;
const ELLIPSIS = '…';
const BRACKET_PASTE_START = '\u001B[200~';
const BRACKET_PASTE_END = '\u001B[201~';
const SHIFT_ENTER_LEGACY = '\u001B\r';
const SHIFT_ENTER_CSI = '\u001B[13;2~';
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export type GoalQueueManagerAction =
  | {
      readonly kind: 'move';
      readonly goalId: string;
      readonly direction: GoalQueueMoveDirection;
    }
  | { readonly kind: 'edit'; readonly goalId: string }
  | { readonly kind: 'delete'; readonly goalId: string };

export interface GoalQueueManagerOptions {
  readonly goals: readonly UpcomingGoal[];
  readonly selectedGoalId?: string;
  readonly pageSize?: number;
  readonly onAction: (
    action: GoalQueueManagerAction,
  ) => GoalQueueSnapshot | void | Promise<GoalQueueSnapshot | void>;
  readonly onCancel: () => void;
}

export type GoalQueueEditResult =
  | { readonly kind: 'save'; readonly goalId: string; readonly objective: string }
  | { readonly kind: 'cancel'; readonly goalId: string };

export interface GoalQueueEditDialogOptions {
  readonly goal: UpcomingGoal;
  readonly onDone: (result: GoalQueueEditResult) => void;
}

type GoalQueueHintAction =
  | 'toggle-reorder'
  | 'move-up'
  | 'move-down'
  | 'edit'
  | 'delete'
  | 'cancel';

interface RenderedGoalInputRow {
  readonly lineIndex: number;
  readonly prefixWidth: number;
  readonly viewStartOffset: number;
}

export class GoalQueueManagerComponent implements Component, Focusable {
  focused = false;

  private readonly opts: GoalQueueManagerOptions;
  private goals: readonly UpcomingGoal[];
  private list: SearchableList<UpcomingGoal>;
  private readonly listMouse = new ListMouseTracker<number>();
  private readonly hintHits = new SpanHitMap<GoalQueueHintAction>();
  private movingGoalId: string | undefined;
  private busy = false;

  constructor(opts: GoalQueueManagerOptions) {
    this.opts = opts;
    this.goals = opts.goals;
    this.list = this.createList(opts.selectedGoalId);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    const selected = this.selectedGoal();
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      this.toggleReorder(selected);
      return;
    }

    if ((decoded === 'e' || decoded === 'E') && selected !== undefined) {
      void this.opts.onAction({ kind: 'edit', goalId: selected.id });
      return;
    }

    if ((decoded === 'd' || decoded === 'D') && selected !== undefined) {
      void this.applyQueueAction({ kind: 'delete', goalId: selected.id });
      return;
    }

    if (this.movingGoalId !== undefined) {
      if (matchesKey(data, Key.up)) {
        void this.applyQueueAction({ kind: 'move', goalId: this.movingGoalId, direction: 'up' });
        return;
      }
      if (matchesKey(data, Key.down)) {
        void this.applyQueueAction({ kind: 'move', goalId: this.movingGoalId, direction: 'down' });
        return;
      }
    }

    if (this.list.handleKey(data)) return;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (this.busy) {
      return event.type === 'wheel' ? { handled: true } : undefined;
    }

    const hintResult = this.hintHits.handle(event, {
      focused: this.focused,
      onActivate: (action) => {
        this.activateHintAction(action);
      },
    });
    if (hintResult !== undefined) return hintResult;

    const reordering = this.movingGoalId !== undefined;
    return this.listMouse.handle(event, {
      focused: this.focused,
      ...(reordering
        ? {}
        : {
            onHover: (index: number) => this.list.selectIndex(index),
            onWheel: (delta: number) => this.list.wheelPage(delta),
          }),
      onActivate: (index, mouseEvent) => {
        const target = this.list.view().items[index];
        if (target === undefined) return;
        if (this.movingGoalId !== undefined) {
          if (target.id === this.movingGoalId) {
            this.movingGoalId = undefined;
          } else {
            this.movingGoalId = undefined;
            this.list.selectIndex(index);
          }
          return;
        }
        this.list.selectIndex(index);
        if ((mouseEvent.clickCount ?? 1) >= 2) {
          void this.opts.onAction({ kind: 'edit', goalId: target.id });
        }
      },
    });
  }

  render(width: number): string[] {
    this.listMouse.reset();
    this.hintHits.reset();
    const view = this.list.view();
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Upcoming goals'),
    ];
    const hintRow = lines.length;
    const hint = this.renderHintLine(width);
    lines.push(hint.line);
    this.hintHits.addRow(hintRow, hint.targets);
    lines.push('');

    if (this.goals.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No upcoming goals.'));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const goal = view.items[i];
        if (goal === undefined) continue;
        this.listMouse.track(lines, i, () => {
          lines.push(this.renderGoal(goal, i, i === view.selectedIndex, width));
        });
      }

      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(currentTheme.fg('textMuted', ` ▼ ${String(below)} more`));
      }
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderHintLine(width: number) {
    const muted = (text: string): string => currentTheme.fg('textMuted', text);
    const reorderActive = this.movingGoalId !== undefined;
    const segments: InlineSegment<GoalQueueHintAction>[] = reorderActive
      ? [
          { text: muted(' ') },
          { text: muted('↑'), value: 'move-up' },
          { text: muted('↓'), value: 'move-down' },
          { text: muted(' reorder · ') },
          { text: muted('Space done'), value: 'toggle-reorder' },
        ]
      : [
          { text: muted(' ↑↓ navigate · ') },
          { text: muted('Space select'), value: 'toggle-reorder' },
        ];
    segments.push(
      { text: muted(' · ') },
      { text: muted('E edit'), value: 'edit' },
      { text: muted(' · ') },
      { text: muted('D delete'), value: 'delete' },
      { text: muted(' · ') },
      { text: muted('Esc cancel'), value: 'cancel' },
    );
    return renderInlineSegments(segments, width);
  }

  private toggleReorder(selected: UpcomingGoal | undefined): void {
    this.movingGoalId = this.movingGoalId === selected?.id ? undefined : selected?.id;
  }

  private activateHintAction(action: GoalQueueHintAction): void {
    const selected = this.selectedGoal();
    switch (action) {
      case 'toggle-reorder':
        this.toggleReorder(selected);
        return;
      case 'move-up':
        if (this.movingGoalId !== undefined) {
          void this.applyQueueAction({ kind: 'move', goalId: this.movingGoalId, direction: 'up' });
        }
        return;
      case 'move-down':
        if (this.movingGoalId !== undefined) {
          void this.applyQueueAction({ kind: 'move', goalId: this.movingGoalId, direction: 'down' });
        }
        return;
      case 'edit':
        if (selected !== undefined) {
          void this.opts.onAction({ kind: 'edit', goalId: selected.id });
        }
        return;
      case 'delete':
        if (selected !== undefined) {
          void this.applyQueueAction({ kind: 'delete', goalId: selected.id });
        }
        return;
      case 'cancel':
        this.opts.onCancel();
    }
  }

  private renderGoal(goal: UpcomingGoal, index: number, selected: boolean, width: number): string {
    const moving = goal.id === this.movingGoalId;
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const labelPrefix = `${String(index + 1)}. `;
    const stateLabel = moving ? '  selected' : '';
    const labelWidth = visibleWidth(labelPrefix);
    const stateWidth = visibleWidth(stateLabel);
    const objectiveWidth = Math.max(1, width - 5 - labelWidth - stateWidth);
    const objective = truncateToWidth(
      formatListObjective(goal.objective),
      objectiveWidth,
      ELLIPSIS,
    );
    const textStyle = selected
      ? (text: string) => currentTheme.boldFg('primary', text)
      : (text: string) => currentTheme.fg('text', text);
    let line = prefix + textStyle(labelPrefix + objective);
    if (moving) line += currentTheme.fg('success', stateLabel);
    return line;
  }

  private selectedGoal(): UpcomingGoal | undefined {
    return this.list.selected();
  }

  private async applyQueueAction(action: Exclude<GoalQueueManagerAction, { kind: 'edit' }>) {
    this.busy = true;
    try {
      const result = await this.opts.onAction(action);
      if (result !== undefined) {
        const selectedGoalId = action.kind === 'delete' ? undefined : action.goalId;
        this.goals = result.goals;
        if (!this.goals.some((goal) => goal.id === this.movingGoalId)) {
          this.movingGoalId = undefined;
        }
        this.list = this.createList(selectedGoalId ?? this.movingGoalId);
      }
    } finally {
      this.busy = false;
      this.invalidate();
    }
  }

  private createList(selectedGoalId?: string): SearchableList<UpcomingGoal> {
    const initialIndex = this.goals.findIndex((goal) => goal.id === selectedGoalId);
    return new SearchableList({
      items: this.goals,
      toSearchText: (goal) => goal.objective,
      pageSize: this.opts.pageSize,
      initialIndex: initialIndex === -1 ? 0 : initialIndex,
      searchable: false,
    });
  }
}

export class GoalQueueEditDialogComponent implements Component, Focusable {
  focused = false;

  private readonly input = new MultilineGoalInput();
  private readonly opts: GoalQueueEditDialogOptions;
  private inputRect: EmbeddedRect | undefined;
  private done = false;
  private error: string | undefined;

  constructor(opts: GoalQueueEditDialogOptions) {
    this.opts = opts;
    this.input.setValue(opts.goal.objective);
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done) return undefined;
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (event.type === 'wheel') {
      const forwarded = forwardEmbeddedMouse(this.input, this.inputRect, event);
      if (forwarded !== undefined) return forwarded;
      return { handled: true, render: this.input.scrollByWheel(event.wheelDelta ?? 0) };
    }
    if (this.inputRect !== undefined && isPointInRect(this.inputRect, event.x, event.y)) {
      if (event.type === 'press' && event.button === 'left') {
        const hadError = this.error !== undefined;
        this.error = undefined;
        const forwarded = forwardEmbeddedMouse(this.input, this.inputRect, event);
        if (forwarded === undefined) return hadError ? { handled: true, render: true } : undefined;
        return hadError ? { ...forwarded, render: true } : forwarded;
      }
      if ((event.type === 'release' || event.type === 'click') && event.button === 'left') {
        return { handled: true };
      }
    }
    return undefined;
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.done = true;
      this.opts.onDone({ kind: 'cancel', goalId: this.opts.goal.id });
      return;
    }
    this.error = undefined;
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    this.input.focused = this.focused && !this.done;
    this.inputRect = undefined;
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const border = (s: string): string => currentTheme.fg('primary', s);
    const title = truncateToWidth(
      currentTheme.boldFg('textStrong', 'Edit upcoming goal'),
      innerWidth,
      ELLIPSIS,
    );
    const subtitle = truncateToWidth(
      currentTheme.fg(
        this.error === undefined ? 'textDim' : 'warning',
        this.error ?? 'Update the queued objective.',
      ),
      innerWidth,
      ELLIPSIS,
    );
    const inputLines = this.input.render(innerWidth);
    const footer = truncateToWidth(
      currentTheme.fg('textDim', 'Enter submit · Shift-Enter/Ctrl-J newline · Esc cancel'),
      innerWidth,
      ELLIPSIS,
    );
    if (safeWidth < 4) {
      const lines = ['', title, '', subtitle, ''];
      const inputStartRow = lines.length;
      lines.push(...inputLines);
      this.inputRect = {
        x: 0,
        y: inputStartRow,
        width: safeWidth,
        height: inputLines.length,
      };
      lines.push('', footer);
      return lines.map((line) => truncateToWidth(line, safeWidth, ELLIPSIS));
    }

    const lines = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];
    const pushFramed = (content: string): void => {
      const rightPad = Math.max(0, innerWidth - visibleWidth(content));
      lines.push(`${border('│')}  ${content}${' '.repeat(rightPad)}${border('│')}`);
    };

    pushFramed(title);
    pushFramed('');
    pushFramed(subtitle);
    pushFramed('');
    const inputStartRow = lines.length;
    for (const inputLine of inputLines) {
      pushFramed(inputLine);
    }
    this.inputRect = {
      x: 3,
      y: inputStartRow,
      width: innerWidth,
      height: inputLines.length,
    };
    pushFramed('');
    pushFramed(footer);

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, ELLIPSIS));
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private submit(value: string): void {
    const objective = value.trim();
    if (objective.length === 0) {
      this.error = 'Goal objective cannot be empty.';
      return;
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      this.error = `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters; put long content in a file and reference the file path.`;
      return;
    }
    this.opts.onDone({ kind: 'save', goalId: this.opts.goal.id, objective });
  }
}

class MultilineGoalInput implements Component, Focusable {
  focused = false;
  onSubmit?: (value: string) => void;

  private value = '';
  private cursor = 0;
  private pasteBuffer: string | undefined;
  private readonly window = new StableWindow();
  private followCursor = true;
  private renderedRows: (RenderedGoalInputRow | undefined)[] = [];

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = normalizeNewlines(value);
    this.cursor = this.value.length;
    this.followCursor = true;
    this.window.reset(0);
  }

  handleInput(data: string): void {
    if (this.handleBracketedPaste(data)) {
      this.followCursor = true;
      return;
    }

    if (isNewlineInput(data)) {
      this.insert('\n');
      return;
    }

    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      this.onSubmit?.(this.value);
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      this.deleteBeforeCursor();
      return;
    }

    if (matchesKey(data, Key.delete)) {
      this.deleteAfterCursor();
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.cursor = previousGraphemeStart(this.value, this.cursor);
      this.followCursor = true;
      return;
    }

    if (matchesKey(data, Key.right)) {
      this.cursor = nextGraphemeEnd(this.value, this.cursor);
      this.followCursor = true;
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveVertical(-1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.moveVertical(1);
      return;
    }

    if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl('a'))) {
      this.cursor = this.currentLineStart();
      this.followCursor = true;
      return;
    }

    if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl('e'))) {
      this.cursor = this.currentLineEnd();
      this.followCursor = true;
      return;
    }

    const decoded = printableChar(data);
    if (isPrintableText(decoded)) {
      this.insert(decoded);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel') {
      return { handled: true, render: this.scrollByWheel(event.wheelDelta ?? 0) };
    }
    if (event.type !== 'press' || event.button !== 'left') return undefined;
    const row = this.renderedRows[event.y];
    if (row === undefined) return { handled: true, render: false };
    const starts = lineStarts(this.value);
    if (row.lineIndex < 0 || row.lineIndex >= starts.length) {
      return { handled: true, render: false };
    }
    const lineStart = starts[row.lineIndex] ?? 0;
    const lineEnd = lineEndForStart(this.value, starts, row.lineIndex);
    const lineText = this.value.slice(lineStart, lineEnd);
    const startOffset = Math.min(row.viewStartOffset, lineText.length);
    const visibleCol = Math.max(0, event.x - row.prefixWidth);
    let currentCol = 0;
    let colOffset = lineText.length;
    for (const grapheme of SEGMENTER.segment(lineText.slice(startOffset))) {
      const nextCol = currentCol + visibleWidth(grapheme.segment);
      if (visibleCol < nextCol) {
        colOffset = startOffset + grapheme.index;
        break;
      }
      currentCol = nextCol;
    }
    this.cursor = lineStart + colOffset;
    this.followCursor = true;
    return { handled: true, focus: true, render: true };
  }

  scrollByWheel(delta: number): boolean {
    if (!Number.isFinite(delta) || delta === 0) return false;
    const step = Math.trunc(delta) || (delta > 0 ? 1 : -1);
    const totalLines = this.value.split('\n').length;
    const moved = this.window.scrollBy(step, totalLines, MAX_EDIT_INPUT_LINES);
    if (moved) this.followCursor = false;
    return moved;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const logicalLines = this.value.split('\n');
    const cursor = this.cursorLocation();
    if (this.followCursor) {
      this.window.ensureVisible(cursor.line, logicalLines.length, MAX_EDIT_INPUT_LINES);
    }
    const range = this.window.range(logicalLines.length, MAX_EDIT_INPUT_LINES);
    const rendered: string[] = [];
    this.renderedRows = [];

    if (range.start > 0) {
      rendered.push(padInputLine(`  ${ELLIPSIS} ${String(range.start)} previous`, safeWidth));
      this.renderedRows.push(undefined);
    }

    for (let lineIndex = range.start; lineIndex < range.end; lineIndex++) {
      const line = logicalLines[lineIndex] ?? '';
      const prefix = lineIndex === 0 ? '> ' : '  ';
      const prefixWidth = visibleWidth(prefix);
      if (lineIndex === cursor.line) {
        const cursorLine = renderCursorLine(line, cursor.column, prefix, safeWidth, this.focused);
        rendered.push(cursorLine.text);
        this.renderedRows.push({
          lineIndex,
          prefixWidth,
          viewStartOffset: cursorLine.viewStartOffset,
        });
      } else {
        rendered.push(renderTextLine(line, prefix, safeWidth));
        this.renderedRows.push({
          lineIndex,
          prefixWidth,
          viewStartOffset: 0,
        });
      }
    }

    const remaining = logicalLines.length - range.end;
    if (remaining > 0) {
      rendered.push(padInputLine(`  ${ELLIPSIS} ${String(remaining)} more`, safeWidth));
      this.renderedRows.push(undefined);
    }

    return rendered;
  }

  private insert(text: string): void {
    const normalized = normalizeNewlines(text);
    this.value =
      this.value.slice(0, this.cursor) + normalized + this.value.slice(this.cursor);
    this.cursor += normalized.length;
    this.followCursor = true;
  }

  private deleteBeforeCursor(): void {
    this.followCursor = true;
    if (this.cursor === 0) return;
    const start = previousGraphemeStart(this.value, this.cursor);
    this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
    this.cursor = start;
  }

  private deleteAfterCursor(): void {
    this.followCursor = true;
    if (this.cursor >= this.value.length) return;
    const end = nextGraphemeEnd(this.value, this.cursor);
    this.value = this.value.slice(0, this.cursor) + this.value.slice(end);
  }

  private moveVertical(delta: -1 | 1): void {
    this.followCursor = true;
    const starts = lineStarts(this.value);
    const location = this.cursorLocation(starts);
    const targetLine = location.line + delta;
    if (targetLine < 0 || targetLine >= starts.length) return;

    const targetStart = starts[targetLine] ?? 0;
    const targetEnd = lineEndForStart(this.value, starts, targetLine);
    this.cursor = Math.min(targetStart + location.column, targetEnd);
  }

  private currentLineStart(): number {
    return this.value.lastIndexOf('\n', Math.max(0, this.cursor - 1)) + 1;
  }

  private currentLineEnd(): number {
    return lineEndAt(this.value, this.cursor);
  }

  private cursorLocation(starts = lineStarts(this.value)): { line: number; column: number } {
    let line = 0;
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i] ?? 0;
      if (start > this.cursor) break;
      line = i;
    }
    const lineStart = starts[line] ?? 0;
    return { line, column: this.cursor - lineStart };
  }

  private handleBracketedPaste(data: string): boolean {
    if (this.pasteBuffer !== undefined) {
      this.appendPasteChunk(data);
      return true;
    }

    const start = data.indexOf(BRACKET_PASTE_START);
    if (start === -1) return false;

    this.pasteBuffer = '';
    const before = data.slice(0, start);
    if (isPrintableText(before)) this.insert(before);
    this.appendPasteChunk(data.slice(start + BRACKET_PASTE_START.length));
    return true;
  }

  private appendPasteChunk(data: string): void {
    if (this.pasteBuffer === undefined) return;

    this.pasteBuffer += data;
    const end = this.pasteBuffer.indexOf(BRACKET_PASTE_END);
    if (end === -1) return;

    const pasted = this.pasteBuffer.slice(0, end);
    const remaining = this.pasteBuffer.slice(end + BRACKET_PASTE_END.length);
    this.pasteBuffer = undefined;
    this.insert(sanitizePastedText(pasted));
    if (remaining.length > 0) this.handleInput(remaining);
  }
}

function isNewlineInput(data: string): boolean {
  return (
    data === '\n' ||
    data === SHIFT_ENTER_LEGACY ||
    data === SHIFT_ENTER_CSI ||
    matchesKey(data, Key.ctrl('j'))
  );
}

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function formatListObjective(objective: string): string {
  return objective.replaceAll(/\s+/g, ' ').trim();
}

function sanitizePastedText(text: string): string {
  const normalized = normalizeNewlines(text).replaceAll(ANSI_CSI, '');
  let out = '';
  for (let i = 0; i < normalized.length;) {
    const code = normalized.codePointAt(i);
    if (code === undefined) break;
    const char = String.fromCodePoint(code);
    if (char === '\n' || isPrintableText(char)) {
      out += char;
    }
    i += code > 0xffff ? 2 : 1;
  }
  return out;
}

function isPrintableText(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i);
    if (code === undefined) return false;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
    i += code > 0xffff ? 2 : 1;
  }
  return true;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineEndAt(text: string, offset: number): number {
  const end = text.indexOf('\n', offset);
  return end === -1 ? text.length : end;
}

function lineEndForStart(text: string, starts: readonly number[], line: number): number {
  const nextStart = starts[line + 1];
  return nextStart === undefined ? text.length : nextStart - 1;
}

function previousGraphemeStart(text: string, offset: number): number {
  if (offset <= 0) return 0;
  let previous = 0;
  for (const segment of SEGMENTER.segment(text.slice(0, offset))) {
    previous = segment.index;
  }
  return previous;
}

function nextGraphemeEnd(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const segment = SEGMENTER.segment(text.slice(offset))[Symbol.iterator]().next().value;
  return segment === undefined ? text.length : offset + segment.segment.length;
}

function renderTextLine(line: string, prefix: string, width: number): string {
  const prefixWidth = visibleWidth(prefix);
  const textWidth = Math.max(1, width - prefixWidth);
  const text = truncateToWidth(line, textWidth, ELLIPSIS);
  return padInputLine(prefix + text, width);
}

function renderCursorLine(
  line: string,
  column: number,
  prefix: string,
  width: number,
  focused: boolean,
): { readonly text: string; readonly viewStartOffset: number } {
  const prefixWidth = visibleWidth(prefix);
  const textWidth = Math.max(1, width - prefixWidth);
  const cursorEnd = nextGraphemeEnd(line, column);
  const before = line.slice(0, column);
  const cursorText = line.slice(column, cursorEnd) || ' ';
  const after = line.slice(cursorEnd);
  const cursorWidth = Math.max(1, visibleWidth(cursorText));
  const beforeWidth = Math.max(0, textWidth - cursorWidth);
  const beforeView = takeEndByWidth(before, beforeWidth);
  const afterView = takeStartByWidth(
    after,
    Math.max(0, textWidth - visibleWidth(beforeView) - cursorWidth),
  );
  const marker = focused ? CURSOR_MARKER : '';
  return {
    text: padInputLine(
      prefix + beforeView + marker + chalk.inverse(cursorText) + afterView,
      width,
    ),
    viewStartOffset: before.length - beforeView.length,
  };
}

function takeStartByWidth(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const segment of SEGMENTER.segment(text)) {
    const segmentWidth = visibleWidth(segment.segment);
    if (used + segmentWidth > width) break;
    out += segment.segment;
    used += segmentWidth;
  }
  return out;
}

function takeEndByWidth(text: string, width: number): string {
  let out = '';
  let used = 0;
  const segments = [...SEGMENTER.segment(text)];
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment === undefined) continue;
    const segmentWidth = visibleWidth(segment.segment);
    if (used + segmentWidth > width) break;
    out = segment.segment + out;
    used += segmentWidth;
  }
  return out;
}

function padInputLine(line: string, width: number): string {
  return line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
}
