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
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

const HEAD_INDENT = '  ';
const DETAIL_INDENT = '    ';

export class GoalMarkerComponent implements Component {
  private expanded = false;

  constructor(
    private readonly headline: string,
    private readonly detail: string | undefined,
    private readonly colors: ColorPalette,
    private readonly accentHex: string,
  ) {}

  invalidate(): void {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const dot = chalk.hex(this.accentHex)('◦');
    const head = chalk.hex(this.colors.textDim)(this.headline);
    const hasDetail = this.detail !== undefined && this.detail.length > 0;
    if (!hasDetail) return [`${HEAD_INDENT}${dot} ${head}`];

    if (!this.expanded) {
      return [`${HEAD_INDENT}${dot} ${head} ${chalk.hex(this.colors.textMuted)('(ctrl+o)')}`];
    }
    const out = [`${HEAD_INDENT}${dot} ${head}`];
    const wrapWidth = Math.max(20, width - DETAIL_INDENT.length);
    for (const line of wrap(this.detail!, wrapWidth)) {
      out.push(DETAIL_INDENT + chalk.hex(this.colors.textDim)(line));
    }
    return out;
  }
}

/**
 * Builds a marker for a lifecycle / verdict change, or `null` when the change
 * should be silent (plain `continue`, model reports, terminal — terminal is a
 * completion card instead). `expanded` seeds the initial ctrl+o state.
 */
export function buildGoalMarker(
  change: GoalChange,
  colors: ColorPalette,
  expanded: boolean,
): GoalMarkerComponent | null {
  const spec = markerSpec(change, colors);
  if (spec === null) return null;
  const marker = new GoalMarkerComponent(spec.headline, change.reason, colors, spec.accentHex);
  marker.setExpanded(expanded);
  return marker;
}

function markerSpec(
  change: GoalChange,
  colors: ColorPalette,
): { headline: string; accentHex: string } | null {
  if (change.kind === 'verdict') {
    return change.verdict === 'no_progress'
      ? { headline: 'Goal: no progress', accentHex: colors.warning }
      : null; // continue / other verdicts are silent
  }
  if (change.kind === 'lifecycle') {
    switch (change.status) {
      case 'paused':
        return { headline: 'Goal paused', accentHex: colors.textDim };
      case 'active':
        return { headline: 'Goal resumed', accentHex: colors.primary };
      case 'cancelled':
        return { headline: 'Goal cancelled', accentHex: colors.textDim };
      default:
        return null;
    }
  }
  return null; // terminal -> completion card
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
