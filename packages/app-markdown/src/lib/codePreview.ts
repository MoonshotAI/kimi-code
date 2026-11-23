import { getMarkdown } from 'markstream-vue';

export function markdownFenceSources(text: string): string[] {
  if (!/(?:`{3,}|~{3,})[ \t]*(?:markdown|md)\b/i.test(text)) return [];
  return getMarkdown('markdown-code-preview').parse(text, {})
    .filter(token => token.type === 'fence' && /^(?:markdown|md)(?:\s|$)/i.test(token.info.trim()))
    .map(token => token.content);
}

export function isMarkdownCodeHeader(title: string | null | undefined, caption: string | null | undefined): boolean {
  const matches = (text: string | null | undefined) => text != null && ['markdown', 'md'].includes(text.trim().toLowerCase());
  return matches(title) || matches(caption);
}
