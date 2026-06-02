import type { Component, Focusable, MarkdownTheme } from '@earendil-works/pi-tui';
import {
  Key,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { THINKING_PREVIEW_LINES } from '../constant/rendering';
import type { ColorPalette } from '../theme/colors';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

type BtwPanelPhase = 'running' | 'done' | 'failed';

export interface BtwPanelOptions {
  readonly colors: ColorPalette;
  readonly markdownTheme: MarkdownTheme;
  readonly onClose: () => void;
  readonly onCancel: () => void;
}

export async function handleBtwCommand(host: SlashCommandHost, args: string): Promise<void> {
  const prompt = args.trim();
  if (prompt.length === 0) {
    host.showError('Usage: /btw <question>');
    return;
  }

  const session = host.session;
  if (host.state.appState.model.trim().length === 0 || session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  try {
    await session.startBtw(prompt);
  } catch (error) {
    host.showError(`Failed to start /btw: ${formatErrorMessage(error)}`);
  }
}

export class BtwPanelComponent implements Component, Focusable {
  private answer = '';
  private thinking = '';
  private error: string | undefined;
  private phase: BtwPanelPhase = 'running';
  focused = false;

  constructor(private readonly options: BtwPanelOptions) {}

  appendAnswer(delta: string): void {
    this.answer += delta;
  }

  appendThinking(delta: string): void {
    this.thinking += delta;
  }

  markDone(resultSummary?: string | undefined): void {
    if (this.answer.trim().length === 0 && resultSummary !== undefined) {
      this.answer = resultSummary;
    }
    this.phase = 'done';
  }

  markFailed(error: string): void {
    this.error = error;
    this.phase = 'failed';
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const contentWidth = Math.max(1, safeWidth - 4);
    const lines = [this.renderTopBorder(safeWidth)];
    for (const line of this.renderBody(contentWidth)) {
      lines.push(this.renderBodyLine(line, safeWidth));
    }
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.phase === 'running') {
        this.options.onCancel();
      } else {
        this.options.onClose();
      }
      return;
    }
    if (matchesKey(data, Key.enter) && this.phase !== 'running') {
      this.options.onClose();
    }
  }

  private renderTopBorder(width: number): string {
    const paint = (s: string): string => chalk.hex(this.options.colors.border)(s);
    const title = `${chalk.hex(this.options.colors.accent).bold(' BTW ')}${this.renderPhase()} `;
    const innerWidth = Math.max(1, width - 2);
    const clippedTitle =
      visibleWidth(title) > innerWidth ? truncateToWidth(title, innerWidth, '') : title;
    const dashCount = Math.max(0, innerWidth - visibleWidth(clippedTitle));
    return paint('╭') + clippedTitle + paint('─'.repeat(dashCount)) + paint('╮');
  }

  private renderPhase(): string {
    switch (this.phase) {
      case 'done':
        return chalk.hex(this.options.colors.success)('done');
      case 'failed':
        return chalk.hex(this.options.colors.error)('failed');
      case 'running':
        return chalk.hex(this.options.colors.textMuted)('running');
    }
  }

  private renderBody(width: number): string[] {
    if (this.error !== undefined) {
      return [
        ...new Text(chalk.hex(this.options.colors.error)(this.error), 0, 0).render(width),
        this.renderHint(),
      ];
    }
    const text = this.answer.trim();
    if (text.length > 0) {
      return [
        ...new Markdown(text, 0, 0, this.options.markdownTheme).render(width),
        this.renderHint(),
      ];
    }
    const thinking = this.thinking.trim();
    if (thinking.length > 0) {
      const lines = new Text(chalk.hex(this.options.colors.textDim)(thinking), 0, 0).render(width);
      const visibleLines =
        lines.length > THINKING_PREVIEW_LINES
          ? lines.slice(lines.length - THINKING_PREVIEW_LINES)
          : lines;
      return [...visibleLines, this.renderHint()];
    }
    return [chalk.hex(this.options.colors.textDim)('Waiting for answer...'), this.renderHint()];
  }

  private renderBodyLine(line: string, width: number): string {
    const paint = (s: string): string => chalk.hex(this.options.colors.border)(s);
    const contentWidth = Math.max(1, width - 4);
    const clipped =
      visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, '…') : line;
    const padding = Math.max(0, contentWidth - visibleWidth(clipped));
    return paint('│') + ' ' + clipped + ' '.repeat(padding) + ' ' + paint('│');
  }

  private renderHint(): string {
    const text = this.phase === 'running' ? 'Esc/Ctrl-C cancel' : 'Enter/Esc/Ctrl-C close';
    return chalk.hex(this.options.colors.textMuted)(text);
  }
}
