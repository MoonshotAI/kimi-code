import {
  Container,
  Key,
  matchesKey,
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import type {
  GoalQueueMoveDirection,
  GoalQueueSnapshot,
  UpcomingGoal,
} from '#/tui/goal-queue-store';
import { currentTheme } from '#/tui/theme';
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
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is required to strip pasted terminal control sequences
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

export class GoalQueueManagerComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: GoalQueueManagerOptions;
  private goals: readonly UpcomingGoal[];
  private list: SearchableList<UpcomingGoal>;
  private movingGoalId: string | undefined;
  private busy = false;

  constructor(opts: GoalQueueManagerOptions) {
    super();
    this.opts = opts;
    this.goals = opts.goals;
    this.list = this.createList(opts.selectedGoalId);
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    const selected = this.selectedGoal();
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      this.movingGoalId = this.movingGoalId === selected?.id ? undefined : selected?.id;
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

  override render(width: number): string[] {
    const view = this.list.view();
    const hint = this.movingGoalId === undefined
      ? '↑↓ navigate · Space select · E edit · D delete · Esc cancel'
      : '↑↓ reorder · Space done · E edit · D delete · Esc cancel';
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ' Upcoming goals'),
      currentTheme.fg('textMuted', ` ${hint}`),
      '',
    ];

    if (this.goals.length === 0) {
      lines.push(currentTheme.fg('textMuted', '  No upcoming goals.'));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const goal = view.items[i];
        if (goal === undefined) continue;
        lines.push(this.renderGoal(goal, i, i === view.selectedIndex, width));
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

export class GoalQueueEditDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new MultilineGoalInput();
  private readonly opts: GoalQueueEditDialogOptions;
  private done = false;
  private error: string | undefined;

  constructor(opts: GoalQueueEditDialogOptions) {
    super();
    this.opts = opts;
    this.input.setValue(opts.goal.objective);
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
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

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';
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
    const contentLines = [title, '', subtitle, '', ...inputLines, '', footer];
    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, ELLIPSIS))];
    }

    const lines = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const rightPad = Math.max(0, innerWidth - visibleWidth(content));
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, ELLIPSIS));
  }

  private submit(value: string): void {
    const objective = value.trim();
    if (objective.length === 0) {
      this.error = 'Goal objective cannot be empty.';
      return;
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      this.error = `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters.`;
      return;
    }
    this.opts.onDone({ kind: 'save', goalId: this.opts.goal.id, objective });
  }
}

class MultilineGoalInput {
  focused = false;
  onSubmit?: (value: string) => void;

  private value = '';
  private cursor = 0;
  private pasteBuffer: string | undefined;

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = normalizeNewlines(value);
    this.cursor = this.value.length;
  }

  handleInput(data: string): void {
    if (this.handleBracketedPaste(data)) return;

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
      return;
    }

    if (matchesKey(data, Key.right)) {
      this.cursor = nextGraphemeEnd(this.value, this.cursor);
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
      return;
    }

    if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl('e'))) {
      this.cursor = this.currentLineEnd();
      return;
    }

    const decoded = printableChar(data);
    if (isPrintableText(decoded)) {
      this.insert(decoded);
    }
  }

  invalidate(): void {
    // No cached layout.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const logicalLines = this.value.split('\n');
    const cursor = this.cursorLocation();
    const range = visibleLineRange(logicalLines.length, cursor.line);
    const rendered: string[] = [];

    if (range.start > 0) {
      rendered.push(padInputLine(`  ${ELLIPSIS} ${String(range.start)} previous`, safeWidth));
    }

    for (let lineIndex = range.start; lineIndex < range.end; lineIndex++) {
      const line = logicalLines[lineIndex] ?? '';
      const prefix = lineIndex === 0 ? '> ' : '  ';
      rendered.push(
        lineIndex === cursor.line
          ? renderCursorLine(line, cursor.column, prefix, safeWidth, this.focused)
          : renderTextLine(line, prefix, safeWidth),
      );
    }

    const remaining = logicalLines.length - range.end;
    if (remaining > 0) {
      rendered.push(padInputLine(`  ${ELLIPSIS} ${String(remaining)} more`, safeWidth));
    }

    return rendered;
  }

  private insert(text: string): void {
    const normalized = normalizeNewlines(text);
    this.value =
      this.value.slice(0, this.cursor) + normalized + this.value.slice(this.cursor);
    this.cursor += normalized.length;
  }

  private deleteBeforeCursor(): void {
    if (this.cursor === 0) return;
    const start = previousGraphemeStart(this.value, this.cursor);
    this.value = this.value.slice(0, start) + this.value.slice(this.cursor);
    this.cursor = start;
  }

  private deleteAfterCursor(): void {
    if (this.cursor >= this.value.length) return;
    const end = nextGraphemeEnd(this.value, this.cursor);
    this.value = this.value.slice(0, this.cursor) + this.value.slice(end);
  }

  private moveVertical(delta: -1 | 1): void {
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

function visibleLineRange(totalLines: number, cursorLine: number): { start: number; end: number } {
  if (totalLines <= MAX_EDIT_INPUT_LINES) return { start: 0, end: totalLines };

  const half = Math.floor(MAX_EDIT_INPUT_LINES / 2);
  const start = Math.min(
    Math.max(0, cursorLine - half),
    Math.max(0, totalLines - MAX_EDIT_INPUT_LINES),
  );
  return { start, end: start + MAX_EDIT_INPUT_LINES };
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
): string {
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
  return padInputLine(
    prefix + beforeView + marker + chalk.inverse(cursorText) + afterView,
    width,
  );
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
