import {
  decorateRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Text,
  textRenderLine,
  truncateRenderLine,
  withRenderLineText,
  type Component,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData, BackgroundAgentStatusPhase } from '#/tui/types';

import type { TranscriptRowParts } from './transcript-row-layout';

export class BackgroundAgentStatusComponent implements Component {
  constructor(private readonly data: BackgroundAgentStatusData) {}

  get phase(): BackgroundAgentStatusPhase {
    return this.data.phase;
  }

  invalidate(): void {}

  renderTranscriptRow(width: number): TranscriptRowParts {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= MESSAGE_INDENT.length) {
      const gutterLines = this[RENDER_LINES](safeWidth);
      return {
        gutterWidth: safeWidth,
        gutterLines,
        contentLines: gutterLines.map(() => textRenderLine('')),
      };
    }

    const tone: keyof ColorPalette =
      this.data.phase === 'started'
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
    const contentLines = renderComponentLines(
      new Text(text, 0, 0),
      safeWidth - MESSAGE_INDENT.length,
    ).map((line) => withRenderLineText(line, line.text.trimEnd()));
    return {
      gutterWidth: MESSAGE_INDENT.length,
      gutterLines: [
        textRenderLine(''),
        ...contentLines.map((_, index) =>
          textRenderLine(index === 0 ? bullet : MESSAGE_INDENT),
        ),
      ],
      contentLines: [textRenderLine(''), ...contentLines],
    };
  }

  selectionExclusions() {
    return [{ start: 0, end: MESSAGE_INDENT.length }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [textRenderLine('')];

    const tone: keyof ColorPalette =
      this.data.phase === 'started'
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
    const contentLines = renderComponentLines(textComponent, contentWidth);
    const lines = contentLines.map((line, index) =>
      truncateRenderLine(
        decorateRenderLine(line, index === 0 ? bullet : MESSAGE_INDENT),
        safeWidth,
        '…',
      ),
    );
    return [textRenderLine(''), ...lines];
  }
}
