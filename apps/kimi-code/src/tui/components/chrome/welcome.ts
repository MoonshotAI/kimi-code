/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box with the logo, session, model, and version.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { isRainbowDancing, renderDanceWelcomeHeader } from '#/tui/easter-eggs/dance';
import { i18n } from '#/tui/i18n';
import type { AppState } from '#/tui/types';
import { currentTheme } from '#/tui/theme';

export class WelcomeComponent implements Component {
  private state: AppState;

  constructor(state: AppState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const primary = (s: string): string => chalk.hex(currentTheme.palette.primary)(s);
    const isLoggedOut = !this.state.model;
    const activeModel = this.state.availableModels[this.state.model];

    if (safeWidth < 24) {
      const title = chalk.bold.hex(currentTheme.palette.primary)(i18n.t('components.welcome.title'));
      const prompt = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)(i18n.t('components.welcome.getStarted'))
        : chalk.hex(currentTheme.palette.textDim)(i18n.t('components.welcome.helpHint'));
      const model = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)(i18n.t('components.welcome.modelNotSet'))
        : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);
      const modelLabel = i18n.t('components.welcome.labels.model');
      return ['', title, prompt, `${modelLabel}: ${model}`].map((line) =>
        truncateToWidth(line, safeWidth, '…'),
      );
    }

    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    // Logo + side-by-side text.
    const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
    const logoWidth = Math.max(...logo.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - logoWidth - gap.length);

    const rightRow0 = truncateToWidth(
      chalk.bold.hex(currentTheme.palette.primary)(i18n.t('components.welcome.title')),
      textWidth,
      '…',
    );
    const dim = chalk.hex(currentTheme.palette.textDim);
    const labelStyle = chalk.bold.hex(currentTheme.palette.textDim);
    const rightRow1 = truncateToWidth(
      dim(
        isLoggedOut
          ? i18n.t('components.welcome.getStarted')
          : i18n.t('components.welcome.helpHint'),
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

    const modelValue = isLoggedOut
      ? chalk.hex(currentTheme.palette.warning)(i18n.t('components.welcome.modelNotSet'))
      : (activeModel?.displayName ?? activeModel?.model ?? this.state.model);

    const label = (key: string): string => `${i18n.t(`components.welcome.labels.${key}`)}:`;
    const infoFields: Array<[label: string, value: string]> = [
      [label('directory'), this.state.workDir],
      [label('session'), this.state.sessionId],
      [label('model'), modelValue],
      [label('version'), this.state.version],
    ];
    if (this.state.mcpServersSummary) {
      infoFields.push([label('mcp'), this.state.mcpServersSummary]);
    }

    // Pad each label to a common display width (not char count) plus one gap,
    // so the value column lines up regardless of locale — CJK labels are
    // double-width.
    const labelColWidth = Math.max(...infoFields.map(([text]) => visibleWidth(text))) + 1;
    const infoLines = infoFields.map(([text, value]) => {
      const padding = ' '.repeat(Math.max(0, labelColWidth - visibleWidth(text)));
      return labelStyle(text + padding) + value;
    });

    const contentLines: string[] = [...renderedHeaderLines, '', ...infoLines];

    const lines: string[] = [
      '',
      primary('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      primary('│') + ' '.repeat(safeWidth - 2) + primary('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('│') + ' '.repeat(safeWidth - 2) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
