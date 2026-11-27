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

export class CardOnly implements Component {
  constructor(private readonly inner: Component) {}

  render(width: number): readonly string[] {
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

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

export function stripSpillPointer(output: string): string {
  if (output.startsWith(PER_LINE_SPILL_POINTER)) return '';
  const at = output.indexOf(`\n${PER_LINE_SPILL_POINTER}`);
  return at < 0 ? output : output.slice(0, at);
}
