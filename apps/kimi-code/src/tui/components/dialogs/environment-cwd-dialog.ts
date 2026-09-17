/**
 * EnvironmentCwdDialogComponent — single-field rounded box collecting the remote
 * working directory for a environment switch (experimental remote environment).
 *
 * The input is prefilled with the declaration's `defaultCwd`; the value is
 * validated server-side against the target fs on submit (no local checks, no
 * path completion). Server validation and handshake failures surface inline
 * via `showError` — the dialog stays open so the path can be corrected.
 * Geometry mirrors the custom-registry import dialog.
 */

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

export interface EnvironmentCwdDialogOptions {
  /** Dialog title, e.g. `Switch to ssh:dev-box`. */
  readonly title: string;
  /** Prefill for the cwd field (the declaration's `defaultCwd`, when set). */
  readonly defaultValue: string;
  readonly onSubmit: (cwd: string) => void;
  readonly onCancel: () => void;
}

const SUBTITLE_DEFAULT = 'Validated on the target host when connecting.';
const SUBTITLE_EMPTY = 'Working directory cannot be empty.';
const FOOTER = 'Enter submit · Esc cancel';
const MAX_ERROR_LINES = 4;

type DialogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export class EnvironmentCwdDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private state: DialogState = { kind: 'idle' };
  private hint: 'none' | 'empty' = 'none';

  constructor(private readonly opts: EnvironmentCwdDialogOptions) {
    super();
    if (opts.defaultValue.length > 0) this.input.setValue(opts.defaultValue);
    this.input.onSubmit = () => {
      this.handleSubmit();
    };
    this.input.onEscape = () => {
      this.opts.onCancel();
    };
  }

  /** Lock the dialog while the switch (connect + cwd validation) is in flight. */
  setBusy(message: string): void {
    this.state = { kind: 'busy', message };
    this.invalidate();
  }

  /** Show a server-side failure inline (validation, handshake exit code + stderr). */
  showError(message: string): void {
    this.state = { kind: 'error', message };
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.state.kind === 'busy') return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.opts.onCancel();
      return;
    }
    if (this.state.kind === 'error') this.state = { kind: 'idle' };
    if (this.hint !== 'none') this.hint = 'none';
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && this.state.kind !== 'busy';
    this.input.focused = dialogActive;

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const titleStyled = currentTheme.boldFg('textStrong', this.opts.title);
    const subtitleText = this.hint === 'empty' ? SUBTITLE_EMPTY : SUBTITLE_DEFAULT;
    const subtitleStyled = currentTheme.fg('textDim', subtitleText);
    const footerStyled = currentTheme.fg('textDim', FOOTER);

    const titleLine = truncateToWidth(titleStyled, innerWidth, '…');
    const subtitleLine = truncateToWidth(subtitleStyled, innerWidth, '…');
    const footerLine = truncateToWidth(footerStyled, innerWidth, '…');
    const inputLine = this.input.render(innerWidth)[0] ?? '> ';

    const contentLines: string[] = [titleLine, '', subtitleLine, '', inputLine, '', footerLine];

    if (this.state.kind === 'busy') {
      contentLines.push('', truncateToWidth(currentTheme.fg('textMuted', this.state.message), innerWidth, '…'));
    } else if (this.state.kind === 'error') {
      contentLines.push('');
      for (const line of this.state.message.split('\n').slice(0, MAX_ERROR_LINES)) {
        contentLines.push(truncateToWidth(currentTheme.fg('error', line), innerWidth, '…'));
      }
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
      const vis = visibleWidth(content);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private handleSubmit(): void {
    if (this.state.kind === 'busy') return;
    const cwd = this.input.getValue().trim();
    if (cwd.length === 0) {
      this.hint = 'empty';
      return;
    }
    this.opts.onSubmit(cwd);
  }
}
