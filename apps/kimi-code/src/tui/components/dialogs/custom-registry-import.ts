/**
 * CustomRegistryImportDialog — blue rounded box that collects a custom
 * registry URL and a Bearer token before importing the registry's
 * provider entries.
 *
 * Geometry mirrors `ApiKeyInputDialogComponent` so the chrome stays
 * consistent with the API-key login flow. Two fields, switched with
 * Tab / Shift-Tab / Up / Down; Enter advances to the next field (and submits
 * on the last field), Esc cancels. Both fields are required.
 */

import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export interface CustomRegistryImportValue {
  readonly url: string;
  readonly apiKey: string;
}

export type CustomRegistryImportResult =
  | { readonly kind: 'ok'; readonly value: CustomRegistryImportValue }
  | { readonly kind: 'cancel' };

const TITLE = 'Import custom provider registry';
const SUBTITLE_DEFAULT = 'Paste an api.json URL and its Bearer token.';
const SUBTITLE_URL_EMPTY = 'Registry URL cannot be empty.';
const SUBTITLE_TOKEN_EMPTY = 'Bearer token cannot be empty.';
const FOOTER_NOT_LAST = 'Tab / ↑↓ to switch  ·  Enter for next field  ·  Esc to cancel';
const FOOTER_LAST = 'Tab / ↑↓ to switch  ·  Enter to submit  ·  Esc to cancel';

type FieldId = 'url' | 'token';

function maskInputLine(raw: string): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  // Strip trailing padding spaces so they stay as spaces.
  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  // Protect ANSI escape sequences (reverse-video cursor, IME marker, etc.)
  // while masking every other visible character.
  const parts = content.split(/((?:\[[0-9;]*m|_pi:c))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // ANSI sequence
      return part.replaceAll(/[^ ]/g, '•');
    })
    .join('');

  return prefix + maskedContent + padding;
}

export class CustomRegistryImportDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly urlInput = new Input();
  private readonly tokenInput = new Input();
  private readonly onDone: (result: CustomRegistryImportResult) => void;
  private readonly colors: ColorPalette;
  private activeField: FieldId = 'url';
  private done = false;
  private hint: 'none' | 'url-empty' | 'token-empty' = 'none';

  constructor(
    onDone: (result: CustomRegistryImportResult) => void,
    colors: ColorPalette,
    defaultUrl: string = '',
  ) {
    super();
    this.onDone = onDone;
    this.colors = colors;
    if (defaultUrl.length > 0) this.urlInput.setValue(defaultUrl);
    // Enter on the URL field advances to the token field; Enter on the token
    // (last) field submits.
    this.urlInput.onSubmit = () => {
      this.focusField('token');
    };
    this.tokenInput.onSubmit = () => {
      this.handleSubmit();
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
      this.toggleField();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.focusField('token');
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.focusField('url');
      return;
    }

    if (this.hint !== 'none') {
      this.hint = 'none';
    }

    if (this.activeField === 'url') {
      this.urlInput.handleInput(data);
    } else {
      this.tokenInput.handleInput(data);
    }
  }

  override invalidate(): void {
    super.invalidate();
    this.urlInput.invalidate();
    this.tokenInput.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && !this.done;
    this.urlInput.focused = dialogActive && this.activeField === 'url';
    this.tokenInput.focused = dialogActive && this.activeField === 'token';

    const safeWidth = Math.max(36, width);
    const innerWidth = Math.max(10, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => chalk.hex(this.colors.primary)(s);
    const titleStyled = chalk.bold.hex(this.colors.textStrong)(TITLE);
    const subtitleText =
      this.hint === 'url-empty'
        ? SUBTITLE_URL_EMPTY
        : this.hint === 'token-empty'
          ? SUBTITLE_TOKEN_EMPTY
          : SUBTITLE_DEFAULT;
    const subtitleStyled = chalk.hex(this.colors.textDim)(subtitleText);
    const footerStyled = chalk.hex(this.colors.textDim)(
      this.activeField === 'url' ? FOOTER_NOT_LAST : FOOTER_LAST,
    );

    const urlLabelText = 'Registry URL';
    const tokenLabelText = 'Bearer token';
    const urlLabelStyled =
      this.activeField === 'url'
        ? chalk.bold.hex(this.colors.accent)(urlLabelText)
        : chalk.hex(this.colors.textDim)(urlLabelText);
    const tokenLabelStyled =
      this.activeField === 'token'
        ? chalk.bold.hex(this.colors.accent)(tokenLabelText)
        : chalk.hex(this.colors.textDim)(tokenLabelText);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const urlLabelLine = truncateToWidth(urlLabelStyled, innerWidth, '…');
    const tokenLabelLine = truncateToWidth(tokenLabelStyled, innerWidth, '…');
    const urlInputLine = this.urlInput.render(innerWidth)[0] ?? '> ';
    const rawTokenInputLine = this.tokenInput.render(innerWidth)[0] ?? '> ';
    const tokenInputLine = maskInputLine(rawTokenInputLine);

    const contentLines: string[] = [
      titleLine,
      '',
      subtitleLine,
      '',
      urlLabelLine,
      urlInputLine,
      '',
      tokenLabelLine,
      tokenInputLine,
      '',
      footerLine,
    ];

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines;
  }

  private toggleField(): void {
    this.focusField(this.activeField === 'url' ? 'token' : 'url');
  }

  private focusField(field: FieldId): void {
    this.hint = 'none';
    this.activeField = field;
  }

  private handleSubmit(): void {
    if (this.done) return;

    const urlValue = this.urlInput.getValue().trim();
    const tokenValue = this.tokenInput.getValue().trim();

    if (urlValue.length === 0) {
      this.hint = 'url-empty';
      this.activeField = 'url';
      return;
    }
    if (tokenValue.length === 0) {
      this.hint = 'token-empty';
      this.activeField = 'token';
      return;
    }

    this.done = true;
    this.onDone({ kind: 'ok', value: { url: urlValue, apiKey: tokenValue } });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
