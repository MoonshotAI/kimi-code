import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/kosong/contract/message';

import type { SpineTrimOp, SpineTrimProjection, SpineTrimSliceShape } from './spineTrimDerive';

/** Placeholder body of a snipped result — verbatim upstream wording. */
export const SPINE_TRIM_SNIPPED_PLACEHOLDER = '[Old tool result content cleared]';

export function applySpineTrim(
  projection: SpineTrimProjection,
  index: number,
  message: ContextMessage,
): ContextMessage {
  const mask = projection.masks.get(index);
  if (mask !== undefined) return maskMessage(message, mask);
  const tag = projection.labels.get(index);
  if (tag === undefined) return message;
  return { ...message, content: prefixFirstText(message.content, `[TRIM_ID: ${tag}]\n`) };
}

function maskMessage(message: ContextMessage, op: SpineTrimOp): ContextMessage {
  const text =
    op.kind === 'snip' ? SPINE_TRIM_SNIPPED_PLACEHOLDER : sliceText(messageText(message), op.shape);
  return { ...message, content: [{ type: 'text', text }] };
}

function sliceText(text: string, shape: SpineTrimSliceShape): string {
  switch (shape.type) {
    case 'head':
      return Array.from(text).slice(0, shape.chars).join('');
    case 'tail': {
      const chars = Array.from(text);
      return chars.slice(Math.max(0, chars.length - shape.chars)).join('');
    }
    case 'anchor': {
      const window = anchorWindow(text, shape.anchor, shape.preceding, shape.following);
      return window ?? text;
    }
  }
}

function anchorWindow(
  text: string,
  anchor: string,
  preceding: number,
  following: number,
): string | undefined {
  const at = text.indexOf(anchor);
  if (at < 0) return undefined;
  let start = text.slice(0, at).lastIndexOf('\n') + 1;
  for (let i = 0; i < preceding && start > 0; i++) {
    const newline = text.lastIndexOf('\n', start - 2);
    const nextStart = newline + 1;
    if (nextStart >= start) break;
    start = nextStart;
  }
  let end = text.indexOf('\n', at);
  if (end < 0) end = text.length;
  for (let i = 0; i < following && end < text.length; i++) {
    const newline = text.indexOf('\n', end + 1);
    end = newline < 0 ? text.length : newline;
  }
  return text.slice(start, end);
}

function prefixFirstText(content: readonly ContentPart[], prefix: string): ContentPart[] {
  const index = content.findIndex((part) => part.type === 'text');
  if (index < 0) return [{ type: 'text', text: prefix.trimEnd() }, ...content];
  return content.map((part, position) =>
    position === index && part.type === 'text' ? { type: 'text', text: prefix + part.text } : part,
  );
}

function messageText(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
