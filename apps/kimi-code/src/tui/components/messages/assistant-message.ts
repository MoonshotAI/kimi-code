/**
 * Renders an assistant message using pi-tui Markdown.
 *
 * Displays a white bullet prefix with markdown content indented
 * to align after the bullet.
 */

import type { Component, DefaultTextStyle, MarkdownTheme } from '@earendil-works/pi-tui';
import { Container, Markdown, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

export class AssistantMessageComponent implements Component {
  private contentContainer: Container;
  private markdownTheme: MarkdownTheme;
  private defaultTextStyle: DefaultTextStyle;
  private bulletColor: string;
  private lastText = '';
  private showBullet: boolean;

  constructor(markdownTheme: MarkdownTheme, colors: ColorPalette, showBullet: boolean = true) {
    this.markdownTheme = markdownTheme;
    this.defaultTextStyle = { color: (text) => chalk.hex(colors.text)(text) };
    this.bulletColor = colors.roleAssistant;
    this.showBullet = showBullet;
    this.contentContainer = new Container();
  }

  setShowBullet(show: boolean): void {
    this.showBullet = show;
  }

  applyTheme(markdownTheme: MarkdownTheme, colors: ColorPalette): void {
    this.markdownTheme = markdownTheme;
    this.bulletColor = colors.roleAssistant;
    this.defaultTextStyle = { color: (text) => chalk.hex(colors.text)(text) };
    if (this.lastText) {
      this.contentContainer.clear();
      this.contentContainer.addChild(
        new Markdown(this.lastText.trim(), 0, 0, this.markdownTheme, this.defaultTextStyle),
      );
    }
  }

  updateContent(text: string): void {
    const displayText = text;
    if (displayText === this.lastText) return;
    this.lastText = displayText;
    this.contentContainer.clear();
    if (displayText.trim().length > 0) {
      this.contentContainer.addChild(new Markdown(displayText.trim(), 0, 0, this.markdownTheme, this.defaultTextStyle));
    }
  }

  invalidate(): void {
    this.contentContainer.invalidate?.();
  }

  render(width: number): string[] {
    if (this.lastText.trim().length === 0) return [];

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const contentWidth = Math.max(1, width - visibleWidth(prefix));
    const contentLines = this.contentContainer.render(contentWidth);

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p =
        i === 0 && this.showBullet ? chalk.hex(this.bulletColor)(STATUS_BULLET) : MESSAGE_INDENT;
      lines.push(p + contentLines[i]);
    }
    return lines;
  }
}
