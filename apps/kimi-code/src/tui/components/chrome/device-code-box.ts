/**
 * OAuth device-code panel rendered inside the transcript.
 *
 * Borrows the rounded-border layout from `WelcomeComponent` so the login
 * prompt matches the rest of the chrome. All colors flow through the
 * active palette so theme switches take effect on the next render.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export interface DeviceCodeBoxParams {
  readonly title: string;
  readonly url: string;
  readonly code: string;
  readonly hint?: string;
}

export class DeviceCodeBoxComponent implements Component {
  private readonly params: DeviceCodeBoxParams;

  constructor(params: DeviceCodeBoxParams) {
    this.params = params;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { title, url, code, hint } = this.params;
    const border = (s: string): string => currentTheme.fg('primary', s);
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const titleLine = truncateToWidth(currentTheme.boldFg('textStrong', title), innerWidth, '…');
    const promptLine = truncateToWidth(
      currentTheme.fg('textDim', 'Visit the URL below in your browser to authorize:'),
      innerWidth,
      '…',
    );
    const urlLine = truncateToWidth(currentTheme.fg('primary', url), innerWidth, '…');

    const codeLabel = currentTheme.boldFg('textDim', 'Verification code:  ');
    const codeValue = currentTheme.boldFg('accent', code);
    const codeLine = truncateToWidth(`${codeLabel}${codeValue}`, innerWidth, '…');

    const contentLines: string[] = [titleLine, '', promptLine, urlLine, '', codeLine];
    if (hint !== undefined && hint.length > 0) {
      contentLines.push('');
      contentLines.push(truncateToWidth(currentTheme.fg('textDim', hint), innerWidth, '…'));
    }

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const truncated = content;
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + truncated + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
