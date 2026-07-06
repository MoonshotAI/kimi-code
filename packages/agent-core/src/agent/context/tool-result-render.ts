/**
 * The single place where a stored tool result (pure data + structured
 * status/note) is rendered into the content the model actually receives.
 *
 * History and wire records store facts: the tool's own `output`, the
 * structured `isError` flag, and an optional `note` (content routed to the
 * model but never to user-facing UIs — see `ExecutableToolResult.note`).
 * Rendering those facts into model-visible text is a provider-boundary
 * concern and happens exactly once, here:
 *
 * - a failed call gets a plain-text `ERROR:` status prefix (meant for both
 *   the model and humans — UIs that show projected text may show it too);
 * - an empty output is replaced with a placeholder so strict providers do
 *   not reject an empty tool message;
 * - the note, when present, is appended verbatim. No wrapping is added: any
 *   formatting is the producing tool's choice. A text-only result keeps a
 *   SINGLE text part (note joined with a newline): providers serialize that
 *   as plain string tool content — some OpenAI-compatible backends reject
 *   content-part arrays on tool messages, and joining providers (Google
 *   GenAI, `extract_text`) concatenate parts without a separator. Media-
 *   bearing results get the note as their own trailing text part.
 *
 * Callers: the live LLM projection (`agent/context/projector.ts`) and the
 * vis debugger's model view, which must mirror the live projection exactly.
 */
import type { ContentPart } from '@moonshot-ai/kosong';

export const TOOL_ERROR_STATUS = 'ERROR: Tool execution failed.';
export const TOOL_EMPTY_STATUS = 'Tool output is empty.';
export const TOOL_EMPTY_ERROR_STATUS = 'ERROR: Tool execution failed. Tool output is empty.';

export interface RenderableToolResult {
  readonly output: string | readonly ContentPart[];
  readonly note?: string | undefined;
  readonly isError?: boolean | undefined;
}

export function renderToolResultForModel(result: RenderableToolResult): ContentPart[] {
  const rendered = renderStatus(result);
  if (result.note === undefined || result.note.length === 0) {
    return rendered;
  }
  const only = rendered[0];
  if (rendered.length === 1 && only?.type === 'text') {
    return [textPart(`${only.text}\n${result.note}`)];
  }
  return [...rendered, textPart(result.note)];
}

function renderStatus(result: RenderableToolResult): ContentPart[] {
  const output = result.output;

  // String outputs — and their history form, a single text part — keep the
  // legacy joined shape: the status prefix shares one text part with the
  // output so provider serialization is unchanged.
  const single = typeof output === 'string' ? output : singleTextPart(output);
  if (single !== undefined) {
    if (result.isError === true) {
      if (single.length === 0) return [textPart(TOOL_EMPTY_ERROR_STATUS)];
      if (single.trimStart().startsWith('ERROR:')) return [textPart(single)];
      return [textPart(`${TOOL_ERROR_STATUS}\n${single}`)];
    }
    return isEmptyOutputText(single) ? [textPart(TOOL_EMPTY_STATUS)] : [textPart(single)];
  }

  const parts = output as readonly ContentPart[];
  // An array with no sendable content (empty, or only empty/whitespace-only
  // text blocks) gets the placeholder. Otherwise projection would drop the
  // blank text blocks, leave the tool message empty, and throw on every send.
  if (isEmptyEquivalentContentArray(parts)) {
    return [textPart(result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS)];
  }
  if (result.isError === true) {
    return [textPart(TOOL_ERROR_STATUS), ...parts];
  }
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
  return output.trim().length === 0 || output.trim() === TOOL_EMPTY_STATUS;
}

function isEmptyEquivalentContentArray(output: readonly ContentPart[]): boolean {
  return output.every((part) => part.type === 'text' && part.text.trim().length === 0);
}
