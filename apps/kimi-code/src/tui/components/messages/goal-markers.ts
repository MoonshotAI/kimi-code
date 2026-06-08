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

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';

const HEAD_INDENT = '  ';
const DETAIL_INDENT = '    ';

type GoalMarkerActor = 'user' | 'model' | 'runtime' | 'system';

interface GoalMarkerOptions {
  readonly marker?: string;
  readonly textHex?: string;
  readonly expandable?: boolean;
  readonly indent?: string;
  readonly leadingBlank?: boolean;
}

export class GoalMarkerComponent implements Component {
  private expanded = false;
  private readonly marker: string;
  private readonly textHex: string;
  private readonly expandable: boolean;
  private readonly indent: string;
  private readonly leadingBlank: boolean;

  constructor(
    private readonly headline: string,
    private readonly detail: string | undefined,
    private readonly colors: ColorPalette,
    private readonly accentHex: string,
    options: GoalMarkerOptions = {},
  ) {
    this.marker = options.marker ?? '◦';
    this.textHex = options.textHex ?? colors.textDim;
    this.expandable = options.expandable ?? true;
    this.indent = options.indent ?? HEAD_INDENT;
    this.leadingBlank = options.leadingBlank ?? false;
  }

  invalidate(): void {}

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  render(width: number): string[] {
    const dot = chalk.hex(this.accentHex)(this.marker);
    const head = chalk.hex(this.textHex)(this.headline);
    const hasDetail = this.detail !== undefined && this.detail.length > 0;
    if (!hasDetail) return this.withLeadingBlank([`${this.indent}${dot} ${head}`]);

    if (!this.expandable) {
      return this.withLeadingBlank([`${this.indent}${dot} ${head}`]);
    }
    if (!this.expanded) {
      return this.withLeadingBlank([
        `${this.indent}${dot} ${head} ${chalk.hex(this.colors.textMuted)('(ctrl+o)')}`,
      ]);
    }
    const out = [`${this.indent}${dot} ${head}`];
    const wrapWidth = Math.max(20, width - DETAIL_INDENT.length);
    for (const line of wrap(this.detail!, wrapWidth)) {
      out.push(DETAIL_INDENT + chalk.hex(this.colors.textDim)(line));
    }
    return this.withLeadingBlank(out);
  }

  private withLeadingBlank(lines: string[]): string[] {
    return this.leadingBlank ? ['', ...lines] : lines;
  }
}

/**
 * Builds a marker for a lifecycle change (paused / resumed / blocked), or `null`
 * when the change should be silent (a `completion` change posts its own message,
 * not a marker). `expanded` seeds the initial ctrl+o state.
 */
export function buildGoalMarker(
  change: GoalChange,
  colors: ColorPalette,
  expanded: boolean,
  actor?: GoalMarkerActor,
): GoalMarkerComponent | null {
  const spec = markerSpec(change, colors, actor);
  if (spec === null) return null;
  const marker = new GoalMarkerComponent(
    spec.headline,
    spec.detail ?? change.reason,
    colors,
    spec.accentHex,
    spec.options,
  );
  marker.setExpanded(expanded);
  return marker;
}

function markerSpec(
  change: GoalChange,
  colors: ColorPalette,
  actor?: GoalMarkerActor,
): {
  headline: string;
  accentHex: string;
  detail?: string | undefined;
  options?: GoalMarkerOptions | undefined;
} | null {
  if (change.kind === 'lifecycle') {
    switch (change.status) {
      case 'paused':
        return prominentMarker(pausedHeadline(change.reason, actor), colors.warning);
      case 'active':
        return prominentMarker(resumedHeadline(actor), colors.primary);
      case 'blocked':
        // The system stopped pursuing the goal; resumable via `/goal resume`.
        return { headline: 'Goal blocked', accentHex: colors.warning };
      default:
        return null;
    }
  }
  return null; // completion -> posts its own message, not a marker
}

function prominentMarker(headline: string, accentHex: string) {
  return {
    headline,
    accentHex,
    detail: undefined,
    options: {
      marker: STATUS_BULLET.trimEnd(),
      textHex: accentHex,
      expandable: false,
      indent: '',
      leadingBlank: true,
    },
  };
}

function pausedHeadline(reason: string | undefined, actor: GoalMarkerActor | undefined): string {
  if (reason === 'Paused after interruption') return "Goal paused due to user's interruption";
  if (actor === 'user') return 'Goal paused by the user.';
  if (reason?.startsWith('Paused ') === true) return `Goal ${lowercaseFirst(reason)}`;
  if (reason !== undefined && reason.length > 0) return `Goal paused: ${reason}`;
  return 'Goal paused';
}

function resumedHeadline(actor: GoalMarkerActor | undefined): string {
  if (actor === 'user') return 'Goal resumed by the user.';
  if (actor === 'model') return 'Goal resumed by the agent.';
  return 'Goal resumed';
}

function lowercaseFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toLowerCase()}${text.slice(1)}`;
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
