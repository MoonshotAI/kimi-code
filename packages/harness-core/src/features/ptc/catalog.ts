import type { ToolDescription } from '@moonshot-ai/agent-core/llm/message';

export const MAX_CATALOG_CHARS = 8000;

export function renderCatalog(
  tools: readonly ToolDescription[],
  exclude: ReadonlySet<string>,
): string {
  const lines: string[] = [];
  let omitted = 0;
  for (const tool of tools) {
    if (exclude.has(tool.name)) continue;
    const entry = `### ${tool.name}\n${tool.description.trim()}\nparameters: ${JSON.stringify(tool.parameters)}`;
    if (lines.length > 0 && lines.join('\n\n').length + entry.length > MAX_CATALOG_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(entry);
  }
  if (omitted > 0) {
    lines.push(`(${omitted} more tools available but omitted from this catalog; they remain callable via tools.<name>(args) if you know the name.)`);
  }
  return lines.join('\n\n');
}
