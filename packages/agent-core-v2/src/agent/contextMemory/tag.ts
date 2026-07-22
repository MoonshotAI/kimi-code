import type { ContentPart } from '#/kosong/contract/message';

/** Wrap plain text as `<tag>\n…\n</tag>`. */
export function wrapTag(content: string, tag: string): string {
  return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

/** Wrap every text part in `parts` with the given tag. Non-text parts pass through. */
export function applyTagToContent(parts: readonly ContentPart[], tag: string): ContentPart[] {
  return parts.map((part) =>
    part.type === 'text' ? { type: 'text' as const, text: wrapTag(part.text, tag) } : part,
  );
}
