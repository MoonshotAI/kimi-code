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

import { SGR_FAINT, SGR_NORMAL_INTENSITY, SGR_SEQUENCE } from '#/tui/constant/terminal';

import type { ColorPalette } from './colors';
import { darkColors } from './colors';
import { deriveHoverBackground } from './hover-color';

export type ColorToken = keyof ColorPalette;

export class Theme {
  private _palette: ColorPalette;
  private _terminalBackground: string | undefined;

  constructor(palette: ColorPalette) {
    this._palette = palette;
  }

  get palette(): ColorPalette {
    return this._palette;
  }

  setPalette(palette: ColorPalette): void {
    this._palette = palette;
  }

  color(token: ColorToken): string {
    return this._palette[token];
  }

  setTerminalBackground(background: string | undefined): void {
    this._terminalBackground = background;
  }

  hoverBackground(): string | undefined {
    return this._terminalBackground === undefined
      ? undefined
      : deriveHoverBackground(this._terminalBackground, this.color('textStrong'));
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

  /**
   * Fade an already styled line, keeping its hues: faint from start to end,
   * re-entered after every reset inside it that would end faint early.
   * Unlike `dim`, a bold segment inside cannot cut the fade short.
   */
  fade(text: string): string {
    if (chalk.level === 0 || text.length === 0) return text;
    const faded = text.replaceAll(SGR_SEQUENCE, (sequence: string, params: string) =>
      endsFaint(params) ? `${sequence}${SGR_FAINT}` : sequence,
    );
    return `${SGR_FAINT}${faded}${SGR_NORMAL_INTENSITY}`;
  }
}

/** Whether an SGR parameter list resets intensity; extended color arguments are skipped, not read as codes. */
function endsFaint(params: string): boolean {
  const codes = params.split(';');
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!;
    if (code === '38' || code === '48' || code === '58') {
      const kind = codes[index + 1];
      index += kind === '5' ? 2 : kind === '2' ? 4 : 0;
      continue;
    }
    if (code === '' || code === '22' || Number(code) === 0) return true;
  }
  return false;
}

/** Global singleton.  Initialise with dark palette; switch via `setPalette`. */
export const currentTheme = new Theme(darkColors);
