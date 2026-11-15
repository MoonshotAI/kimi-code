import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export type ApiKeyInputResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

const FOOTER = 'Enter to submit  ·  Esc to cancel';

function maskInputLine(raw: string, fakeCursorIndex: number): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  const content = raw.slice(prefix.length);

  // Protect ANSI escape sequences (reverse-video cursor, IME marker, etc.)
  // while masking every other visible character.
  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:[^\u0007]+\u0007))/);
  const lastTextIndex = parts.findLastIndex((part) => part.length > 0 && !part.startsWith('\u001B'));
  if (lastTextIndex >= 0) parts[lastTextIndex] = parts[lastTextIndex]!.replace(/\s+$/u, '');
  let maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // ANSI sequence
      return part.replaceAll(/./g, '•');
    })
    .join('');

  const fakeCursorMarker = '\u001B_pi:fc\u0007';
  const markerIndex = content.indexOf(fakeCursorMarker);
  const cursorIndex = markerIndex >= 0 ? markerIndex + fakeCursorMarker.length : fakeCursorIndex;
  if (maskedContent[cursorIndex] === '•') {
    maskedContent = maskedContent.slice(0, cursorIndex) + ' ' + maskedContent.slice(cursorIndex + 1);
  }
  return prefix + maskedContent;
}

export class ApiKeyInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly onDone: (result: ApiKeyInputResult) => void;
  private readonly title: string;
  private readonly subtitleLines: readonly string[];
  private readonly mask: boolean;
  private readonly emptyHint: string;
  private done = false;
  private emptyHinted = false;

  constructor(
    platformName: string,
    subtitleLines: readonly string[],
    onDone: (result: ApiKeyInputResult) => void,
    private readonly options?: { title?: string; mask?: boolean; emptyHint?: string; trimValue?: boolean },
  ) {
    super();
    this.onDone = onDone;
    this.title = options?.title ?? `Enter API key for ${platformName}`;
    this.subtitleLines = subtitleLines;
    this.mask = options?.mask ?? true;
    this.emptyHint = options?.emptyHint ?? 'API key cannot be empty.';
    this.input.onSubmit = (value) => {
      this.submit(value);
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
    if (this.emptyHinted) {
      this.emptyHinted = false;
    }
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', this.title);
    const subtitleSource = this.emptyHinted ? [this.emptyHint] : this.subtitleLines;
    const subtitleLines = subtitleSource.map((line) =>
      truncateToWidth(currentTheme.fg('textDim', line), innerWidth, '…'),
    );
    const footerStyled = currentTheme.fg('textDim', FOOTER);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const rawInputLine = this.input.render(innerWidth)[0] ?? '> ';
    const inputLine =
      this.mask && this.input.getValue() !== '' ? maskInputLine(rawInputLine, this.input.getValue().length) : rawInputLine;

    const contentLines: string[] = [
      titleLine,
      '',
      ...subtitleLines,
      '',
      inputLine,
      '',
      footerLine,
    ];

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

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

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private submit(value: string): void {
    if (this.done) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      this.emptyHinted = true;
      return;
    }
    this.done = true;
    this.onDone({ kind: 'ok', value: this.options?.trimValue === false ? value : trimmed });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}
