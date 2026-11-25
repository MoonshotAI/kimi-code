import type { Component } from '@moonshot-ai/pi-tui';
import { Text } from '@moonshot-ai/pi-tui';

import { OUTCOME_GLANCE_SAMPLES, OUTCOME_ROW_INDENT } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

import { parseGlobOutput, parseGrepOutput, searchNoticeOnly } from './grep-output';
import { parseReadMediaOutput, renderReadMediaSummary } from './media';
import { outcomeRow, outcomeRows } from './outcome';
import { renderTruncated } from './truncated';
import { CardOnly, isSpilledToolOutput, type ResultRenderer } from './types';

interface Glance {
  readonly samples: string;
  readonly moreCount: number;
}

type GlanceFn = (
  toolCall: Parameters<ResultRenderer>[0],
  result: Parameters<ResultRenderer>[1],
) => Glance | null | 'fallback';

function withGlance(glance: GlanceFn | null): ResultRenderer {
  return (toolCall, result, ctx) => {
    if (result.is_error || isSpilledToolOutput(result.output)) {
      return renderTruncated(toolCall, result, ctx);
    }

    const out: Component[] = [];
    if (glance !== null) {
      const parts = glance(toolCall, result);
      if (parts === 'fallback') return renderTruncated(toolCall, result, ctx);
      if (parts !== null) {
        const tail = parts.moreCount > 0 ? `, +${String(parts.moreCount)} more` : '';
        out.push(
          ctx.expanded
            ? new CardOnly(new Text(currentTheme.dim(`${parts.samples}${tail}`), 2, 0))
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

const grepGlance: GlanceFn = (toolCall, result) => {
  if (searchNoticeOnly(toolCall, result.output)) return 'fallback';
  const stats = parseGrepOutput(toolCall, result.output);
  const labels = stats.entries.map((entry) => entry.label);
  return sampleList(labels, Math.max(labels.length, stats.total));
};

const globGlance: GlanceFn = (toolCall, result) => {
  if (searchNoticeOnly(toolCall, result.output)) return 'fallback';
  return sampleList(parseGlobOutput(result.output).entries);
};

const textReadSummary: ResultRenderer = withGlance(null);
export const readSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (!result.is_error) {
    const media = parseReadMediaOutput(result.output);
    if (media !== null) return renderReadMediaSummary(media, ctx);
  }
  return textReadSummary(toolCall, result, ctx);
};
export const fetchSummary: ResultRenderer = withGlance(null);
export const webSearchSummary: ResultRenderer = withGlance(null);
export const thinkSummary: ResultRenderer = withGlance(null);

const FILE_CHANGE_ACK = /^(?:Replaced \d+ occurrences? in |(?:Wrote|Appended) \d+ bytes to )/;
export const fileChangeSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);
  if (FILE_CHANGE_ACK.test(result.output)) return [];
  return outcomeRows(result.output, 'first');
};

export const grepSummary: ResultRenderer = withGlance(grepGlance);
export const globSummary: ResultRenderer = withGlance(globGlance);
