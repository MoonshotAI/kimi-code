import type { Component } from '@moonshot-ai/pi-tui';
import { Spacer, Text, visibleWidth } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { McpChannelTranscriptData } from '#/tui/types';

export class McpChannelMessageComponent implements Component {
  private readonly spacer = new Spacer(1);
  private readonly title: string;
  private readonly detail: string | undefined;
  private readonly textText: Text;
  private readonly text: string;

  constructor(text: string, data: McpChannelTranscriptData) {
    this.title = `Message received via ${data.server}`;
    this.detail = data.chatId !== undefined ? `chat ${data.chatId}` : undefined;
    this.text = text;
    this.textText = new Text(currentTheme.fg('text', text), 0, 0);
  }

  invalidate(): void {
    this.textText.setText(currentTheme.fg('text', this.text));
    this.textText.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const bullet = currentTheme.boldFg('accent', STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const continuationIndent = ' '.repeat(bulletWidth);
    const lines: string[] = [];

    for (const line of this.spacer.render(safeWidth)) {
      lines.push(line);
    }

    const titleLines = new Text(currentTheme.boldFg('accent', this.title), 0, 0).render(contentWidth);
    for (let i = 0; i < titleLines.length; i += 1) {
      lines.push(`${i === 0 ? bullet : continuationIndent}${titleLines[i]}`);
    }

    if (this.detail !== undefined) {
      const detailLines = new Text(currentTheme.fg('textDim', this.detail), 0, 0).render(contentWidth);
      for (const line of detailLines) {
        lines.push(`${continuationIndent}${line}`);
      }
    }

    const textLines = this.textText.render(contentWidth);
    for (const line of textLines) {
      lines.push(`${continuationIndent}${line}`);
    }

    return lines;
  }
}
