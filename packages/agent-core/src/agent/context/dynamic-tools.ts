/**
 * Shared predicates and shaping helpers for select_tools progressive
 * disclosure protocol context.
 *
 * Two kinds of messages carry that protocol state in the history:
 *   - dynamic tool schema messages: `role: 'system'` messages whose `tools`
 *     field holds full tool definitions (origin
 *     `{kind: 'injection', variant: 'dynamic_tool_schema'}` so undo keeps
 *     them — tool loading is protocol context, not conversation);
 *   - loadable-tools announcements: `<tools_added>/<tools_removed>` system
 *     reminders (origin `{kind: 'system_trigger', name: 'loadable-tools'}` so
 *     undo removes them and the next turn-boundary diff self-heals).
 *
 * Everything here anchors on `origin` or the `tools` field, so callers that
 * need to filter MUST run before `project()` — projection strips `origin`.
 */

import type { ContextMessage } from './types';

/** Origin variant of an injected dynamic tool schema message (undo keeps it). */
export const DYNAMIC_TOOL_SCHEMA_VARIANT = 'dynamic_tool_schema';

/** Origin name of the loadable-tools diff announcements (undo removes them). */
export const LOADABLE_TOOLS_TRIGGER = 'loadable-tools';

/** True for a message that loads tool definitions (`message.tools` present). */
export function isDynamicToolSchemaMessage(message: ContextMessage): boolean {
  return message.tools !== undefined && message.tools.length > 0;
}

/** True for a `<tools_added>/<tools_removed>` announcement reminder. */
export function isLoadableToolsAnnouncement(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'system_trigger' && message.origin.name === LOADABLE_TOOLS_TRIGGER
  );
}

/**
 * Shape a history for a consumer that must not see dynamic-tool protocol
 * context: drop the loadable-tools announcements and strip `message.tools`
 * (dropping the message entirely when nothing else remains). Two callers:
 *   - projection for a model without the dynamically-loaded-tools capability
 *     (mid-session model switch — the canonical history keeps its shape, only
 *     the outgoing view changes; announcements would be noise and even
 *     reference a select_tools tool the model does not have);
 *   - the compaction summarizer input (schemas and announcements are protocol
 *     context, not conversation — summarizing them wastes tokens and risks
 *     leaking schema text into the summary).
 * Returns the input array unchanged when there is nothing to strip, so the
 * common no-dynamic-tools path costs one scan and no allocation.
 */
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

/** Union of tool names loaded by dynamic tool schema messages in `history`. */
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

/**
 * Fold every loadable-tools announcement in `history`, in order, into the
 * currently-announced name set (`tools_removed` deletes, then `tools_added`
 * adds — last wins). The announcements are the context's own record of what
 * the model has been told is loadable; there is deliberately no separate
 * persisted ledger, so undo/compaction/resume all self-heal by re-folding.
 */
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

/**
 * Render one diff announcement. Only the blocks with content are emitted; the
 * guidance sentence never contains a literal block tag, so `foldAnnouncedToolNames`
 * can anchor on the tags without tripping over prose.
 */
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
