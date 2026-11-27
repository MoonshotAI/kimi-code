import {
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import { finishDialogLines } from '#/tui/components/chrome/dock-section';
import { currentTheme } from '#/tui/theme';
import {
  handleSegmentedMouse,
  type MouseColRegion,
} from '#/tui/utils/mouse-hit-test';

import { effortLabel } from './model-selector';

export interface EffortSelectorOptions {
  readonly title?: string;
  readonly efforts: readonly ThinkingEffort[];
  readonly currentValue: ThinkingEffort;
  readonly onSelect: (effort: ThinkingEffort) => void;
  readonly onSessionOnlySelect?: (effort: ThinkingEffort) => void;
  readonly onCancel: () => void;
  readonly warning?: string;
  readonly descriptions?: Readonly<Record<string, string>>;
}

export class EffortSelectorComponent implements Component, Focusable {
  focused = false;
  private readonly opts: EffortSelectorOptions;
  private activeIndex: number;
  private readonly shownAt = Date.now();
  private segmentRow = -1;
  private segmentRegions: readonly MouseColRegion[] = [];

  constructor(opts: EffortSelectorOptions) {
    this.opts = opts;
    const idx = opts.efforts.indexOf(opts.currentValue);
    this.activeIndex = Math.max(idx, 0);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.activeIndex = Math.min(this.opts.efforts.length - 1, this.activeIndex + 1);
      return;
    }
    if (matchesKey(data, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      this.opts.onSessionOnlySelect(this.opts.efforts[this.activeIndex]!);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.opts.onSelect(this.opts.efforts[this.activeIndex]!);
      return;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return handleSegmentedMouse({
      event,
      focused: this.focused,
      shownAt: this.shownAt,
      row: this.segmentRow,
      regions: this.segmentRegions,
      select: (index) => {
        const changed = this.activeIndex !== index;
        this.activeIndex = index;
        return changed;
      },
      activate: (index, clickEvent) => {
        const effort = this.opts.efforts[index];
        if (effort === undefined) return;
        if (clickEvent.alt && this.opts.onSessionOnlySelect !== undefined) {
          this.opts.onSessionOnlySelect(effort);
          return;
        }
        this.opts.onSelect(effort);
      },
    });
  }

  render(width: number): string[] {
    const hintParts = ['←→ switch', 'Enter select'];
    if (this.opts.onSessionOnlySelect !== undefined) hintParts.push('Alt+S session-only');
    hintParts.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.title ?? 'Select thinking effort'}`),
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
    ];
    if (this.opts.warning !== undefined) {
      for (const line of wrapTextWithAnsi(this.opts.warning, Math.max(1, width - 1))) {
        lines.push(currentTheme.fg('warning', ` ${line}`));
      }
    }
    lines.push('');

    const regions: MouseColRegion[] = [];
    let col = 2;
    const segments = this.opts.efforts.map((effort, index) => {
      const label = effortLabel(effort);
      const rawText = index === this.activeIndex ? `[ ${label} ]` : `  ${label}  `;
      const segWidth = visibleWidth(rawText);
      regions.push({ start: col, end: col + segWidth, index });
      col += segWidth + 2;
      return index === this.activeIndex
        ? currentTheme.boldFg('primary', rawText)
        : currentTheme.fg('text', rawText);
    });
    this.segmentRow = lines.length;
    this.segmentRegions = regions;
    lines.push(`  ${segments.join('  ')}`);
    const description = this.opts.descriptions?.[this.opts.efforts[this.activeIndex]!];
    if (description !== undefined) lines.push(currentTheme.fg('textMuted', ` ${description}`));

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return finishDialogLines(lines, width, this.focused);
  }
}
