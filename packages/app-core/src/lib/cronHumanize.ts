
export function collapsePrompt(
  text: string,
  limit = 120,
): { text: string; hasMore: boolean } {
  const firstLine = text.split('\n')[0] ?? '';
  const hasMore = text.includes('\n') || text.length > limit;
  const collapsed =
    firstLine.length > limit ? `${firstLine.slice(0, limit).trimEnd()}…` : firstLine;
  return { text: collapsed, hasMore };
}
