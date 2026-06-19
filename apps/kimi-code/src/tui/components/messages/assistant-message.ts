/**
 * Renders an assistant message using pi-tui Markdown.
 *
 * Displays a white bullet prefix with markdown content indented
 * to align after the bullet.
 */

import { Container, Markdown, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private lastText = '';
  private showBullet: boolean;

  constructor(showBullet: boolean = true) {
    this.showBullet = showBullet;
    this.contentContainer = new Container();
  }

  setShowBullet(show: boolean): void {
    this.showBullet = show;
  }

  updateContent(text: string): void {
    const displayText = text;
    if (displayText === this.lastText) return;
    this.lastText = displayText;
    this.contentContainer.clear();
    if (displayText.trim().length > 0) {
      this.contentContainer.addChild(new Markdown(displayText.trim(), 0, 0, createMarkdownTheme()));
    }
  }

  invalidate(): void {
    // Markdown caches ANSI colour codes keyed on (text, width).  When the
    // theme changes the cached strings contain stale colours, so we rebuild
    // the Markdown child with the new theme.
    this.contentContainer.clear();
    if (this.lastText.trim().length > 0) {
      this.contentContainer.addChild(
        new Markdown(this.lastText.trim(), 0, 0, createMarkdownTheme()),
      );
    }
  }

  render(width: number): string[] {
    if (this.lastText.trim().length === 0) return [];

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const contentWidth = Math.max(1, safeWidth - visibleWidth(prefix));
    const contentLines = this.contentContainer.render(contentWidth);

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p =
        i === 0 && this.showBullet ? currentTheme.fg('text', STATUS_BULLET) : MESSAGE_INDENT;
      lines.push(p + contentLines[i]);
    }
    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
