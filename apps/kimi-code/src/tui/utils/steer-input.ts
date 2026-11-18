import type { PromptPart } from '@moonshot-ai/kimi-code-sdk';

import type { SteerInputItem } from '../types';

export function combineSteerInput(items: readonly SteerInputItem[]): string | PromptPart[] {
  const hasMedia = items.some((item) => item.parts !== undefined && item.parts.length > 0);
  if (!hasMedia) return items.map((item) => item.text).join('\n\n');
  const parts: PromptPart[] = [];
  for (const item of items) {
    const first = item.parts?.[0];
    const startsWithMedia = first !== undefined && first.type !== 'text';
    const lastIsMedia = parts.length > 0 && parts.at(-1)?.type !== 'text';
    if (parts.length > 0 && !(lastIsMedia && startsWithMedia)) {
      appendSteerText(parts, '\n\n');
    }
    if (item.parts !== undefined && item.parts.length > 0) {
      for (const part of item.parts) {
        if (part.type !== 'text') {
          parts.push(part);
          continue;
        }
        appendSteerText(parts, part.text);
      }
    } else {
      appendSteerText(parts, item.text);
    }
  }
  return parts;
}

function appendSteerText(parts: PromptPart[], text: string): void {
  const last = parts.at(-1);
  if (last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: last.text + text };
    return;
  }
  parts.push({ type: 'text', text });
}
