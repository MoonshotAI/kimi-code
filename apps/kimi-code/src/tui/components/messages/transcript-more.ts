import {
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

export class TranscriptMoreComponent implements Component {
  private cache: {
    readonly width: number;
    readonly count: number;
    readonly expanded: boolean;
    readonly palette: ColorPalette;
    readonly background: string;
    readonly lines: string[];
  } | undefined;
  private expanded = false;

  constructor(
    private count: number,
    private readonly toggle: () => void,
  ) {}

  setCount(count: number): void {
    if (this.count === count) return;
    this.count = count;
    this.cache = undefined;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const palette = currentTheme.palette;
    const background = currentTheme.terminalBackground();
    const cache = this.cache;
    if (
      cache?.width === width &&
      cache.count === this.count &&
      cache.expanded === this.expanded &&
      cache.palette === palette &&
      cache.background === background
    ) {
      return cache.lines;
    }
    const text = this.expanded
      ? chalk.hex(currentTheme.faintForeground())('Show less')
      : currentTheme.fg('textMuted', `… ${String(this.count)} more`);
    const lines = ['', truncateToWidth(text, width, '…')];
    this.cache = { width, count: this.count, expanded: this.expanded, palette, background, lines };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left' || event.y !== 1) return undefined;
    this.toggle();
    return { handled: true };
  }
}
