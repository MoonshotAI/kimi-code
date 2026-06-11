import type { Component } from '@earendil-works/pi-tui';
import { Spacer, Text, visibleWidth } from '@earendil-works/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { CronTranscriptData } from '#/tui/types';

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

  render(width: number): string[] {
    const missed = this.data.missedCount !== undefined;
    const titleToken: keyof ColorPalette = this.data.stale === true || missed ? 'warning' : 'accent';
    const bullet = currentTheme.boldFg(titleToken, STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, width - bulletWidth);
    const lines: string[] = [];

    for (const line of this.spacer.render(width)) {
      lines.push(line);
    }

    const title = currentTheme.boldFg(titleToken, this.title);
    lines.push(`${bullet}${title}`);

    if (this.detail !== undefined) {
      lines.push(`${' '.repeat(bulletWidth)}${currentTheme.fg('textDim', this.detail)}`);
    }

    const promptLines = this.promptText.render(contentWidth);
    for (const line of promptLines) {
      lines.push(`${' '.repeat(bulletWidth)}${line}`);
    }

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
