import { getMarkdown } from 'markstream-vue';

export function markdownTableSources(text: string): string[] {
  if (!text.includes('|')) return [];
  const lines = text.split('\n');
  const sources: string[] = [];
  for (const token of getMarkdown('markdown-table-sources').parse(text, {})) {
    if (token.type !== 'table_open' || !token.map) continue;
    sources.push(lines.slice(token.map[0], token.map[1]).join('\n'));
  }
  return sources;
}
