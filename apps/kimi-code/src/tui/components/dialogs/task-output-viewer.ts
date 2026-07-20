/**
 * TaskOutputViewer — full-screen pi-tui rendered output viewer for
 * a single background task. Replaces the previous "shell out to less"
 * approach so the experience stays inside the TUI: same colors, same
 * fonts, same redraw cycle, no alt-screen flip-flop.
 *
 * Mounted by `kimi-tui.ts` via nested container swap on top of the
 * TasksBrowserApp. Snapshot view (no live tail) — content is fetched
 * once when the viewer opens.
 */

import {
  Container,
  Key,
  matchesKey,
  type Terminal,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';

const ELLIPSIS = '…';

export interface TaskOutputViewerProps {
  readonly taskId: string;
  readonly info: BackgroundTaskInfo | undefined;
  readonly output: string;
  readonly onClose: () => void;
}

const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed out',
  killed: 'killed',
  lost: 'lost',
};

function statusColor(status: BackgroundTaskStatus): 'success' | 'textMuted' | 'error' {
  switch (status) {
    case 'running':
      return 'success';
    case 'completed':
      return 'textMuted';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'error';
  }
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
  /** Output split on '\n'. Replaced on `setProps` when `output` changes. */
  private lines: string[];
  /** Index of the topmost visible line. */
  private scrollTop = 0;

  constructor(props: TaskOutputViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.lines = this.splitOutput(props.output);
  }

  /**
   * Update viewer props. When `output` grows (the watched task wrote
   * new content), follow the tail like `less +F` if the user is parked
   * at the bottom; otherwise keep the user's current scroll position
   * so they can read history without being yanked around.
   */
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
    return (output.length > 0 ? output : '[no output captured]').split('\n');
  }

  // ── input ──────────────────────────────────────────────────────────

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
      data === '\u0002' /* C-b */
    ) {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, Key.ctrl('d')) ||
      data === '\u0006' /* C-f */
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

  /**
   * Number of content rows visible inside the body frame: total terminal
   * rows minus header(1) + footer(1) + top border(1) + bottom border(1).
   */
  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  // ── render ─────────────────────────────────────────────────────────

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
    const title = currentTheme.boldFg('primary', ' Task output ');
    const id = currentTheme.boldFg('text', this.props.taskId);
    const info = this.props.info;
    const segments: string[] = [];
    if (info !== undefined) {
      segments.push(currentTheme.fg(statusColor(info.status), STATUS_LABEL[info.status]));
      if (info.kind === 'process' && info.exitCode !== null) {
        segments.push(currentTheme.fg('textMuted', `exit ${String(info.exitCode)}`));
      }
      if (info.description && info.description.length > 0) {
        segments.push(currentTheme.fg('textMuted', info.description));
      }
    }
    const composed = title + id + (segments.length > 0 ? '  ' + segments.join('  ') : '');
    return fitExactly(composed, width);
  }

  private renderBody(width: number, bodyHeight: number): string[] {
    // Reserve 1 col for left/right border each, 1 col for left padding.
    const innerWidth = Math.max(1, width - 4);

    // Re-clamp scroll in case the terminal got resized smaller.
    const max = this.maxScroll();
    if (this.scrollTop > max) this.scrollTop = max;
    if (this.scrollTop < 0) this.scrollTop = 0;

    const viewRows = bodyHeight - 2; // inside top + bottom border
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
