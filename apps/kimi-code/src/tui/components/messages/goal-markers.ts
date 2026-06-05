/**
 * Low-profile transcript markers for the autonomous goal loop.
 *
 * Lifecycle changes (paused / resumed / cancelled) and `no_progress` verdicts
 * render as a single dim line — `◦ Goal paused` — that expands (ctrl+o, shared
 * with tool output) to show the reason when there is one. Terminal outcomes use
 * the richer completion card (the `/goal` box), not this marker.
 */

import type { Component } from '@earendil-works/pi-tui';
import type { GoalChange } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

const HEAD_INDENT = '  ';
const DETAIL_INDENT = '    ';

export class GoalMarkerComponent implements Component {
  private expanded = false;

  constructor(
    private readonly headline: string,
    private readonly detail: string | undefined,
    private readonly accentToken: ColorToken,
  ) {}

  invalidate(): void {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const dot = currentTheme.fg(this.accentToken, '◦');
    const head = currentTheme.fg('textDim', this.headline);
    const hasDetail = this.detail !== undefined && this.detail.length > 0;
    if (!hasDetail) return [`${HEAD_INDENT}${dot} ${head}`];

    if (!this.expanded) {
      return [`${HEAD_INDENT}${dot} ${head} ${currentTheme.fg('textMuted', '(ctrl+o)')}`];
    }
    const out = [`${HEAD_INDENT}${dot} ${head}`];
    const wrapWidth = Math.max(20, width - DETAIL_INDENT.length);
    for (const line of wrap(this.detail!, wrapWidth)) {
      out.push(DETAIL_INDENT + currentTheme.fg('textDim', line));
    }
    return out;
  }
}

/**
 * Builds a marker for a lifecycle change (paused / resumed / blocked), or `null`
 * when the change should be silent (a `completion` change posts its own message,
 * not a marker). `expanded` seeds the initial ctrl+o state.
 */
export function buildGoalMarker(
  change: GoalChange,
  expanded: boolean,
): GoalMarkerComponent | null {
  const spec = markerSpec(change);
  if (spec === null) return null;
  const marker = new GoalMarkerComponent(spec.headline, change.reason, spec.accentToken);
  marker.setExpanded(expanded);
  return marker;
}

function markerSpec(
  change: GoalChange,
): { headline: string; accentToken: ColorToken } | null {
  if (change.kind === 'lifecycle') {
    switch (change.status) {
      case 'paused':
        return { headline: 'Goal paused', accentToken: 'textDim' };
      case 'active':
        return { headline: 'Goal resumed', accentToken: 'primary' };
      case 'blocked':
        // The system stopped pursuing the goal; resumable via `/goal resume`.
        return { headline: 'Goal blocked', accentToken: 'warning' };
      default:
        return null;
    }
  }
  return null; // completion -> posts its own message, not a marker
}

function wrap(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
