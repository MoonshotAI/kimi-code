import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import {
  TRANSCRIPT_GROUP_FADE_MS,
  TRANSCRIPT_GROUP_FRAME_INTERVAL_MS,
  TRANSCRIPT_GROUP_HOLD_MS,
  TRANSCRIPT_GROUP_SWEEP_COLUMNS_PER_SECOND,
  TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH,
  TRANSCRIPT_GROUP_SWEEP_RESTART_GAP_COLUMNS,
  TRANSCRIPT_GROUP_TAIL_ELAPSED_MS,
} from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import { colorDistance, mixColors } from '#/tui/theme/color-mix';
import type { LogicalTranscriptItem } from '#/tui/utils/transcript-items';
import type { GroupSummary } from '#/tui/utils/transcript-projection';
import { TruncatedHeaderLine } from './truncated-header-line';

export interface TranscriptGroupTail {
  readonly text: string;
  readonly startedAtMs: number;
  readonly running: boolean;
}

export interface TranscriptGroupModel {
  readonly anchor: Component;
  readonly sourceIndex: number;
  readonly members: readonly [LogicalTranscriptItem, ...LogicalTranscriptItem[]];
  readonly active: boolean;
  readonly expanded: boolean;
  readonly summary: GroupSummary;
  readonly tail?: readonly TranscriptGroupTail[];
}

export interface TranscriptGroupInteraction {
  toggleGroup(anchor: Component, fromBottom?: { readonly removedLines: number }): void;
  toggleMember(item: LogicalTranscriptItem): TuiMouseEventResult | undefined;
  requestRender(): void;
}

interface MemberRows {
  readonly item: LogicalTranscriptItem;
  readonly start: number;
  readonly end: number;
}

interface MemberCache {
  readonly rendered: string[];
  readonly prefixed: string[];
}

interface TranscriptGroupRenderCache {
  readonly width: number;
  readonly animationKey: string;
  readonly tailKey: string;
  readonly palette: ColorPalette;
  readonly background: string;
  readonly summary: GroupSummary;
  readonly expanded: boolean;
  readonly lines: string[];
  readonly rows: readonly MemberRows[];
  readonly members: readonly MemberCache[];
}

export class TranscriptGroupComponent implements Component {
  private model: TranscriptGroupModel;
  private readonly header = new TruncatedHeaderLine('');
  private renderCache: TranscriptGroupRenderCache | undefined;
  private showLessRow = -1;
  private interval: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private sweepPosition = -TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH;
  private lastFrame: number | undefined;
  private intensity = 0;
  private lastActiveAt: number | undefined;

  constructor(
    model: TranscriptGroupModel,
    private readonly interaction: TranscriptGroupInteraction,
  ) {
    this.model = model;
    this.syncTimer();
  }

  setModel(model: TranscriptGroupModel): void {
    this.model = model;
    this.syncTimer();
  }

  invalidate(): void {
    this.header.invalidate();
    this.renderCache = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const cache = this.renderCache;
    const palette = currentTheme.palette;
    const background = currentTheme.terminalBackground();
    const noTail = this.model.tail === undefined || this.model.tail.length === 0;
    if (
      !this.model.expanded &&
      !this.shouldAnimate() &&
      noTail &&
      cache !== undefined &&
      cache.width === width &&
      cache.animationKey === 'static' &&
      cache.tailKey === '' &&
      cache.palette === palette &&
      cache.background === background &&
      cache.summary === this.model.summary &&
      !cache.expanded
    ) {
      return cache.lines;
    }
    const marker = this.model.expanded ? '⌄' : '›';
    const animationKey = this.updateHeader(marker);
    const tail = this.renderTail(width);
    const sameHeader =
      cache !== undefined &&
      cache.width === width &&
      cache.animationKey === animationKey &&
      cache.tailKey === tail.key &&
      cache.palette === palette &&
      cache.background === background &&
      cache.summary === this.model.summary &&
      cache.expanded === this.model.expanded;
    if (!this.model.expanded && sameHeader) return cache.lines;

    const lines = ['', ...this.header.render(width), ...tail.lines];
    if (!this.model.expanded) {
      this.showLessRow = -1;
      this.renderCache = {
        width,
        animationKey,
        tailKey: tail.key,
        palette,
        background,
        summary: this.model.summary,
        expanded: false,
        lines,
        rows: [],
        members: [],
      };
      return lines;
    }

    const memberCaches: MemberCache[] = [];
    const memberLines: string[] = [];
    const rows: MemberRows[] = [];
    const guideColor = this.guideColor();
    const guide = chalk.hex(guideColor)('│ ');
    const sameColors = cache?.palette === palette && cache.background === background;
    let allReused = sameHeader && cache.members.length === this.model.members.length;
    for (const [index, item] of this.model.members.entries()) {
      const rendered = item.display.render(Math.max(1, width - 2));
      const previous = cache?.members[index];
      const reused = previous?.rendered === rendered && sameColors;
      const prefixed = reused && previous !== undefined
        ? previous.prefixed
        : rendered.map((line) => guide + line);
      if (!reused) allReused = false;
      memberCaches.push({ rendered, prefixed });
      const start = lines.length + memberLines.length;
      memberLines.push(...prefixed);
      rows.push({ item, start, end: lines.length + memberLines.length });
    }
    this.showLessRow = lines.length + memberLines.length;
    if (allReused && cache !== undefined) return cache.lines;
    const closing = `${chalk.hex(guideColor)('└ ')}${chalk.hex(currentTheme.faintForeground())('Show less')}`;
    this.renderCache = {
      width,
      animationKey,
      tailKey: tail.key,
      palette,
      background,
      summary: this.model.summary,
      expanded: true,
      lines: [...lines, ...memberLines, closing],
      rows,
      members: memberCaches,
    };
    return this.renderCache.lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'click' && event.button === 'left' && event.y === 1) {
      this.interaction.toggleGroup(this.model.anchor);
      return { handled: true };
    }
    if (!this.model.expanded) return undefined;
    if (event.type === 'click' && event.button === 'left' && event.y === this.showLessRow) {
      const collapsedHeight = 2 + (this.model.tail?.length ?? 0);
      this.interaction.toggleGroup(this.model.anchor, {
        removedLines: Math.max(0, this.showLessRow + 1 - collapsedHeight),
      });
      return { handled: true };
    }
    const rows = this.renderCache?.rows ?? [];
    const hit = rows.find((row) => event.y >= row.start && event.y < row.end);
    if (hit === undefined) return undefined;
    const handled = hit.item.display.handleMouse?.({
      ...event,
      x: event.x - 2,
      y: event.y - hit.start,
      width: Math.max(1, event.width - 2),
      height: hit.end - hit.start,
    });
    if (
      handled !== undefined &&
      ('target' in handled || handled.handled === true || handled.capture === true || handled.focus === true)
    ) {
      return handled;
    }
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    return this.interaction.toggleMember(hit.item);
  }

  private guideColor(): string {
    return mixColors(
      currentTheme.color('textDim'),
      currentTheme.terminalBackground(),
      currentTheme.isLight() ? 0.65 : 0.60,
    );
  }

  private renderTail(width: number): { readonly key: string; readonly lines: string[] } {
    if (this.model.expanded || this.model.tail === undefined || this.model.tail.length === 0) {
      return { key: '', lines: [] };
    }
    const now = Date.now();
    const entries = this.model.tail.map((entry) => {
      const elapsedMs = now - entry.startedAtMs;
      const seconds = entry.running && elapsedMs >= TRANSCRIPT_GROUP_TAIL_ELAPSED_MS
        ? Math.floor(elapsedMs / 1000)
        : undefined;
      return { entry, seconds };
    });
    const color = currentTheme.faintForeground();
    const lines = entries.map(({ entry, seconds }, index) => {
      const branch = index < entries.length - 1 ? '├ ' : '└ ';
      const elapsed = seconds === undefined ? '' : ` · ${String(seconds)}s`;
      return truncateToWidth(chalk.hex(color)(`  ${branch}${entry.text}${elapsed}`), width, '…');
    });
    return {
      key: entries.map(({ entry, seconds }) => `${entry.text}:${String(entry.running)}:${String(seconds)}`).join('|'),
      lines,
    };
  }

  private updateHeader(marker: string): string {
    const { summary } = this.model;
    const fragments = summary.fragments.join(', ');
    const total = visibleWidth(`${marker} ${fragments}`);
    const now = Date.now();
    const intensity = this.advance(now, total);
    const animationKey = intensity === 0
      ? 'static'
      : `${this.sweepPosition.toFixed(3)}:${intensity.toFixed(4)}`;
    const dim = currentTheme.color('textDim');
    const strong = currentTheme.color('textStrong');
    const background = currentTheme.terminalBackground();
    const bandTarget = colorDistance(dim, background) > colorDistance(dim, strong) ? background : strong;
    const band = mixColors(dim, bandTarget, 0.45);
    let markerStyle = (text: string): string => currentTheme.fg('textDim', text);
    let textStyle = (text: string): string => currentTheme.fg('textDim', text);
    if (intensity > 0) {
      const offset = visibleWidth(marker) + 1;
      markerStyle = (text) => sweep(text, 0, this.sweepPosition, dim, band, intensity);
      textStyle = (text) => sweep(text, offset, this.sweepPosition, dim, band, intensity);
    }
    if (summary.allFailed) markerStyle = (text) => currentTheme.fg('error', text);
    const failed = summary.failed > 0
      ? currentTheme.fg('error', ` · ${String(summary.failed)} failed`)
      : '';
    const interrupted = summary.interrupted > 0
      ? currentTheme.fg('textDim', ` · ${String(summary.interrupted)} interrupted`)
      : '';
    this.header.setText({
      head: `${markerStyle(marker)} `,
      flex: { text: fragments, style: textStyle, keep: 'head' },
      tail: `${this.diff(summary)}${failed}${interrupted}`,
    });
    return animationKey;
  }

  private diff(summary: GroupSummary): string {
    const parts: string[] = [];
    if (summary.added > 0) parts.push(currentTheme.fg('diffAdded', `+${String(summary.added)}`));
    if (summary.removed > 0) parts.push(currentTheme.fg('diffRemoved', `-${String(summary.removed)}`));
    return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
  }

  private advance(now: number, total: number): number {
    const elapsed = this.lastFrame === undefined ? 0 : Math.min(100, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    if (this.model.active) this.lastActiveAt = now;
    const holding = this.lastActiveAt !== undefined && now - this.lastActiveAt < TRANSCRIPT_GROUP_HOLD_MS;
    const target = this.model.active || holding ? 1 : 0;
    this.intensity += (target - this.intensity) * Math.min(1, elapsed / TRANSCRIPT_GROUP_FADE_MS);
    if (this.intensity < 0.01 && target === 0) this.intensity = 0;
    this.sweepPosition += elapsed * TRANSCRIPT_GROUP_SWEEP_COLUMNS_PER_SECOND / 1000;
    if (this.sweepPosition > total + TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH + TRANSCRIPT_GROUP_SWEEP_RESTART_GAP_COLUMNS) {
      this.sweepPosition = -TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH;
    }
    return this.intensity;
  }

  private shouldAnimate(): boolean {
    const runningTail = !this.model.expanded && this.model.tail?.some((entry) => entry.running) === true;
    const holding = this.lastActiveAt !== undefined && Date.now() - this.lastActiveAt < TRANSCRIPT_GROUP_HOLD_MS;
    return this.model.active || this.intensity > 0 || holding || runningTail;
  }

  private syncTimer(): void {
    if (this.shouldAnimate() && !this.disposed) {
      if (this.interval !== undefined) return;
      this.interval = setInterval(() => {
        if (!this.shouldAnimate()) {
          this.stopTimer();
          return;
        }
        this.interaction.requestRender();
      }, TRANSCRIPT_GROUP_FRAME_INTERVAL_MS);
      return;
    }
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.interval === undefined) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}

function sweep(
  text: string,
  offset: number,
  position: number,
  base: string,
  band: string,
  intensity: number,
): string {
  return Array.from(text).map((character, index) => {
    const distance = Math.abs(index + offset - position);
    const amount = Math.max(0, 1 - distance / TRANSCRIPT_GROUP_SWEEP_HALF_WIDTH);
    const eased = amount * amount * (3 - 2 * amount);
    return chalk.hex(mixColors(base, band, eased * intensity))(character);
  }).join('');
}
