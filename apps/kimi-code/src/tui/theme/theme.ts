/**
 * Theme class + global singleton.
 *
 * Components import `currentTheme` and call methods like
 * `currentTheme.fg('primary', text)` at render time.  When the user switches
 * themes we call `currentTheme.setPalette(newPalette)` — the same singleton
 * instance stays alive, so every component (including already-rendered
 * transcript entries) sees the new colours on the next render frame.
 */

import chalk from 'chalk';
import type { MarkdownTheme, EditorTheme } from '@earendil-works/pi-tui';

import type { ColorPalette } from './colors';
import { darkColors } from './colors';
import { createMarkdownTheme, createEditorTheme } from './pi-tui-theme';

export type ColorToken = keyof ColorPalette;

export class Theme {
  private _palette: ColorPalette;
  private _markdownTheme: MarkdownTheme | undefined;
  private _editorTheme: EditorTheme | undefined;

  constructor(palette: ColorPalette) {
    this._palette = palette;
  }

  get palette(): ColorPalette {
    return this._palette;
  }

  setPalette(palette: ColorPalette): void {
    this._palette = palette;
    this._markdownTheme = undefined;
    this._editorTheme = undefined;
  }

  color(token: ColorToken): string {
    return this._palette[token];
  }

  /* ── Foreground helpers ── */

  fg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token])(text);
  }

  boldFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).bold(text);
  }

  dimFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).dim(text);
  }

  italicFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).italic(text);
  }

  underlineFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).underline(text);
  }

  strikethroughFg(token: ColorToken, text: string): string {
    return chalk.hex(this._palette[token]).strikethrough(text);
  }

  /* ── Background helpers ── */

  bg(token: ColorToken, text: string): string {
    return chalk.bgHex(this._palette[token])(text);
  }

  /* ── Standalone style helpers ── */

  bold(text: string): string {
    return chalk.bold(text);
  }

  dim(text: string): string {
    return chalk.dim(text);
  }

  italic(text: string): string {
    return chalk.italic(text);
  }

  underline(text: string): string {
    return chalk.underline(text);
  }

  strikethrough(text: string): string {
    return chalk.strikethrough(text);
  }

  /* ── pi-tui adapters (lazily built, invalidated on palette change) ── */

  get markdownTheme(): MarkdownTheme {
    if (this._markdownTheme === undefined) {
      this._markdownTheme = createMarkdownTheme();
    }
    return this._markdownTheme;
  }

  get editorTheme(): EditorTheme {
    if (this._editorTheme === undefined) {
      this._editorTheme = createEditorTheme();
    }
    return this._editorTheme;
  }
}

/** Global singleton.  Initialise with dark palette; switch via `setPalette`. */
export const currentTheme = new Theme(darkColors);
