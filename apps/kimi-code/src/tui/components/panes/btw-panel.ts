import type { Component, MarkdownTheme } from '@earendil-works/pi-tui';
import {
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { THINKING_PREVIEW_LINES } from '../../constant/rendering';
import type { ColorPalette } from '../../theme/colors';

type BtwPanelPhase = 'running' | 'done' | 'failed';

const MIN_COLLAPSED_PANEL_LINES = 3;

interface BtwTurn {
  readonly prompt: string;
  answer: string;
  thinking: string;
  error?: string | undefined;
  phase: BtwPanelPhase;
}

interface BtwBodyRender {
  readonly lines: string[];
  readonly truncated: boolean;
}

export interface BtwPanelOptions {
  readonly colors: ColorPalette;
  readonly markdownTheme: MarkdownTheme;
  readonly onPrompt: (prompt: string) => void;
  readonly terminalRows: () => number;
}

export class BtwPanelComponent implements Component {
  private readonly turns: BtwTurn[] = [];
  private minBodyLines = 0;
  private expanded = false;
  private followTail = true;
  private scrollTop = 0;
  private maxScrollTop = 0;

  constructor(private readonly options: BtwPanelOptions) {}

  submit(prompt: string): void {
    const normalized = prompt.trim();
    if (normalized.length === 0 || this.isRunning()) return;
    this.followTail = true;
    this.scrollTop = 0;
    this.turns.push({
      prompt: normalized,
      answer: '',
      thinking: '',
      phase: 'running',
    });
    this.options.onPrompt(normalized);
  }

  appendAnswer(delta: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    turn.answer += delta;
  }

  appendThinking(delta: string): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    turn.thinking += delta;
  }

  markDone(resultSummary?: string | undefined): void {
    const turn = this.currentTurn();
    if (turn === undefined) return;
    if (turn.answer.trim().length === 0 && resultSummary !== undefined) {
      turn.answer = resultSummary;
    }
    turn.phase = 'done';
  }

  markFailed(error: string): void {
    const turn = this.currentTurn();
    if (turn === undefined || turn.phase !== 'running') {
      this.turns.push({
        prompt: '',
        answer: '',
        thinking: '',
        error,
        phase: 'failed',
      });
      return;
    }
    turn.error = error;
    turn.phase = 'failed';
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(4, width);
    const contentWidth = Math.max(1, safeWidth - 4);
    const body = this.renderBody(contentWidth);
    const lines = [this.renderTopBorder(safeWidth, body.truncated)];
    for (const line of body.lines) {
      lines.push(this.renderBodyLine(line, safeWidth));
    }
    return lines;
  }

  private renderTopBorder(width: number, truncated: boolean): string {
    const paint = (s: string): string => chalk.hex(this.options.colors.border)(s);
    const hint = truncated
      ? 'Esc close · ↑↓ scroll · ctrl+o expand '
      : 'Esc close ';
    const title =
      chalk.hex(this.options.colors.accent).bold(' BTW ') +
      paint('─ ') +
      chalk.hex(this.options.colors.textMuted)(hint);
    const innerWidth = Math.max(1, width - 2);
    const clippedTitle =
      visibleWidth(title) > innerWidth ? truncateToWidth(title, innerWidth, '') : title;
    const dashCount = Math.max(0, innerWidth - visibleWidth(clippedTitle));
    return paint('╭') + clippedTitle + paint('─'.repeat(dashCount)) + paint('╮');
  }

  private renderBody(width: number): BtwBodyRender {
    const lines: string[] = [];
    for (const [index, turn] of this.turns.entries()) {
      if (index > 0) lines.push('');
      lines.push(...this.renderTurn(turn, width));
    }
    if (this.turns.length === 0) {
      lines.push(chalk.hex(this.options.colors.textDim)('Ready for a side question...'));
    }
    return this.fitBodyLines(lines);
  }

  private fitBodyLines(lines: string[]): BtwBodyRender {
    const bodyLimit = this.expanded ? undefined : this.collapsedBodyLimit();
    const targetUncapped = Math.max(this.minBodyLines, lines.length);
    const target =
      bodyLimit === undefined ? targetUncapped : Math.min(bodyLimit, targetUncapped);
    this.minBodyLines = Math.max(this.minBodyLines, target);

    if (lines.length > target) {
      this.maxScrollTop = lines.length - target;
      if (this.followTail) {
        this.scrollTop = this.maxScrollTop;
      } else {
        this.scrollTop = Math.min(this.scrollTop, this.maxScrollTop);
      }
      const start = this.scrollTop;
      return { lines: lines.slice(start, start + target), truncated: true };
    }

    this.followTail = true;
    this.scrollTop = 0;
    this.maxScrollTop = 0;
    const padded = [...lines];
    while (padded.length < target) {
      padded.push('');
    }
    return { lines: padded, truncated: false };
  }

  private collapsedBodyLimit(): number | undefined {
    const terminalRows = this.options.terminalRows();
    if (!Number.isFinite(terminalRows) || terminalRows <= 0) return undefined;
    const maxPanelLines = Math.max(MIN_COLLAPSED_PANEL_LINES, Math.floor(terminalRows / 2));
    return Math.max(1, maxPanelLines - 1);
  }

  private renderTurn(turn: BtwTurn, width: number): string[] {
    const prompt = chalk.hex(this.options.colors.accent)(`Q: ${turn.prompt}`);
    if (turn.error !== undefined) {
      return [
        ...new Text(prompt, 0, 0).render(width),
        ...new Text(chalk.hex(this.options.colors.error)(turn.error), 0, 0).render(width),
      ];
    }
    const answer = turn.answer.trim();
    if (answer.length > 0) {
      return [
        ...new Text(prompt, 0, 0).render(width),
        ...new Markdown(answer, 0, 0, this.options.markdownTheme).render(width),
      ];
    }
    const thinking = turn.thinking.trim();
    if (thinking.length > 0) {
      const thinkingLines = new Text(chalk.hex(this.options.colors.textDim)(thinking), 0, 0).render(
        width,
      );
      const visibleThinking =
        thinkingLines.length > THINKING_PREVIEW_LINES
          ? thinkingLines.slice(thinkingLines.length - THINKING_PREVIEW_LINES)
          : thinkingLines;
      return [...new Text(prompt, 0, 0).render(width), ...visibleThinking];
    }
    return [
      ...new Text(prompt, 0, 0).render(width),
      chalk.hex(this.options.colors.textDim)('Waiting for answer...'),
    ];
  }

  private renderBodyLine(line: string, width: number): string {
    const paint = (s: string): string => chalk.hex(this.options.colors.border)(s);
    const contentWidth = Math.max(1, width - 4);
    const clipped =
      visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, '…') : line;
    const padding = Math.max(0, contentWidth - visibleWidth(clipped));
    return paint('│') + ' ' + clipped + ' '.repeat(padding) + ' ' + paint('│');
  }

  private currentTurn(): BtwTurn | undefined {
    return this.turns.at(-1);
  }

  isRunning(): boolean {
    return this.currentTurn()?.phase === 'running';
  }

  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    this.followTail = true;
    this.scrollTop = 0;
    return this.expanded;
  }

  scroll(direction: 'up' | 'down'): boolean {
    if (this.maxScrollTop <= 0) return false;
    const current = this.followTail ? this.maxScrollTop : this.scrollTop;
    const next =
      direction === 'up'
        ? Math.max(0, current - 1)
        : Math.min(this.maxScrollTop, current + 1);
    this.scrollTop = next;
    this.followTail = next === this.maxScrollTop;
    return true;
  }
}
