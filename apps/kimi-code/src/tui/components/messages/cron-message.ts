import {
  decorateRenderLine,
  RENDER_LINES,
  renderComponentLines,
  renderLineTexts,
  Spacer,
  Text,
  textRenderLine,
  truncateRenderLine,
  visibleWidth,
  withRenderLineText,
  type Component,
  type TuiRenderLine,
} from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { CronTranscriptData } from '#/tui/types';

import type { TranscriptRowParts } from './transcript-row-layout';

export class CronMessageComponent implements Component {
  private readonly spacer = new Spacer(1);
  private readonly data: CronTranscriptData;
  private readonly title: string;
  private readonly detail: string | undefined;
  private readonly promptText: Text;
  private readonly prompt: string;

  constructor(
    prompt: string,
    data: CronTranscriptData,
  ) {
    const missed = data.missedCount !== undefined;
    this.data = data;
    this.title = missed ? 'Missed scheduled reminders' : 'Scheduled reminder fired';
    this.detail = cronDetail(data);
    this.prompt = prompt;
    this.promptText = new Text(currentTheme.fg('text', prompt), 0, 0);
  }

  invalidate(): void {
    this.promptText.setText(currentTheme.fg('text', this.prompt));
    this.promptText.invalidate();
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const safeWidth = Math.max(0, width);
    const gutterWidth = visibleWidth(STATUS_BULLET);
    if (safeWidth <= gutterWidth) {
      const gutterLines = this[RENDER_LINES](safeWidth);
      return {
        gutterWidth: safeWidth,
        gutterLines,
        contentLines: gutterLines.map(() => textRenderLine('')),
      };
    }

    const missed = this.data.missedCount !== undefined;
    const titleToken: keyof ColorPalette = this.data.stale === true || missed ? 'warning' : 'accent';
    const bullet = currentTheme.boldFg(titleToken, STATUS_BULLET);
    const contentWidth = safeWidth - gutterWidth;
    const contentLines: TuiRenderLine[] = [textRenderLine('')];
    const gutterLines: TuiRenderLine[] = [textRenderLine('')];
    const appendLines = (lines: TuiRenderLine[], firstPrefix?: string): void => {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        contentLines.push(withRenderLineText(line, line.text.trimEnd()));
        gutterLines.push(
          textRenderLine(i === 0 && firstPrefix !== undefined ? firstPrefix : MESSAGE_INDENT),
        );
      }
    };

    appendLines(
      renderComponentLines(new Text(currentTheme.boldFg(titleToken, this.title), 0, 0), contentWidth),
      bullet,
    );
    if (this.detail !== undefined) {
      appendLines(
        renderComponentLines(
          new Text(currentTheme.fg('textDim', this.detail), 0, 0),
          contentWidth,
        ),
      );
    }
    appendLines(renderComponentLines(this.promptText, contentWidth));
    return { gutterWidth, gutterLines, contentLines };
  }

  selectionExclusions() {
    return [{ start: 0, end: visibleWidth(STATUS_BULLET) }];
  }

  render(width: number): string[] {
    return renderLineTexts(this[RENDER_LINES](width));
  }

  [RENDER_LINES](width: number): TuiRenderLine[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [textRenderLine('')];

    const missed = this.data.missedCount !== undefined;
    const titleToken: keyof ColorPalette = this.data.stale === true || missed ? 'warning' : 'accent';
    const bullet = currentTheme.boldFg(titleToken, STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const continuationIndent = ' '.repeat(bulletWidth);
    const lines: TuiRenderLine[] = [...renderComponentLines(this.spacer, safeWidth)];
    const appendLines = (contentLines: TuiRenderLine[], firstPrefix?: string): void => {
      for (let i = 0; i < contentLines.length; i += 1) {
        const prefix = i === 0 && firstPrefix !== undefined ? firstPrefix : continuationIndent;
        lines.push(
          truncateRenderLine(decorateRenderLine(contentLines[i]!, prefix), safeWidth, '…'),
        );
      }
    };

    appendLines(
      renderComponentLines(new Text(currentTheme.boldFg(titleToken, this.title), 0, 0), contentWidth),
      bullet,
    );

    if (this.detail !== undefined) {
      appendLines(
        renderComponentLines(new Text(currentTheme.fg('textDim', this.detail), 0, 0), contentWidth),
      );
    }

    appendLines(renderComponentLines(this.promptText, contentWidth));
    return lines;
  }
}

function cronDetail(data: CronTranscriptData): string | undefined {
  const parts: string[] = [];
  if (data.cron !== undefined && data.cron.length > 0) parts.push(data.cron);
  if (data.jobId !== undefined && data.jobId.length > 0) parts.push(`job ${data.jobId}`);
  if (data.recurring === false) parts.push('one-shot');
  if (data.coalescedCount !== undefined && data.coalescedCount > 1) {
    parts.push(`${String(data.coalescedCount)} fires coalesced`);
  }
  if (data.missedCount !== undefined) {
    parts.push(`${String(data.missedCount)} missed`);
  }
  if (data.stale === true) parts.push('final delivery');
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
