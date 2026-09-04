/**
 * Summary-style renderers — produce an inline glance for tools whose raw
 * output is high-volume but low-information (Grep, Glob). The numeric
 * summary (line counts, sizes) lives in the header chip (see chip.ts); the
 * glance is the collapsed card's outcome row, and the raw output only
 * appears when the global expand toggle is on.
 *
 * Errors always fall through to the truncated renderer so the user
 * sees the actual error message, not a synthetic summary.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { Text } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

import { parseGlobOutput, parseGrepOutput } from './grep-output';
import { outcomeLine } from './outcome';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

const GLANCE_SAMPLES = 3;

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => string;

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    if (result.is_error) return renderTruncated(toolCall, result, ctx);

    const out: Component[] = [];
    // The glance is the collapsed card's outcome row (one width-truncated
    // line); the raw output only follows once expanded.
    if (glance !== null) {
      const line = glance(toolCall, result);
      if (line.length > 0) {
        out.push(ctx.expanded ? new Text(`  ${currentTheme.dim(line)}`, 0, 0) : outcomeLine(line));
      }
    }
    if (ctx.expanded && result.output.length > 0) {
      out.push(new Text(currentTheme.dim(result.output), 4, 0));
    }
    return out;
  };
}

function sampleList(labels: readonly string[]): string {
  if (labels.length === 0) return '';
  const samples = labels.slice(0, GLANCE_SAMPLES);
  const remaining = labels.length - samples.length;
  const tail = remaining > 0 ? `, +${String(remaining)} more` : '';
  return `${samples.join(', ')}${tail}`;
}

// Path samples in the shape the mode returns — `path`, `path:line` (the
// matched text is dropped), or `path:count` — with the tool's notices left
// out.
const grepGlance: GlanceFn = (toolCall, result) =>
  sampleList(parseGrepOutput(toolCall, result.output).entries.map((entry) => entry.label));

const globGlance: GlanceFn = (_toolCall, result) => sampleList(parseGlobOutput(result.output));

// ── Exports ──────────────────────────────────────────────────────────

// Tools whose chip already conveys everything — the body is empty in
// the collapsed state and only the raw output appears when expanded.
export const readSummary: ResultRenderer = withGlance(null);
export const fetchSummary: ResultRenderer = withGlance(null);
export const webSearchSummary: ResultRenderer = withGlance(null);
export const thinkSummary: ResultRenderer = withGlance(null);
export const editSummary: ResultRenderer = withGlance(null);
export const writeSummary: ResultRenderer = withGlance(null);

// Tools that benefit from inline path samples below the chip.
export const grepSummary: ResultRenderer = withGlance(grepGlance);
export const globSummary: ResultRenderer = withGlance(globGlance);
