import type { Component, Focusable, MarkdownTheme } from '@earendil-works/pi-tui';
import {
  Input,
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

interface BtwTurn {
  readonly prompt: string;
  answer: string;
  thinking: string;
  error?: string | undefined;
  phase: BtwPanelPhase;
}

export interface BtwPanelOptions {
  readonly colors: ColorPalette;
  readonly markdownTheme: MarkdownTheme;
  readonly onPrompt: (prompt: string) => void;
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
    const agentId = await session.startBtw();
    host.openBtwPanel(agentId, prompt);
  } catch (error) {
    host.showError(`Failed to start /btw: ${formatErrorMessage(error)}`);
  }
}

export class BtwPanelComponent implements Component, Focusable {
  private readonly turns: BtwTurn[] = [];
  private readonly input = new Input();
  focused = false;

  constructor(private readonly options: BtwPanelOptions) {
    this.input.onSubmit = (value) => {
      if (this.isRunning()) return;
      const prompt = value.trim();
      if (prompt.length === 0) {
        this.options.onClose();
        return;
      }
      this.input.setValue('');
      this.submit(prompt);
    };
    this.input.onEscape = () => {
      if (this.isRunning()) {
        this.options.onCancel();
      } else {
        this.options.onClose();
      }
    };
  }

  submit(prompt: string): void {
    const normalized = prompt.trim();
    if (normalized.length === 0 || this.isRunning()) return;
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
    const lines = [this.renderTopBorder(safeWidth)];
    for (const line of this.renderBody(contentWidth)) {
      lines.push(this.renderBodyLine(line, safeWidth));
    }
    return lines;
  }

  handleInput(data: string): void {
    if (this.isRunning()) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
        this.options.onCancel();
      }
      return;
    }
    this.input.handleInput(data);
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
    const phase = this.currentTurn()?.phase ?? 'done';
    switch (phase) {
      case 'done':
        return chalk.hex(this.options.colors.success)('done');
      case 'failed':
        return chalk.hex(this.options.colors.error)('failed');
      case 'running':
        return chalk.hex(this.options.colors.textMuted)('running');
    }
  }

  private renderBody(width: number): string[] {
    const lines: string[] = [];
    for (const [index, turn] of this.turns.entries()) {
      if (index > 0) lines.push('');
      lines.push(...this.renderTurn(turn, width));
    }
    if (this.turns.length === 0) {
      lines.push(chalk.hex(this.options.colors.textDim)('Ready for a side question...'));
    }
    if (!this.isRunning()) {
      this.input.focused = this.focused;
      lines.push('');
      lines.push(this.renderInput(width));
    }
    lines.push(this.renderHint());
    return lines;
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

  private renderInput(width: number): string {
    const label = chalk.hex(this.options.colors.textMuted)('Ask: ');
    const inputWidth = Math.max(1, width - visibleWidth(label));
    const [line = ''] = this.input.render(inputWidth);
    return label + line;
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
    const text = this.isRunning()
      ? 'Esc/Ctrl-C cancel'
      : 'Type follow-up, Enter send, empty Enter/Esc/Ctrl-C close';
    return chalk.hex(this.options.colors.textMuted)(text);
  }

  private currentTurn(): BtwTurn | undefined {
    return this.turns.at(-1);
  }

  private isRunning(): boolean {
    return this.currentTurn()?.phase === 'running';
  }
}
