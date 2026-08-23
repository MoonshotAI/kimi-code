/**
 * ConfirmDialogComponent — a small Yes/No confirmation mounted as an editor
 * replacement. Used by commands that change more than the current session (e.g.
 * `/update-all-session-models`) so the user sees the blast radius and explicitly
 * confirms before anything is written.
 *
 * Pure presentation: it never touches session or config state; it only reports a
 * boolean back through `onResolve`.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

export interface ConfirmDialogOptions {
  readonly title: string;
  /** Supporting lines shown above the Yes/No choice. */
  readonly body: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Always invoked exactly once: `true` on confirm, `false` on cancel. */
  readonly onResolve: (confirmed: boolean) => void;
}

interface ConfirmChoice {
  readonly label: string;
  readonly value: boolean;
}

export class ConfirmDialogComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: ConfirmDialogOptions;
  private readonly choices: readonly ConfirmChoice[];
  private selectedIndex = 0;
  private resolved = false;

  constructor(opts: ConfirmDialogOptions) {
    super();
    this.opts = opts;
    this.choices = [
      { label: opts.confirmLabel ?? 'Yes', value: true },
      { label: opts.cancelLabel ?? 'No', value: false },
    ];
  }

  handleInput(data: string): void {
    if (this.resolved) return;
    if (matchesKey(data, Key.escape)) {
      this.resolved = true;
      this.opts.onResolve(false);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = (this.selectedIndex - 1 + this.choices.length) % this.choices.length;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = (this.selectedIndex + 1) % this.choices.length;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.resolved = true;
      this.opts.onResolve(this.choices[this.selectedIndex]!.value);
      return;
    }
    const printable = printableChar(data);
    if (printable === 'y' || printable === 'Y') {
      this.resolved = true;
      this.opts.onResolve(true);
      return;
    }
    if (printable === 'n' || printable === 'N') {
      this.resolved = true;
      this.opts.onResolve(false);
    }
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const bar = '─'.repeat(width);

    const lines: string[] = [accent(bar), currentTheme.boldFg('primary', ` ${this.opts.title}`), ''];

    for (const bodyLine of this.opts.body) {
      lines.push(dim(`  ${bodyLine}`));
    }
    lines.push('');

    const maxLabelWidth = Math.max(...this.choices.map((c) => visibleWidth(c.label)));
    this.choices.forEach((choice, index) => {
      const isSelected = index === this.selectedIndex;
      const pointer = isSelected ? SELECT_POINTER : ' ';
      const gap = maxLabelWidth - visibleWidth(choice.label) + 3;
      const label = isSelected
        ? currentTheme.boldFg('primary', choice.label)
        : currentTheme.fg('text', choice.label);
      lines.push(`  ${isSelected ? accent(pointer) : ' '} ${label}${' '.repeat(gap)}(${index === 0 ? 'Y' : 'N'})`);
    });

    lines.push('');
    lines.push(dim(' ↑↓ choose · Enter select · Y confirm · N / Esc cancel'));
    lines.push(accent(bar));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
