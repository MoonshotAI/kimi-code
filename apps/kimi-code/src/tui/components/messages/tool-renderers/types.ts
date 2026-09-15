import type { Component } from '@moonshot-ai/pi-tui';

import { RESULT_PREVIEW_LINES } from '#/tui/constant/rendering';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

export interface RendererContext {
  readonly expanded: boolean;
}

export type ResultRenderer = (
  toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx: RendererContext,
) => Component[];

export const PREVIEW_LINES = RESULT_PREVIEW_LINES;

/**
 * Whether a tool result is the truncation envelope agent-core substitutes for
 * output over its size cap (metadata, `output_path`, and a head/tail preview).
 * Renderers that count or sample result lines must not read it as data.
 */
export function isSpilledToolOutput(output: string): boolean {
  return output.startsWith('Tool output exceeded ');
}

export function strArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

const PER_LINE_SPILL_POINTER = '[Per-line truncation occurred;';

/**
 * Drop the pointer agent-core appends when an oversized result kept its
 * shape but had long lines cut: three bracketed lines, `output_path` and
 * `next_step` included, that are metadata rather than output. Counts and
 * outcome rows read the output without it; the expanded body keeps it.
 */
export function stripSpillPointer(output: string): string {
  if (output.startsWith(PER_LINE_SPILL_POINTER)) return '';
  const at = output.indexOf(`\n${PER_LINE_SPILL_POINTER}`);
  return at < 0 ? output : output.slice(0, at);
}
