import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedClick,
  forwardEmbeddedMouse,
  isPointInRect,
  type EmbeddedRect,
} from '#/tui/utils/mouse-regions';

import { renderPaddedDialogBox } from './api-key-input-dialog';

export interface CustomRegistryImportValue {
  readonly url: string;
  readonly apiKey?: string;
}

export type CustomRegistryImportResult =
  | { readonly kind: 'ok'; readonly value: CustomRegistryImportValue }
  | { readonly kind: 'cancel' };

const TITLE = 'Import custom provider registry';
const SUBTITLE_DEFAULT = 'Paste an api.json URL; the Bearer token is optional.';
const SUBTITLE_URL_EMPTY = 'Registry URL cannot be empty.';
const FOOTER_NOT_LAST = 'Tab / ↑↓ to switch  ·  Enter for next field  ·  Esc to cancel';
const FOOTER_LAST = 'Tab / ↑↓ to switch  ·  Enter to submit  ·  Esc to cancel';

type FieldId = 'url' | 'token';

function maskInputLine(raw: string): string {
  const prefix = '> ';
  if (!raw.startsWith(prefix)) return raw;

  let end = raw.length;
  while (end > prefix.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(prefix.length, end);

  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replaceAll(/[^ ]/g, '•');
    })
    .join('');

  return prefix + maskedContent + padding;
}

export class CustomRegistryImportDialogComponent implements Component, Focusable {
  private _focused = false;
  private readonly urlInput = new Input();
  private readonly tokenInput = new Input();
  private readonly onDone: (result: CustomRegistryImportResult) => void;
  private activeField: FieldId = 'url';
  private done = false;
  private hint: 'none' | 'url-empty' = 'none';
  private urlRect: EmbeddedRect | undefined;
  private tokenRect: EmbeddedRect | undefined;
  private urlLabelRow: number | undefined;
  private tokenLabelRow: number | undefined;

  constructor(
    onDone: (result: CustomRegistryImportResult) => void,
    defaultUrl: string = '',
  ) {
    this.onDone = onDone;
    if (defaultUrl.length > 0) this.urlInput.setValue(defaultUrl);
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

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done) return undefined;
    if (!this._focused) return focusOnUnfocusedClick(false, event);
    if (event.type === 'wheel') return { handled: true };
    if (event.type !== 'press' || event.button !== 'left') return undefined;

    const hit = this.hitField(event);
    if (hit === undefined) return undefined;
    this.focusField(hit.field);
    if (hit.rect === undefined) return { handled: true, render: true };
    const input = hit.field === 'url' ? this.urlInput : this.tokenInput;
    const forwarded = forwardEmbeddedMouse(input, hit.rect, event);
    return forwarded === undefined ? { handled: true, render: true } : { ...forwarded, render: true };
  }

  invalidate(): void {
    this.urlInput.invalidate();
    this.tokenInput.invalidate();
  }

  render(width: number): string[] {
    this.syncInputFocus();

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) {
      this.urlRect = undefined;
      this.tokenRect = undefined;
      this.urlLabelRow = undefined;
      this.tokenLabelRow = undefined;
      return [''];
    }
    const innerWidth = Math.max(1, safeWidth - 4);
    const titleStyled = currentTheme.boldFg('textStrong', TITLE);
    const subtitleText = this.hint === 'url-empty' ? SUBTITLE_URL_EMPTY : SUBTITLE_DEFAULT;
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const footerStyled = currentTheme.fg(
      'textDim',
      this.activeField === 'url' ? FOOTER_NOT_LAST : FOOTER_LAST,
    );

    const urlLabelText = 'Registry URL';
    const tokenLabelText = 'Bearer token (optional)';
    const urlLabelStyled =
      this.activeField === 'url'
        ? currentTheme.boldFg('accent', urlLabelText)
        : currentTheme.fg('textDim', urlLabelText);
    const tokenLabelStyled =
      this.activeField === 'token'
        ? currentTheme.boldFg('accent', tokenLabelText)
        : currentTheme.fg('textDim', tokenLabelText);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const urlLabelLine = truncateToWidth(urlLabelStyled, innerWidth, '…');
    const tokenLabelLine = truncateToWidth(tokenLabelStyled, innerWidth, '…');
    const urlInputLine = this.urlInput.render(innerWidth)[0] ?? '> ';
    const rawTokenInputLine = this.tokenInput.render(innerWidth)[0] ?? '> ';
    const tokenInputLine = maskInputLine(rawTokenInputLine);

    this.recordFieldGeometry(safeWidth, innerWidth);

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

    return renderPaddedDialogBox(contentLines, safeWidth, innerWidth);
  }

  private recordFieldGeometry(safeWidth: number, innerWidth: number): void {
    const narrow = safeWidth < 4;
    const inputX = narrow ? 0 : 3;
    const rowOffset = narrow ? 1 : 3;
    const inputWidth = narrow ? safeWidth : Math.min(innerWidth, safeWidth - 3);
    this.urlLabelRow = rowOffset + 4;
    this.tokenLabelRow = rowOffset + 7;
    this.urlRect =
      inputWidth > 0
        ? {
            x: inputX,
            y: rowOffset + 5,
            width: inputWidth,
            height: 1,
            contentOffsetX: 0,
            contentOffsetY: 0,
          }
        : undefined;
    this.tokenRect =
      inputWidth > 0
        ? {
            x: inputX,
            y: rowOffset + 8,
            width: inputWidth,
            height: 1,
            contentOffsetX: 0,
            contentOffsetY: 0,
          }
        : undefined;
  }

  private hitField(
    event: TuiMouseEvent,
  ): { readonly field: FieldId; readonly rect?: EmbeddedRect } | undefined {
    if (this.urlRect !== undefined && isPointInRect(this.urlRect, event.x, event.y)) {
      return { field: 'url', rect: this.urlRect };
    }
    if (this.tokenRect !== undefined && isPointInRect(this.tokenRect, event.x, event.y)) {
      return { field: 'token', rect: this.tokenRect };
    }
    if (event.y === this.urlLabelRow) return { field: 'url' };
    if (event.y === this.tokenLabelRow) return { field: 'token' };
    return undefined;
  }

  private syncInputFocus(): void {
    const dialogActive = this._focused && !this.done;
    this.urlInput.focused = dialogActive && this.activeField === 'url';
    this.tokenInput.focused = dialogActive && this.activeField === 'token';
  }

  private toggleField(): void {
    this.focusField(this.activeField === 'url' ? 'token' : 'url');
  }

  private focusField(field: FieldId): void {
    this.hint = 'none';
    this.activeField = field;
    this.syncInputFocus();
  }

  private handleSubmit(): void {
    if (this.done) return;

    const urlValue = this.urlInput.getValue().trim();
    const tokenValue = this.tokenInput.getValue().trim();

    if (urlValue.length === 0) {
      this.hint = 'url-empty';
      this.activeField = 'url';
      this.syncInputFocus();
      return;
    }

    this.done = true;
    this.syncInputFocus();
    this.onDone({
      kind: 'ok',
      value: { url: urlValue, apiKey: tokenValue.length > 0 ? tokenValue : undefined },
    });
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.syncInputFocus();
    this.onDone({ kind: 'cancel' });
  }
}
