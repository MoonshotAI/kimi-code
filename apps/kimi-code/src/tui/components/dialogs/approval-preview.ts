/**
 * ApprovalPreviewViewer — full-screen preview of an Edit diff or Write
 * file content for the approval flow.
 *
 * Mounted by `kimi-tui.ts` via the same nested-takeover pattern as
 * `TaskOutputViewer`: the active approval panel is preserved underneath
 * and restored on close. The viewer is intentionally a snapshot — its
 * lines are rendered once at construction and only sliced on scroll, so
 * the per-frame render cost stays in `O(viewport)` even when the
 * underlying diff/content is very large.
 *
 * This avoids the prior failure mode where pressing ctrl+e on an Edit
 * with a long hunk inflated the approval panel past one screen, which
 * collided with pi-tui's inline differential renderer and the terminal
 * emulator's "snap to bottom on stdout" reflex, causing flicker and an
 * unscrollable history pane.
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

import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLines } from '#/tui/components/media/diff-preview';
import type { DiffDisplayBlock, FileContentDisplayBlock } from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

const ELLIPSIS = '…';

export type ApprovalPreviewBlock = DiffDisplayBlock | FileContentDisplayBlock;

export interface ApprovalPreviewViewerProps {
  readonly block: ApprovalPreviewBlock;
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

export class ApprovalPreviewViewer extends Container implements Focusable {
  focused = false;

  private readonly props: ApprovalPreviewViewerProps;
  private readonly terminal: Terminal;
  /** Pre-rendered body lines (ANSI-styled, no border / no gutter). */
  private bodyLines: string[];
  /** Title shown in the header (path + diff stats / "Write" label). */
  private headerTitle: string;
  /** Index of the topmost visible line. */
  private scrollTop = 0;

  constructor(props: ApprovalPreviewViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    const built = buildBody(props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
  }

  handleInput(data: string): void {
    const visible = this.viewableRows();
    const k = printableChar(data);

    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('e')) ||
      k === 'q' ||
      k === 'Q'
    ) {
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
    if (matchesKey(data, Key.pageUp) || k === ' ' || data === '\x02') {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.pageDown) || data === '\x06') {
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

  override invalidate(): void {
    const built = buildBody(this.props.block);
    this.bodyLines = built.lines;
    this.headerTitle = built.title;
  }

  private scrollTo(target: number): void {
    this.scrollTop = Math.max(0, Math.min(target, this.maxScroll()));
    super.invalidate();
  }

  private maxScroll(): number {
    return Math.max(0, this.bodyLines.length - this.viewableRows());
  }

  /** Body rows = terminal rows − header(1) − top border(1) − bottom border(1) − footer(1). */
  private viewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;

    const header = this.renderHeader(width);
    const body = this.renderBody(width, bodyHeight);
    const footer = this.renderFooter(width, bodyHeight);

    return [header, ...body, footer];
  }

  private renderHeader(width: number): string {
    const title = currentTheme.boldFg('primary', ' Preview ');
    return fitExactly(title + this.headerTitle, width);
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
      const raw = this.bodyLines[lineIndex] ?? '';
      out.push(currentTheme.fg('primary', '│ ') + fitExactly(raw, innerWidth) + currentTheme.fg('primary', ' │'));
    }
    out.push(bottom);
    return out;
  }

  private renderFooter(width: number, bodyHeight: number): string {
    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);

    const total = this.bodyLines.length;
    const viewRows = Math.max(1, bodyHeight - 2);
    const maxScroll = Math.max(0, total - viewRows);
    const percent = maxScroll === 0 ? 100 : Math.round((this.scrollTop / maxScroll) * 100);
    const lineFrom = total === 0 ? 0 : this.scrollTop + 1;
    const lineTo = Math.min(total, this.scrollTop + viewRows);

    const position = currentTheme.fg(
      'textMuted',
      ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `,
    );
    const keys =
      `${key('↑↓')} ${dim('line')}  ` +
      `${key('PgUp/PgDn')} ${dim('page')}  ` +
      `${key('g/G')} ${dim('top/bot')}  ` +
      `${key('Q/Esc/Ctrl+E')} ${dim('cancel')}`;
    const left = ` ${keys}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitExactly(left, width);
  }
}

interface BuiltBody {
  lines: string[];
  title: string;
}

function buildBody(block: ApprovalPreviewBlock): BuiltBody {
  if (block.type === 'diff') {
    return buildDiffBody(block);
  }
  return buildFileContentBody(block);
}

function buildDiffBody(block: DiffDisplayBlock): BuiltBody {
  // renderDiffLines emits a `+N -M path` header on its first line followed
  // by every changed line. We pull the header out into the viewer chrome so
  // the body is purely scrollable diff content; this also means we don't
  // double-render the path.
  const rendered = renderDiffLines(
    block.old_text,
    block.new_text,
    block.path,
    false,
    block.old_start ?? 1,
    block.new_start ?? 1,
  );
  const [header = '', ...rest] = rendered;
  return { lines: rest, title: stripLeadingSpace(header) };
}

function buildFileContentBody(block: FileContentDisplayBlock): BuiltBody {
  const lang = block.language ?? langFromPath(block.path);
  const highlighted = highlightLines(block.content, lang);
  const lines = highlighted.map(
    (line, i) => currentTheme.fg('diffGutter', String(i + 1).padStart(4) + '  ') + line,
  );
  const title = currentTheme.fg('textStrong', block.path);
  return { lines, title };
}

function stripLeadingSpace(s: string): string {
  return s.replace(/^ +/, '');
}
