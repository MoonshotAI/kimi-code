/**
 * `contextMemory` domain helper — projects stored tool result facts into
 * model-visible content.
 *
 * Tool messages keep the raw tool output plus structured status fields in
 * context. The LLM projection is the only boundary that turns those facts into
 * system status text or appends model-only notes.
 */

import type { ContentPart } from '#/kosong/contract/message';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export interface RenderableToolResult {
  readonly output: string | readonly ContentPart[];
  readonly note?: string;
  readonly isError?: boolean;
}

export function renderToolResultForModel(result: RenderableToolResult): ContentPart[] {
  const rendered = renderStatus(result);
  if (result.note === undefined || result.note.length === 0) return rendered;
  const only = rendered[0];
  if (rendered.length === 1 && only?.type === 'text') {
    return [textPart(only.text + '\n' + result.note)];
  }
  return [...rendered, textPart(result.note)];
}

function renderStatus(result: RenderableToolResult): ContentPart[] {
  const output = result.output;
  const single = typeof output === 'string' ? output : singleTextPart(output);
  if (single !== undefined) {
    if (result.isError === true) {
      if (single.length === 0) return [textPart(TOOL_EMPTY_ERROR_STATUS)];
      return [textPart(TOOL_ERROR_STATUS + '\n' + single)];
    }
    return isEmptyOutputText(single) ? [textPart(TOOL_EMPTY_STATUS)] : [textPart(single)];
  }

  const parts = output as readonly ContentPart[];
  if (isEmptyEquivalentContentArray(parts)) {
    return [textPart(result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS)];
  }
  if (result.isError === true) return [textPart(TOOL_ERROR_STATUS), ...parts];
  return [...parts];
}

function singleTextPart(output: readonly ContentPart[]): string | undefined {
  const first = output[0];
  return output.length === 1 && first?.type === 'text' ? first.text : undefined;
}

function textPart(text: string): ContentPart {
  return { type: 'text', text };
}

function isEmptyOutputText(output: string): boolean {
  return output.trim().length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

function isEmptyEquivalentContentArray(output: readonly ContentPart[]): boolean {
  return output.every((part) => part.type === 'text' && part.text.trim().length === 0);
}
