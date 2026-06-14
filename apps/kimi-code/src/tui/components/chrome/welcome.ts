/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box with the logo, session, model, and version.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { isRainbowDancing, renderDanceWelcomeHeader } from '#/tui/easter-eggs/dance';
import type { AppState } from '#/tui/types';
import { currentTheme } from '#/tui/theme';

export class WelcomeComponent implements Component {
  private state: AppState;

  constructor(state: AppState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const primary = (s: string): string => chalk.hex(currentTheme.palette.primary)(s);
    const innerWidth = Math.max(10, width - 4);
    const pad = '  ';

    // Logo + side-by-side text.
    const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
    const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);

    const rightRow0 = truncateToWidth(
      chalk.bold.hex(currentTheme.palette.primary)('Welcome to Kimi Code!'),
      textWidth,
      '…',
    );
    const hasModel = this.state.model.length > 0;
    const hasConfiguredModels = Object.keys(this.state.availableModels).length > 0;
    const needsProvider = !hasModel && !hasConfiguredModels;
    const dim = chalk.hex(currentTheme.palette.textDim);
    const labelStyle = chalk.bold.hex(currentTheme.palette.textDim);
    const rightRow1 = truncateToWidth(
      dim(
        needsProvider
          ? 'Run /login or /provider to get started.'
          : hasModel
            ? 'Send /help for help information.'
            : 'Pick a session or send /model to choose one.',
      ),
      textWidth,
      '…',
    );

    let renderedHeaderLines = [
      primary(logo[0].padEnd(logoWidth)) + gap + rightRow0,
      primary(logo[1].padEnd(logoWidth)) + gap + rightRow1,
    ];
    if (isRainbowDancing()) {
      renderedHeaderLines = renderDanceWelcomeHeader(logo, textWidth, rightRow1);
    }

    const activeModel = this.state.availableModels[this.state.model];
    const modelValue = !hasModel
      ? needsProvider
        ? chalk.hex(currentTheme.palette.warning)('not set, run /login or /provider')
        : dim('not selected')
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);

    const infoLines = [
      labelStyle('Directory: ') + this.state.workDir,
      labelStyle('Session:   ') + this.state.sessionId,
      labelStyle('Model:     ') + modelValue,
      labelStyle('Version:   ') + this.state.version,
    ];

    if (this.state.mcpServersSummary) {
      infoLines.push(labelStyle('MCP:       ') + this.state.mcpServersSummary);
    }

    const contentLines: string[] = [...renderedHeaderLines, '', ...infoLines];

    const lines: string[] = [
      '',
      primary('╭' + '─'.repeat(width - 2) + '╮'),
      primary('│') + ' '.repeat(width - 2) + primary('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('│') + ' '.repeat(width - 2) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(width - 2) + '╯'));
    lines.push('');

    return lines;
  }
}
