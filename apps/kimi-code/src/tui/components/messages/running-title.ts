import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import {
  TRANSCRIPT_GROUP_FADE_HALF_LIFE_MS,
  TRANSCRIPT_GROUP_SWEEP_DURATION_MS,
  TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH_RATIO,
  TRANSCRIPT_GROUP_SWEEP_INTERVAL_MS,
  TRANSCRIPT_GROUP_SWEEP_LIGHT_REST_MIN_CONTRAST,
  TRANSCRIPT_GROUP_SWEEP_LIGHT_REST_TEXT_RATIO,
  TRANSCRIPT_GROUP_SWEEP_MIN_HALF_WIDTH,
  TRANSCRIPT_GROUP_SWEEP_START_DELAY_MS,
  TRANSCRIPT_GROUP_TAIL_ELAPSED_MS,
} from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import { contrastRatio, mixColors } from '#/tui/theme/color-mix';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface SweepBand {
  readonly center: number;
  readonly halfWidth: number;
}

export class TitleSweep {
  private startedAt = 0;
  private lastFrame: number | undefined;
  private columns = 0;
  private level = 0;
  // Only painting knows the columns a title covers: a wrapped detail title paints more characters
  // than the columns passed to advance, and a cut title fewer.
  private paintedColumns = 0;

  get intensity(): number {
    return this.level;
  }

  get frameKey(): string {
    if (this.level === 0) return 'static';
    const level = this.level.toFixed(4);
    const band = this.band();
    return band === undefined ? `gap:${level}` : `${band.center.toFixed(3)}:${level}`;
  }

  start(now: number, on: boolean): void {
    this.startedAt = now;
    this.lastFrame = now;
    if (on) this.level = 1;
  }

  advance(now: number, columns: number, on: boolean): void {
    const elapsed = this.lastFrame === undefined ? 0 : Math.max(0, now - this.lastFrame);
    this.lastFrame = now;
    this.columns = columns;
    const target = on ? 1 : 0;
    this.level = target + (this.level - target) * 0.5 ** (elapsed / TRANSCRIPT_GROUP_FADE_HALF_LIFE_MS);
    if (this.level < 0.01 && target === 0) this.level = 0;
  }

  /** Starts painting a new title; the gap check covers only what the returned function paints. */
  painter(): (text: string, offset: number) => string {
    const band = this.band();
    this.paintedColumns = 0;
    return (text, offset) => this.paint(text, offset, band);
  }

  private paint(text: string, offset: number, band: SweepBand | undefined): string {
    this.paintedColumns = Math.max(this.paintedColumns, offset + visibleWidth(text));
    if (this.level === 0) return currentTheme.fg('textDim', text);
    const dim = currentTheme.color('textDim');
    const peak = currentTheme.color('text');
    const rest = currentTheme.isLight() ? lightRest(currentTheme.terminalBackground(), peak) : dim;
    const base = mixColors(dim, rest, this.level);
    if (band === undefined) return chalk.hex(base)(text);
    let column = offset;
    let painted = '';
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const width = visibleWidth(segment);
      const distance = Math.abs(column + width / 2 - band.center);
      column += width;
      const bandWeight = 0.5 * (1 + Math.cos(Math.PI * Math.min(distance / band.halfWidth, 1)));
      painted += chalk.hex(mixColors(base, peak, bandWeight * this.level))(segment);
    }
    return painted;
  }

  private band(): SweepBand | undefined {
    const columns = this.paintedColumns > 0 ? this.paintedColumns : this.columns;
    const halfWidth = Math.max(columns * TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH_RATIO, TRANSCRIPT_GROUP_SWEEP_MIN_HALF_WIDTH);
    const sinceDelay = Math.max(0, (this.lastFrame ?? this.startedAt) - this.startedAt - TRANSCRIPT_GROUP_SWEEP_START_DELAY_MS);
    const progress = Math.min(sinceDelay % TRANSCRIPT_GROUP_SWEEP_INTERVAL_MS, TRANSCRIPT_GROUP_SWEEP_DURATION_MS) /
      TRANSCRIPT_GROUP_SWEEP_DURATION_MS;
    const center = progress * (columns + 2 * halfWidth) - halfWidth;
    return center + halfWidth <= 0 || center - halfWidth >= columns ? undefined : { center, halfWidth };
  }
}

function lightRest(background: string, text: string): string {
  const required = Math.min(TRANSCRIPT_GROUP_SWEEP_LIGHT_REST_MIN_CONTRAST, contrastRatio(text, background));
  for (let ratio = TRANSCRIPT_GROUP_SWEEP_LIGHT_REST_TEXT_RATIO; ratio < 1; ratio += 0.01) {
    const rest = mixColors(background, text, ratio);
    if (contrastRatio(rest, background) >= required) return rest;
  }
  return text;
}

export function shownSeconds(startedAtMs: number, now: number): number | undefined {
  const elapsed = now - startedAtMs;
  return elapsed >= TRANSCRIPT_GROUP_TAIL_ELAPSED_MS ? Math.floor(elapsed / 1000) : undefined;
}

export function elapsedSuffix(startedAtMs: number, now: number): string {
  const seconds = shownSeconds(startedAtMs, now);
  return seconds === undefined ? '' : currentTheme.dim(` · ${String(seconds)}s`);
}
