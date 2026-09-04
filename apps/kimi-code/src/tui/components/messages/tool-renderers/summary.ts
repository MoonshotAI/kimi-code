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

import { OUTCOME_GLANCE_SAMPLES, OUTCOME_ROW_INDENT } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

import { parseGlobOutput, parseGrepOutput } from './grep-output';
import { outcomeRow } from './outcome';
import { renderTruncated } from './truncated';
import { isSpilledToolOutput, type ResultRenderer } from './types';

interface Glance {
  readonly samples: string;
  readonly moreCount: number;
}

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => Glance | null;

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    // A spilled result is the truncation envelope, not data: its first line
    // tells the user the output was saved to a file.
    if (result.is_error || isSpilledToolOutput(result.output)) {
      return renderTruncated(toolCall, result, ctx);
    }

    const out: Component[] = [];
    // Collapsed: the glance is the card's outcome row — path samples in the
    // flexible middle and the "+N more" count in the fixed tail, so a width
    // cut drops samples, never the count. Expanded: one joined line above
    // the raw output.
    if (glance !== null) {
      const parts = glance(toolCall, result);
      if (parts !== null) {
        const tail = parts.moreCount > 0 ? `, +${String(parts.moreCount)} more` : '';
        out.push(
          ctx.expanded
            ? new Text(`  ${currentTheme.dim(`${parts.samples}${tail}`)}`, 0, 0)
            : outcomeRow(OUTCOME_ROW_INDENT, parts.samples, tail),
        );
      }
    }
    if (ctx.expanded && result.output.length > 0) {
      out.push(new Text(currentTheme.dim(result.output), 4, 0));
    }
    return out;
  };
}

function sampleList(labels: readonly string[], total = labels.length): Glance | null {
  if (labels.length === 0) return null;
  const samples = labels.slice(0, OUTCOME_GLANCE_SAMPLES);
  return { samples: samples.join(', '), moreCount: total - samples.length };
}

// Path samples in the shape the mode returns — `path`, `path:line` (the
// matched text is dropped), or `path:count` — with the tool's notices left
// out. A paginated result counts "+N more" against the tool-reported total,
// not just the page.
const grepGlance: GlanceFn = (toolCall, result) => {
  const stats = parseGrepOutput(toolCall, result.output);
  const labels = stats.entries.map((entry) => entry.label);
  return sampleList(labels, Math.max(labels.length, stats.total));
};

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
