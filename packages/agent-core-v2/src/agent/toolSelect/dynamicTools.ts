/**
 * `toolSelect` domain (L4) — predicates and shaping helpers for the
 * select_tools progressive-disclosure protocol context.
 *
 * Exposes pure helpers for recognizing injected tool-schema messages,
 * folding loadable-tool announcements, rendering announcement text, and
 * stripping dynamic-tool protocol context from an outgoing history view.
 *
 * Two kinds of messages carry the protocol state in the history:
 *   - dynamic tool schema messages: `role: 'system'` messages whose `tools`
 *     field holds full tool definitions (origin
 *     `{kind: 'injection', variant: 'dynamic_tool_schema'}`) — tool loading is
 *     protocol context, not conversation. v2's undo cuts histories at the
 *     first real user prompt it finds regardless of origin: schema messages
 *     survive only when the cut lands before them, otherwise
 *     `toolSelectService` reconciles its pending ledger from the surviving
 *     history on the `context.spliced` event so the model can re-select.
 *   - loadable-tools announcements: `<tools_added>/<tools_removed>` system
 *     reminders (origin `{kind: 'system_trigger', name: 'loadable-tools'}`) —
 *     undo removes them (they are not `injection`-origin), and the next
 *     turn-boundary diff self-heals by re-announcing the folded delta.
 *
 * The loaded-tool ledger is the history itself: there is deliberately no
 * separate persisted ledger, so undo/compaction/resume all self-heal by
 * re-folding. Everything here anchors on `origin` or the `tools` field, so
 * callers that need to filter MUST run before `project()` — projection
 * strips `origin`.
 */

import type { ContextMessage } from '#/agent/contextMemory/types';

export const DYNAMIC_TOOL_SCHEMA_VARIANT = 'dynamic_tool_schema';

export const LOADABLE_TOOLS_TRIGGER = 'loadable-tools';

export function isDynamicToolSchemaMessage(message: ContextMessage): boolean {
  return message.tools !== undefined && message.tools.length > 0;
}

export function isLoadableToolsAnnouncement(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'system_trigger' &&
    message.origin.name === LOADABLE_TOOLS_TRIGGER
  );
}

export function stripDynamicToolContext(
  history: readonly ContextMessage[],
): readonly ContextMessage[] {
  if (!history.some((m) => isDynamicToolSchemaMessage(m) || isLoadableToolsAnnouncement(m))) {
    return history;
  }
  const out: ContextMessage[] = [];
  for (const message of history) {
    if (isLoadableToolsAnnouncement(message)) continue;
    if (isDynamicToolSchemaMessage(message)) {
      const { tools: _tools, ...rest } = message;
      void _tools;
      if (rest.content.length === 0 && rest.toolCalls.length === 0) continue;
      out.push(rest);
      continue;
    }
    out.push(message);
  }
  return out;
}

export function collectLoadedDynamicToolNames(
  history: readonly ContextMessage[],
): Set<string> {
  const names = new Set<string>();
  for (const message of history) {
    if (message.tools === undefined) continue;
    for (const tool of message.tools) {
      names.add(tool.name);
    }
  }
  return names;
}

const TOOLS_ADDED_BLOCK = /<tools_added>\n?([\s\S]*?)\n?<\/tools_added>/g;
const TOOLS_REMOVED_BLOCK = /<tools_removed>\n?([\s\S]*?)\n?<\/tools_removed>/g;

export function foldAnnouncedToolNames(history: readonly ContextMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const message of history) {
    if (!isLoadableToolsAnnouncement(message)) continue;
    const text = message.content
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
