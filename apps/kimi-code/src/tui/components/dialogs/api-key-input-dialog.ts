import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedClick,
  forwardEmbeddedMouse,
  type EmbeddedRect,
} from '#/tui/utils/mouse-regions';

export type ApiKeyInputResult =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'cancel' };

const FOOTER = 'Enter to submit  ·  Esc to cancel';

function maskInputLine(raw: string, fakeCursorIndex: number): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  const content = raw.slice(prefix.length);

  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:[^\u0007]+\u0007))/);
  const lastTextIndex = parts.findLastIndex((part) => part.length > 0 && !part.startsWith('\u001B'));
  if (lastTextIndex >= 0) parts[lastTextIndex] = parts[lastTextIndex]!.replace(/\s+$/u, '');
  let maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
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

export function renderPaddedDialogBox(
  contentLines: readonly string[],
  safeWidth: number,
  innerWidth: number,
): string[] {
  if (safeWidth < 4) {
    return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
  }
  const edge = currentTheme.fg('primary', '│');
  const innerSpan = safeWidth - 2;
  const blankRow = `${edge}${' '.repeat(innerSpan)}${edge}`;
  const framedRows = contentLines.map(
    (content) => `${edge}  ${content}${' '.repeat(Math.max(0, innerWidth - visibleWidth(content)))}${edge}`,
  );
  return [
    '',
    currentTheme.fg('primary', `╭${'─'.repeat(innerSpan)}╮`),
    blankRow,
    ...framedRows,
    blankRow,
    currentTheme.fg('primary', `╰${'─'.repeat(innerSpan)}╯`),
    '',
  ].map((line) => truncateToWidth(line, safeWidth, '…'));
}

export class ApiKeyInputDialogComponent implements Component, Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly onDone: (result: ApiKeyInputResult) => void;
  private readonly title: string;
  private readonly subtitleLines: readonly string[];
  private readonly mask: boolean;
  private readonly emptyHint: string;
  private done = false;
  private emptyHinted = false;
  private inputRect: EmbeddedRect | undefined;

  constructor(
    platformName: string,
    subtitleLines: readonly string[],
    onDone: (result: ApiKeyInputResult) => void,
    private readonly options?: { title?: string; mask?: boolean; emptyHint?: string; trimValue?: boolean },
  ) {
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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done) return undefined;
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (event.type === 'wheel') return { handled: true };
    if (event.type === 'press' && event.button === 'left') {
      const forwarded = forwardEmbeddedMouse(this.input, this.inputRect, event);
      return forwarded === undefined ? undefined : { ...forwarded, render: true };
    }
    return undefined;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) {
      this.inputRect = undefined;
      return [''];
    }
    const innerWidth = Math.max(1, safeWidth - 4);
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

    const inputContentIndex = 3 + subtitleLines.length;
    const narrow = safeWidth < 4;
    this.setInputRect(
      narrow ? 0 : 3,
      (narrow ? 1 : 3) + inputContentIndex,
      narrow ? safeWidth : Math.min(innerWidth, safeWidth - 3),
    );

    const contentLines: string[] = [
      titleLine,
      '',
      ...subtitleLines,
      '',
      inputLine,
      '',
      footerLine,
    ];

    return renderPaddedDialogBox(contentLines, safeWidth, innerWidth);
  }

  private finish(result: ApiKeyInputResult): void {
    if (this.done) return;
    this.done = true;
    this.onDone(result);
  }

  private submit(value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (!this.done) this.emptyHinted = true;
      return;
    }
    this.finish({ kind: 'ok', value: this.options?.trimValue === false ? value : trimmed });
  }

  private cancel(): void {
    this.finish({ kind: 'cancel' });
  }

  private setInputRect(x: number, y: number, width: number): void {
    this.inputRect =
      width > 0 ? { x, y, width, height: 1, contentOffsetX: 0, contentOffsetY: 0 } : undefined;
  }
}
