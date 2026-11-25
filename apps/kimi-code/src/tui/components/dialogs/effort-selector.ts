import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';
import {
  focusOnUnfocusedClick,
  renderInlineSegments,
  SpanHitMap,
  type InlineSegment,
} from '#/tui/utils/mouse-regions';

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
  private readonly hits = new SpanHitMap<number>();
  private activeIndex: number;

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
    if (!this.focused) return focusOnUnfocusedClick(false, event);
    if (event.type === 'wheel') return { handled: true };
    return this.hits.handle(event, {
      focused: this.focused,
      onHover: (index) => {
        const changed = this.activeIndex !== index;
        this.activeIndex = index;
        return changed;
      },
      onActivate: (index) => {
        const effort = this.opts.efforts[index];
        if (effort === undefined) return;
        this.activeIndex = index;
        this.opts.onSelect(effort);
      },
    });
  }

  render(width: number): string[] {
    this.hits.reset();
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

    const inline: InlineSegment<number>[] = [{ text: '  ' }];
    for (let index = 0; index < this.opts.efforts.length; index++) {
      if (index > 0) inline.push({ text: '  ' });
      const label = effortLabel(this.opts.efforts[index]!);
      inline.push({
        text:
          index === this.activeIndex
            ? currentTheme.boldFg('primary', `[ ${label} ]`)
            : currentTheme.fg('text', `  ${label}  `),
        value: index,
      });
    }
    const rendered = renderInlineSegments(inline, width);
    this.hits.addRow(lines.length, rendered.targets);
    lines.push(rendered.line);
    const description = this.opts.descriptions?.[this.opts.efforts[this.activeIndex]!];
    if (description !== undefined) lines.push(currentTheme.fg('textMuted', ` ${description}`));

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
