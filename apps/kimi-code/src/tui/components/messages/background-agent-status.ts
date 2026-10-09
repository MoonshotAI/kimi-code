import { Text, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';

const MONITOR_EVENT_VISIBLE_LINES = 6;

export class BackgroundAgentStatusComponent implements Component {
  constructor(private readonly data: BackgroundAgentStatusData) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const tone: keyof ColorPalette =
      this.data.phase === 'started' || this.data.phase === 'event'
        ? 'primary'
        : this.data.phase === 'completed'
          ? 'success'
          : 'error';

    const bullet =
      this.data.phase === 'failed' || this.data.phase === 'killed'
        ? currentTheme.fg(tone, FAILURE_MARK)
        : currentTheme.fg(tone, STATUS_BULLET);
    const text =
      currentTheme.fg(tone, this.data.headline) +
      (this.data.detail !== undefined && this.data.detail.length > 0
        ? currentTheme.fg('textDim', ` (${this.data.detail})`)
        : '');

    const textComponent = new Text(text, 0, 0);
    const contentWidth = Math.max(1, safeWidth - MESSAGE_INDENT.length);
    const contentLines = textComponent.render(contentWidth);
    return [
      '',
      ...contentLines.map((line, index) => (index === 0 ? bullet : MESSAGE_INDENT) + line),
      ...this.renderLines(),
    ].map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private renderLines(): string[] {
    const lines = this.data.lines ?? [];
    const overflow = Math.max(0, lines.length - MONITOR_EVENT_VISIBLE_LINES);
    const rendered = lines.slice(overflow).map((line) => MESSAGE_INDENT + currentTheme.fg('textDim', line));
    const hidden = overflow + (this.data.omittedLines ?? 0);
    if (hidden === 0) return rendered;
    const label = `… ${String(hidden)} earlier ${hidden === 1 ? 'line' : 'lines'} (full log in the task output)`;
    return [MESSAGE_INDENT + currentTheme.fg('textDim', label), ...rendered];
  }
}
