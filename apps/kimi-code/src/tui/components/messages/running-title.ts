import chalk from 'chalk';

import {
  TRANSCRIPT_GROUP_FADE_HALF_LIFE_MS,
  TRANSCRIPT_GROUP_SWEEP_COLUMNS_PER_SECOND,
  TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH,
  TRANSCRIPT_GROUP_SWEEP_RESTART_GAP_COLUMNS,
  TRANSCRIPT_GROUP_TAIL_ELAPSED_MS,
} from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { colorDistance, mixColors } from '#/tui/theme/color-mix';

const MAX_FRAME_STEP_MS = 240;

export class TitleSweep {
  private position = -TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH;
  private lastFrame: number | undefined;
  private level = 0;
  // Only painting knows the columns a title covers: a wrapped detail title paints more characters
  // than the columns passed to advance, and a cut title fewer.
  private paintedColumns = 0;

  get intensity(): number {
    return this.level;
  }

  get frameKey(): string {
    if (this.level === 0) return 'static';
    if (
      this.position <= -TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH ||
      this.position >= this.paintedColumns - 1 + TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH
    ) {
      return 'gap';
    }
    return `${this.position.toFixed(3)}:${this.level.toFixed(4)}`;
  }

  start(now: number): void {
    this.lastFrame = now;
  }

  advance(now: number, columns: number, on: boolean): void {
    const elapsed = this.lastFrame === undefined ? 0 : Math.min(MAX_FRAME_STEP_MS, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    const target = on ? 1 : 0;
    this.level = target + (this.level - target) * 0.5 ** (elapsed / TRANSCRIPT_GROUP_FADE_HALF_LIFE_MS);
    if (this.level < 0.01 && target === 0) this.level = 0;
    this.position += elapsed * TRANSCRIPT_GROUP_SWEEP_COLUMNS_PER_SECOND / 1000;
    if (this.position > columns + TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH + TRANSCRIPT_GROUP_SWEEP_RESTART_GAP_COLUMNS) {
      this.position = -TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH;
    }
  }

  /** Starts painting a new title; the gap check covers only what the returned function paints. */
  painter(): (text: string, offset: number) => string {
    this.paintedColumns = 0;
    return (text, offset) => this.paint(text, offset);
  }

  private paint(text: string, offset: number): string {
    const characters = Array.from(text);
    this.paintedColumns = Math.max(this.paintedColumns, offset + characters.length);
    if (this.level === 0) return currentTheme.fg('textDim', text);
    const dim = currentTheme.color('textDim');
    const strong = currentTheme.color('textStrong');
    const background = currentTheme.terminalBackground();
    const bandTarget = colorDistance(dim, background) > colorDistance(dim, strong) ? background : strong;
    const band = mixColors(dim, bandTarget, 0.45);
    return characters.map((character, index) => {
      const distance = Math.abs(index + offset - this.position);
      const amount = Math.max(0, 1 - distance / TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH);
      const eased = amount * amount * (3 - 2 * amount);
      return chalk.hex(mixColors(dim, band, eased * this.level))(character);
    }).join('');
  }
}

export function shownSeconds(startedAtMs: number, now: number): number | undefined {
  const elapsed = now - startedAtMs;
  return elapsed >= TRANSCRIPT_GROUP_TAIL_ELAPSED_MS ? Math.floor(elapsed / 1000) : undefined;
}

export function elapsedSuffix(startedAtMs: number, now: number): string {
  const seconds = shownSeconds(startedAtMs, now);
  return seconds === undefined ? '' : currentTheme.dim(` · ${String(seconds)}s`);
}
