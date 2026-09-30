import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { TaskRecord } from '@moonshot-ai/harness-core';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import { sanitizeShellOutput } from '#/tui/utils/shell-output';

import { TASK_STATUS_LABEL, taskStatusColor } from './tasks-browser';

const ELLIPSIS = '…';

export interface TaskOutputViewerProps {
  readonly taskId: string;
  readonly record: TaskRecord | undefined;
  readonly output: string;
  readonly title?: string;
  readonly onClose: () => void;
}

function padToWidth(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w === width) return line;
  if (w > width) return truncateToWidth(line, width, ELLIPSIS);
  return line + ' '.repeat(width - w);
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  return padToWidth(s, width);
}

export class TaskOutputViewer extends Container implements Focusable {
  focused = false;

  private props: TaskOutputViewerProps;
  private readonly terminal: Terminal;
  private lines: string[];
  private scrollTop = 0;

  constructor(props: TaskOutputViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.lines = this.splitOutput(props.output);
  }

  setProps(next: TaskOutputViewerProps): void {
    const previousOutput = this.props.output;
    const wasAtBottom = this.scrollTop >= this.maxScroll();
    this.props = next;
    if (next.output !== previousOutput) {
      this.lines = this.splitOutput(next.output);
      if (wasAtBottom) this.scrollTop = this.maxScroll();
      else this.scrollTop = Math.min(this.scrollTop, this.maxScroll());
    }
    this.invalidate();
  }

  private splitOutput(output: string): string[] {
    return (output.length > 0 ? sanitizeShellOutput(output) : '[no output captured]').split('\n');
  }

  handleInput(data: string): void {
    const visible = this.viewableRows();
    const k = printableChar(data);

    if (matchesKey(data, Key.escape) || k === 'q' || k === 'Q') {
      this.props.onClose();
      return;
    }
    if (matchesKey(data, Key.up) || k === 'k') {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || k === 'j') {
      this.scrollBy(1);
      return;
    }
    if (
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.ctrl('u')) ||
      k === ' ' ||
      data === '\u0002'
    ) {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, Key.ctrl('d')) ||
      data === '\u0006'
    ) {
      this.scrollBy(Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.home) || k === 'g') {
      this.scrollTo(0);
      return;
    }
    if (matchesKey(data, Key.end) || k === 'G') {
      this.scrollTo(this.maxScroll());
      return;
    }
  }

  private scrollBy(delta: number): void {
    this.scrollTo(this.scrollTop + delta);
  }

  private scrollTo(target: number): void {
    this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
    this.invalidate();
  }

  private maxScroll(): number {
    return Math.max(0, this.lines.length - this.viewableRows());
  }

  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;

    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width, bodyHeight);

    const out: string[] = [header];
    for (const line of body) out.push(line);
    out.push(footer);
    return out;
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', this.props.title ?? ' Task output ');
    const id = currentTheme.boldFg('text', this.props.taskId);
    const record = this.props.record;
    const segments: string[] = [];
    if (record !== undefined) {
      segments.push(currentTheme.fg(taskStatusColor(record.status), TASK_STATUS_LABEL[record.status]));
      const description = record.description;
      if (description !== undefined && description.length > 0) {
        segments.push(currentTheme.fg('textMuted', description));
      }
    }
    const composed = title + id + (segments.length > 0 ? '  ' + segments.join('  ') : '');
    return fitExactly(composed, width);
  }

  private renderBody(width: number, bodyHeight: number): string[] {
    const innerWidth = Math.max(1, width - 4);

    const max = this.maxScroll();
    if (this.scrollTop > max) this.scrollTop = max;
    if (this.scrollTop < 0) this.scrollTop = 0;

    const viewRows = bodyHeight - 2;
    const top = currentTheme.fg('primary', '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [top];
    for (let i = 0; i < viewRows; i++) {
      const lineIndex = this.scrollTop + i;
      const raw = this.lines[lineIndex] ?? '';
      const inner = fitExactly(currentTheme.fg('text', raw), innerWidth);
      out.push(currentTheme.fg('primary', '│ ') + inner + currentTheme.fg('primary', ' │'));
    }
    out.push(bottom);
    return out;
  }

  private renderFooter(width: number, bodyHeight: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    const total = this.lines.length;
    const viewRows = Math.max(1, bodyHeight - 2);
    const maxScroll = Math.max(0, total - viewRows);
    const percent =
      maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
    const lineFrom = this.scrollTop + 1;
    const lineTo = Math.min(total, this.scrollTop + viewRows);

    const position = currentTheme.fg(
      'textMuted',
      ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `,
    );
    const keys =
      `${key('↑↓')} ${dim('line')}  ` +
      `${key('PgUp/PgDn/Ctrl+U/D')} ${dim('page')}  ` +
      `${key('g/G')} ${dim('top/bot')}  ` +
      `${key('Q/Esc')} ${dim('cancel')}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }
}
