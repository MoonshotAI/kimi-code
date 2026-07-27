/**
 * TextViewerComponent — minimal full-screen scrollable text viewer (static
 * content). Modeled on TaskOutputViewer, but content-agnostic: used to
 * inspect workflow scripts from the /workflow command and the workflow run
 * confirmation prompt.
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

import { currentTheme } from '#/tui/theme';
import { printableChar } from '@/tui/utils/printable-key';

const ELLIPSIS = '…';

export interface TextViewerProps {
  readonly title: string;
  readonly content: string;
  readonly onClose: () => void;
}

function fitExactly(line: string, width: number): string {
  let s = line;
  if (visibleWidth(s) > width) s = truncateToWidth(s, width, ELLIPSIS);
  const w = visibleWidth(s);
  return w === width ? s : s + ' '.repeat(width - w);
}

export class TextViewerComponent extends Container implements Focusable {
  focused = false;

  private readonly props: TextViewerProps;
  private readonly terminal: Terminal;
  private readonly lines: string[];
  private scrollTop = 0;

  constructor(props: TextViewerProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.lines = (props.content.length > 0 ? props.content : '[empty]').split('\n');
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
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl('u')) || k === ' ') {
      this.scrollBy(-Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl('d'))) {
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

    const header = fitExactly(currentTheme.boldFg('primary', ` ${this.props.title}`), width);
    const innerWidth = Math.max(1, width - 4);
    const max = this.maxScroll();
    if (this.scrollTop > max) this.scrollTop = max;

    const viewRows = bodyHeight - 2;
    const top = currentTheme.fg('primary', '┌' + '─'.repeat(Math.max(0, width - 2)) + '┐');
    const bottom = currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘');

    const out: string[] = [header, top];
    for (let i = 0; i < viewRows; i++) {
      const raw = this.lines[this.scrollTop + i] ?? '';
      const inner = fitExactly(currentTheme.fg('text', raw), innerWidth);
      out.push(currentTheme.fg('primary', '│ ') + inner + currentTheme.fg('primary', ' │'));
    }
    out.push(bottom);

    const key = (text: string): string => currentTheme.boldFg('primary', text);
    const dim = (text: string): string => currentTheme.fg('textMuted', text);
    out.push(fitExactly(` ${key('↑↓')} ${dim('line')}  ${key('PgUp/PgDn')} ${dim('page')}  ${key('g/G')} ${dim('top/bot')}  ${key('Q/Esc')} ${dim('close')}`, width));
    return out;
  }
}
