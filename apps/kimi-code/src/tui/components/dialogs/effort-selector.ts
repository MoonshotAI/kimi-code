import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@earendil-works/pi-tui';

import type { ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';

import { levelLabel } from './model-selector';

export interface EffortSelectorOptions {
  readonly title?: string;
  /** Selectable thinking efforts for the current model (e.g. ["off","low","high","max"]). */
  readonly levels: readonly ThinkingEffort[];
  /** Currently active effort (highlighted). */
  readonly currentValue: ThinkingEffort;
  readonly onSelect: (effort: ThinkingEffort) => void;
  /** When provided, Alt+S applies the choice to the current session only. */
  readonly onSessionOnlySelect?: (effort: ThinkingEffort) => void;
  readonly onCancel: () => void;
}

/**
 * Horizontal segmented picker for the `/effort` command.
 *
 * Mirrors the thinking control rendered under `/model` (see
 * `renderThinkingControl` in model-selector.ts): a single row of segments,
 * the active one wrapped in `[ ]`. ←/→ step the active segment, Enter
 * commits, and Alt+S (when provided) applies session-only.
 */
export class EffortSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: EffortSelectorOptions;
  private activeIndex: number;

  constructor(opts: EffortSelectorOptions) {
    super();
    this.opts = opts;
    const idx = opts.levels.indexOf(opts.currentValue);
    this.activeIndex = Math.max(idx, 0);
  }

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
      this.activeIndex = Math.min(this.opts.levels.length - 1, this.activeIndex + 1);
      return;
    }
    if (matchesKey(data, Key.alt('s')) && this.opts.onSessionOnlySelect !== undefined) {
      this.opts.onSessionOnlySelect(this.opts.levels[this.activeIndex]!);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.opts.onSelect(this.opts.levels[this.activeIndex]!);
      return;
    }
  }

  override render(width: number): string[] {
    const hintParts = ['←→ switch', 'Enter select'];
    if (this.opts.onSessionOnlySelect !== undefined) hintParts.push('Alt+S session-only');
    hintParts.push('Esc cancel');

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${this.opts.title ?? 'Select thinking effort'}`),
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    const segments = this.opts.levels.map((effort, index) => {
      const label = levelLabel(effort);
      return index === this.activeIndex
        ? currentTheme.boldFg('primary', `[ ${label} ]`)
        : currentTheme.fg('text', `  ${label}  `);
    });
    lines.push(`  ${segments.join('  ')}`);

    lines.push('');
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
