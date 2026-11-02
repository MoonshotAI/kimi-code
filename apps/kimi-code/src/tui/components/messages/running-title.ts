import chalk from 'chalk';

import {
  TRANSCRIPT_GROUP_FADE_MS,
  TRANSCRIPT_GROUP_SWEEP_COLUMNS_PER_SECOND,
  TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH,
  TRANSCRIPT_GROUP_SWEEP_RESTART_GAP_COLUMNS,
  TRANSCRIPT_GROUP_TAIL_ELAPSED_MS,
} from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { colorDistance, mixColors } from '#/tui/theme/color-mix';

const MAX_FRAME_STEP_MS = 100;

export class TitleSweep {
  private position = -TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH;
  private lastFrame: number | undefined;
  private level = 0;

  get intensity(): number {
    return this.level;
  }

  get frameKey(): string {
    return this.level === 0 ? 'static' : `${this.position.toFixed(3)}:${this.level.toFixed(4)}`;
  }

  advance(now: number, columns: number, on: boolean): void {
    const elapsed = this.lastFrame === undefined ? 0 : Math.min(MAX_FRAME_STEP_MS, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    const target = on ? 1 : 0;
    this.level += (target - this.level) * Math.min(1, elapsed / TRANSCRIPT_GROUP_FADE_MS);
    if (this.level < 0.01 && target === 0) this.level = 0;
    this.position += elapsed * TRANSCRIPT_GROUP_SWEEP_COLUMNS_PER_SECOND / 1000;
    if (this.position > columns + TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH + TRANSCRIPT_GROUP_SWEEP_RESTART_GAP_COLUMNS) {
      this.position = -TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH;
    }
  }

  paint(text: string, offset: number): string {
    if (this.level === 0) return currentTheme.fg('textDim', text);
    const dim = currentTheme.color('textDim');
    const strong = currentTheme.color('textStrong');
    const background = currentTheme.terminalBackground();
    const bandTarget = colorDistance(dim, background) > colorDistance(dim, strong) ? background : strong;
    const band = mixColors(dim, bandTarget, 0.45);
    return Array.from(text).map((character, index) => {
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
  return seconds === undefined ? '' : chalk.hex(currentTheme.faintForeground())(` · ${String(seconds)}s`);
}
