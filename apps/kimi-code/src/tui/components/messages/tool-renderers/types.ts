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
