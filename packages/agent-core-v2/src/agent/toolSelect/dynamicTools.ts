import { isUserEntry, type HistoryMessage, type SystemEntry } from '#human/agent/turn';
import type { ToolDescription } from '#human/llm/message';

export const DYNAMIC_TOOL_SCHEMA_VARIANT = 'dynamic_tool_schema';

export const LOADABLE_TOOLS_VARIANT = 'loadable-tools';

export function isDynamicToolSchemaMessage(
  entry: HistoryMessage,
): entry is SystemEntry & { message: SystemEntry['message'] & { readonly tools: ToolDescription[] } } {
  return (
    entry.message.role === 'system' &&
    entry.message.tools !== undefined &&
    entry.message.tools.length > 0
  );
}

export function isLoadableToolsAnnouncement(entry: HistoryMessage): boolean {
  const origin = isUserEntry(entry) ? entry.meta?.origin : undefined;
  if (origin?.kind === 'injection') return origin.variant === LOADABLE_TOOLS_VARIANT;
  return origin?.kind === 'system_trigger' && origin.name === LOADABLE_TOOLS_VARIANT;
}

export function stripDynamicToolContext(
  history: readonly HistoryMessage[],
): readonly HistoryMessage[] {
  if (!history.some((m) => isDynamicToolSchemaMessage(m) || isLoadableToolsAnnouncement(m))) {
    return history;
  }
  const out: HistoryMessage[] = [];
  for (const entry of history) {
    if (isLoadableToolsAnnouncement(entry)) continue;
    if (isDynamicToolSchemaMessage(entry)) {
      const { tools: _tools, ...restMessage } = entry.message;
      void _tools;
      if (restMessage.content.length === 0) continue;
      out.push({ ...entry, message: restMessage });
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function collectLoadedDynamicToolNames(
  history: readonly HistoryMessage[],
): Set<string> {
  const names = new Set<string>();
  for (const entry of history) {
    if (!isDynamicToolSchemaMessage(entry)) continue;
    for (const tool of entry.message.tools) {
      names.add(tool.name);
    }
  }
  return names;
}

const TOOLS_ADDED_BLOCK = /<tools_added>\n?([\s\S]*?)\n?<\/tools_added>/g;
const TOOLS_REMOVED_BLOCK = /<tools_removed>\n?([\s\S]*?)\n?<\/tools_removed>/g;

export function foldAnnouncedToolNames(history: readonly HistoryMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const entry of history) {
    if (!isLoadableToolsAnnouncement(entry)) continue;
    const text = entry.message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    for (const name of matchToolNameBlocks(text, TOOLS_REMOVED_BLOCK)) {
      announced.delete(name);
    }
    for (const name of matchToolNameBlocks(text, TOOLS_ADDED_BLOCK)) {
      announced.add(name);
    }
  }
  return announced;
}

export function renderLoadableToolsAnnouncement(
  added: readonly string[],
  removed: readonly string[],
): string {
  const sections: string[] = [];
  if (added.length > 0) {
    sections.push(`<tools_added>\n${added.join('\n')}\n</tools_added>`);
  }
  if (removed.length > 0) {
    sections.push(`<tools_removed>\n${removed.join('\n')}\n</tools_removed>`);
  }
  sections.push(
    'Use the select_tools tool with exact names to load full tool definitions before calling them. ' +
      'Names listed as removed are no longer loadable — do not select them. ' +
      'Fold all announcements in this conversation in order to get the current list.',
  );
  return sections.join('\n\n');
}

function matchToolNameBlocks(text: string, pattern: RegExp): string[] {
  const names: string[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const body = match[1] ?? '';
    for (const line of body.split('\n')) {
      const name = line.trim();
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}
