import {
  Box,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  VStack,
  type Component,
  type Focusable,
  type Terminal,
} from '@moonshot-ai/pi-tui';

import {
  createInteractiveChildView,
  OverflowScrollView,
} from '#/tui/components/chrome/dock-section';
import { currentTheme } from '#/tui/theme';
import { handleActionBarMouse, type MouseActionSpan } from '#/tui/utils/dialog-mouse';
import { printableChar } from '#/tui/utils/printable-key';

const ELLIPSIS = '…';
const paintPrimary = (text: string): string => currentTheme.fg('primary', text);

export interface ViewerFooterItem {
  readonly keys: string;
  readonly label: string;
  readonly onClick?: () => void;
}

export interface FramedScrollViewerOptions {
  readonly terminal: Terminal;
  readonly follow?: 'none' | 'end';
  readonly enableHalfPageCtrlKeys?: boolean;
  readonly requestRender?: () => void;
}

export function fitViewerLine(line: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const clipped =
    visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, ELLIPSIS) : line;
  const pad = Math.max(0, safeWidth - visibleWidth(clipped));
  return pad === 0 ? clipped : clipped + ' '.repeat(pad);
}

export abstract class FramedScrollViewer extends VStack implements Focusable {
  focused = false;
  capturesViewportInput = true;

  protected readonly terminal: Terminal;
  private readonly shownAt = Date.now();
  private readonly followEndByDefault: boolean;
  private readonly enableHalfPageCtrlKeys: boolean;
  private onScrollRequestRender: (() => void) | undefined;
  private scrollTop = 0;
  private followTail: boolean;
  private pendingPinToBottom = false;
  private lastInnerWidth = 76;
  private lastBodyCount = 0;
  private readonly bodyScroll: OverflowScrollView;
  private footerSpans: readonly MouseActionSpan[] = [];

  protected constructor(options: FramedScrollViewerOptions) {
    super();
    this.terminal = options.terminal;
    this.followEndByDefault = options.follow === 'end';
    this.followTail = this.followEndByDefault;
    this.enableHalfPageCtrlKeys = options.enableHalfPageCtrlKeys === true;
    this.onScrollRequestRender = options.requestRender;

    const headerView: Component = {
      render: (width) => [this.renderHeaderLine(width)],
      invalidate: () => {},
    };
    const bodyView: Component = {
      render: (width) => {
        this.lastInnerWidth = Math.max(1, width);
        const lines = this.getBodyLines(this.lastInnerWidth);
        this.lastBodyCount = lines.length;
        return lines.map((line) =>
          visibleWidth(line) > width ? truncateToWidth(line, width, ELLIPSIS) : line,
        );
      },
      invalidate: () => {},
    };
    this.bodyScroll = new OverflowScrollView(bodyView, {
      follow: options.follow,
      onScroll: (top) => {
        this.pendingPinToBottom = false;
        this.scrollTop = top;
        if (this.bodyScroll.viewportHeight > 0) {
          this.followTail =
            this.followEndByDefault &&
            top >= Math.max(0, this.lastBodyCount - this.bodyScroll.viewportHeight);
        }
        this.onScrollRequestRender?.();
      },
      onLayout: () => {
        if (!this.pendingPinToBottom) return;
        this.pendingPinToBottom = false;
        this.bodyScroll.scrollToEnd();
        this.scrollTop = this.bodyScroll.scrollTop;
      },
    });
    const frame = new Box({
      border: true,
      borderColor: paintPrimary,
      padding: { left: 1 },
    });
    frame.addChild(this.bodyScroll);
    const footerView = createInteractiveChildView(
      this,
      (width) => [this.renderFooterLine(width, this.currentBodyHeight(), this.lastBodyCount)],
      (event) =>
        handleActionBarMouse({
          event,
          focused: this.focused,
          shownAt: this.shownAt,
          spans: this.footerSpans,
        }),
    );

    this.addChild(headerView, { basis: 1, shrink: 0 });
    this.addChild(frame, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    this.addChild(footerView, { basis: 1, shrink: 0 });
  }

  protected setRequestRender(requestRender: (() => void) | undefined): void {
    if (requestRender !== undefined) {
      this.onScrollRequestRender = requestRender;
    }
  }

  protected isAtBottom(): boolean {
    if (this.bodyScroll.viewportHeight > 0) {
      return (
        this.pendingPinToBottom ||
        this.bodyScroll.isFollowingEnd ||
        this.bodyScroll.scrollTop >= Math.max(0, this.lastBodyCount - this.bodyScroll.viewportHeight)
      );
    }
    return this.followTail || this.scrollTop >= this.regularMaxScroll();
  }

  protected syncAfterContentUpdate(pinToBottom: boolean, totalLines: number): void {
    this.lastBodyCount = totalLines;
    if (this.bodyScroll.viewportHeight > 0) {
      this.pendingPinToBottom = pinToBottom;
      return;
    }
    const max = Math.max(0, totalLines - this.regularViewableRows());
    if (pinToBottom) {
      this.scrollTop = max;
      this.followTail = this.followEndByDefault;
    } else {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, max));
    }
  }

  handleInput(data: string): void {
    const visible = this.activeViewableRows();
    const printable = printableChar(data);

    if (matchesKey(data, Key.escape) || printable === 'q' || printable === 'Q') {
      this.onClose();
      return;
    }
    if (this.handleExtraKey(data, printable)) return;

    if (matchesKey(data, Key.up) || printable === 'k') {
      this.scrollViewerBy(-1);
      return;
    }
    if (matchesKey(data, Key.down) || printable === 'j') {
      this.scrollViewerBy(1);
      return;
    }
    if (
      matchesKey(data, Key.pageUp) ||
      (this.enableHalfPageCtrlKeys && matchesKey(data, Key.ctrl('u'))) ||
      printable === ' ' ||
      data === '\u0002'
    ) {
      this.scrollViewerBy(-Math.max(1, visible - 1));
      return;
    }
    if (
      matchesKey(data, Key.pageDown) ||
      (this.enableHalfPageCtrlKeys && matchesKey(data, Key.ctrl('d'))) ||
      data === '\u0006'
    ) {
      this.scrollViewerBy(Math.max(1, visible - 1));
      return;
    }
    if (matchesKey(data, Key.home) || printable === 'g') {
      this.scrollViewerToStart();
      return;
    }
    if (matchesKey(data, Key.end) || printable === 'G') {
      this.scrollViewerToEnd();
      return;
    }
  }

  override render(width: number): string[] {
    const rows = Math.max(3, this.terminal.rows);
    const bodyHeight = rows - 2;
    const innerWidth = Math.max(1, width - 4);
    this.lastInnerWidth = innerWidth;
    const allLines = this.getBodyLines(innerWidth);
    this.lastBodyCount = allLines.length;

    const viewRows = Math.max(1, bodyHeight - 2);
    const max = Math.max(0, allLines.length - viewRows);
    if (this.followTail || this.pendingPinToBottom) {
      this.pendingPinToBottom = false;
      this.scrollTop = max;
    } else {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, max));
    }

    const header = this.renderHeaderLine(width);
    const sliced: string[] = [];
    for (let i = 0; i < viewRows; i++) {
      sliced.push(allLines[this.scrollTop + i] ?? '');
    }
    const box = new Box({
      border: true,
      borderColor: paintPrimary,
      padding: { left: 1, right: 1 },
    });
    box.addChild({
      render: (innerWidth) => sliced.map((line) => fitViewerLine(line, innerWidth)),
      invalidate: () => {},
    });
    const footer = this.renderFooterLine(width, bodyHeight, allLines.length);
    return [header, ...box.render(width), footer];
  }

  private scrollViewerBy(delta: number): void {
    this.pendingPinToBottom = false;
    if (this.bodyScroll.viewportHeight > 0) {
      this.bodyScroll.scrollBy(delta);
      this.scrollTop = this.bodyScroll.scrollTop;
      return;
    }
    const max = this.regularMaxScroll();
    const current = this.followTail ? max : this.scrollTop;
    const next = Math.max(0, Math.min(max, current + delta));
    this.scrollTop = next;
    this.followTail = this.followEndByDefault && next >= max;
    this.invalidate();
  }

  private scrollViewerToStart(): void {
    this.pendingPinToBottom = false;
    if (this.bodyScroll.viewportHeight > 0) {
      this.bodyScroll.scrollTo(0, { disableFollow: true });
      this.scrollTop = this.bodyScroll.scrollTop;
      this.followTail = false;
      return;
    }
    this.scrollTop = 0;
    this.followTail = false;
    this.invalidate();
  }

  private scrollViewerToEnd(): void {
    this.pendingPinToBottom = false;
    if (this.bodyScroll.viewportHeight > 0) {
      this.bodyScroll.scrollToEnd();
      this.scrollTop = this.bodyScroll.scrollTop;
      this.followTail = this.followEndByDefault;
      return;
    }
    this.scrollTop = this.regularMaxScroll();
    this.followTail = this.followEndByDefault;
    this.invalidate();
  }

  private currentBodyHeight(): number {
    if (this.bodyScroll.viewportHeight > 0) return this.bodyScroll.viewportHeight + 2;
    return Math.max(3, this.terminal.rows) - 2;
  }

  private activeViewableRows(): number {
    if (this.bodyScroll.viewportHeight > 0) return this.bodyScroll.viewportHeight;
    return this.regularViewableRows();
  }

  private regularViewableRows(): number {
    return Math.max(1, this.terminal.rows - 4);
  }

  private regularMaxScroll(): number {
    const count =
      this.lastBodyCount > 0 ? this.lastBodyCount : this.getBodyLines(this.lastInnerWidth).length;
    this.lastBodyCount = count;
    return Math.max(0, count - this.regularViewableRows());
  }

  private renderFooterLine(width: number, bodyHeight: number, total: number): string {
    const keyStyle = (text: string): string => currentTheme.boldFg('primary', text);
    const dimStyle = (text: string): string => currentTheme.fg('textMuted', text);

    const viewRows = Math.max(1, bodyHeight - 2);
    const activeTop =
      this.bodyScroll.viewportHeight > 0 ? this.bodyScroll.scrollTop : this.scrollTop;
    const maxScroll = Math.max(0, total - viewRows);
    const clampedTop = Math.max(0, Math.min(activeTop, maxScroll));
    const percent = maxScroll === 0 ? 100 : Math.round((clampedTop / maxScroll) * 100);
    const lineFrom = total === 0 ? 0 : clampedTop + 1;
    const lineTo = Math.min(total, clampedTop + viewRows);

    const position = currentTheme.fg(
      'textMuted',
      ` ${String(lineFrom)}-${String(lineTo)} / ${String(total)} (${String(percent)}%) `,
    );

    const spans: MouseActionSpan[] = [];
    let col = 1;
    const chunks: string[] = [];
    for (const item of this.getFooterItems()) {
      const rendered = `${keyStyle(item.keys)} ${dimStyle(item.label)}`;
      const itemWidth = visibleWidth(rendered);
      if (item.onClick !== undefined && col < width) {
        spans.push({
          start: col,
          end: Math.min(width, col + itemWidth),
          onClick: item.onClick,
        });
      }
      chunks.push(rendered);
      col += itemWidth + 2;
    }
    this.footerSpans = spans;

    const left = ` ${chunks.join('  ')}`;
    const leftW = visibleWidth(left);
    const rightW = visibleWidth(position);
    if (leftW + 2 + rightW <= width) {
      return left + ' '.repeat(width - leftW - rightW) + position;
    }
    return fitViewerLine(left, width);
  }

  protected handleExtraKey(_data: string, _printable: string | undefined): boolean {
    return false;
  }

  protected abstract renderHeaderLine(width: number): string;
  protected abstract getBodyLines(innerWidth: number): readonly string[];
  protected abstract getFooterItems(): readonly ViewerFooterItem[];
  protected abstract onClose(): void;
}
