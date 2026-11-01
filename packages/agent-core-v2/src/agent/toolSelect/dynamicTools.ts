import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolDescription } from '#human/llm/message';
import { isMcpToolName } from '#/tool/toolContract';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';

import { SELECT_TOOLS_TOOL_NAME, type ToolSelectAnnouncementDisclosure } from './toolSelect';
import { toolSelectSchemaSignature, type ToolSelectTool } from './toolSelectOps';

export const DYNAMIC_TOOL_SCHEMA_VARIANT = 'dynamic_tool_schema';
export const LOADABLE_TOOLS_VARIANT = 'loadable-tools';

export function isDynamicToolSchemaMessage(
  message: ContextMessage,
): message is Extract<ContextMessage, { readonly role: 'system' }> {
  return message.role === 'system' && message.tools !== undefined && message.tools.length > 0;
}

export function isLoadableToolsAnnouncement(message: ContextMessage): boolean {
  const origin = message.origin;
  if (origin?.kind === 'injection') return origin.variant === LOADABLE_TOOLS_VARIANT;
  return origin?.kind === 'system_trigger' && origin.name === LOADABLE_TOOLS_VARIANT;
}

export function isToolSelectAnnouncementDisclosure(
  value: unknown,
): value is ToolSelectAnnouncementDisclosure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolSelectAnnouncementDisclosure>;
  if (typeof candidate.revision !== 'number') return false;
  if (candidate.kind === 'snapshot') return Array.isArray(candidate.tools);
  if (candidate.kind === 'delta') return Array.isArray(candidate.added) && Array.isArray(candidate.removed);
  return false;
}

function announcementDisclosure(
  message: ContextMessage,
): ToolSelectAnnouncementDisclosure | undefined {
  if (message.origin?.kind !== 'injection') return undefined;
  return isToolSelectAnnouncementDisclosure(message.origin.disclosure)
    ? message.origin.disclosure
    : undefined;
}

export function shapeUnsupportedDynamicToolContext(
  history: readonly ContextMessage[],
): readonly ContextMessage[] {
  const hiddenCallIds = new Set<string>();
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      if (call.name === SELECT_TOOLS_TOOL_NAME) hiddenCallIds.add(call.id);
    }
  }
  if (
    hiddenCallIds.size === 0 &&
    !history.some((message) => isDynamicToolSchemaMessage(message) || isLoadableToolsAnnouncement(message))
  ) {
    return history;
  }
  const out: ContextMessage[] = [];
  for (const message of history) {
    if (isLoadableToolsAnnouncement(message)) {
      const disclosure = announcementDisclosure(message);
      if (disclosure?.kind === 'snapshot') continue;
      const text = message.content.map((part) => part.type === 'text' ? part.text : '').join('');
      const added = disclosure?.kind === 'delta'
        ? disclosure.added.map((tool) => tool.name)
        : matchToolNameBlocks(text, TOOLS_ADDED_BLOCK);
      const removed = disclosure?.kind === 'delta'
        ? disclosure.removed.map((tool) => tool.name)
        : matchToolNameBlocks(text, TOOLS_REMOVED_BLOCK);
      out.push({
        ...message,
        content: [{ type: 'text', text: wrapSystemReminder(renderRuntimeToolChangeReminder(added, removed)) }],
      });
      continue;
    }
    if (isDynamicToolSchemaMessage(message)) {
      const { tools: _tools, ...rest } = message;
      void _tools;
      if (rest.content.length > 0) out.push(rest);
      continue;
    }
    if (message.role === 'tool') {
      if (message.toolCallId === undefined || !hiddenCallIds.has(message.toolCallId)) out.push(message);
      continue;
    }
    if (message.role !== 'assistant') {
      out.push(message);
      continue;
    }
    const toolCalls = message.toolCalls.filter((call) => call.name !== SELECT_TOOLS_TOOL_NAME);
    if (toolCalls.length === message.toolCalls.length) {
      out.push(message);
      continue;
    }
    if (toolCalls.length > 0 || message.content.length > 0) out.push({ ...message, toolCalls });
  }
  return out;
}

export function collectLoadedDynamicTools(
  history: readonly ContextMessage[],
  current: readonly ToolSelectTool[],
): ReadonlyMap<string, ToolDescription> {
  const loaded = new Map<string, ToolDescription>();
  for (const message of history) {
    if (isLoadableToolsAnnouncement(message)) {
      const disclosure = announcementDisclosure(message);
      const removed = disclosure?.kind === 'delta'
        ? disclosure.removed.map((tool) => tool.name)
        : matchToolNameBlocks(
            message.content.map((part) => part.type === 'text' ? part.text : '').join(''),
            TOOLS_REMOVED_BLOCK,
          );
      for (const name of removed) loaded.delete(name);
      continue;
    }
    if (!isDynamicToolSchemaMessage(message)) continue;
    for (const tool of message.tools ?? []) loaded.set(tool.name, tool);
  }
  const currentByName = new Map(current.map((tool) => [tool.name, tool]));
  for (const [name, schema] of loaded) {
    const currentTool = currentByName.get(name);
    if (
      (currentTool === undefined && !isMcpToolName(name)) ||
      (currentTool !== undefined &&
        toolSelectSchemaSignature(schema) !== toolSelectSchemaSignature(currentTool))
    ) {
      loaded.delete(name);
    }
  }
  return loaded;
}

export function collectLoadedDynamicToolNames(
  history: readonly ContextMessage[],
  current: readonly ToolSelectTool[],
): Set<string> {
  return new Set(collectLoadedDynamicTools(history, current).keys());
}

const TOOLS_ADDED_BLOCK = /<tools_added>\n?([\s\S]*?)\n?<\/tools_added>/g;
const TOOLS_REMOVED_BLOCK = /<tools_removed>\n?([\s\S]*?)\n?<\/tools_removed>/g;

export function foldAnnouncedToolNames(history: readonly ContextMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const message of history) {
    if (!isLoadableToolsAnnouncement(message)) continue;
    const text = message.content
      .map((part) => part.type === 'text' ? part.text : '')
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
  hasLoadableTools = true,
): string {
  const sections: string[] = [];
  if (added.length > 0) {
    sections.push(`<tools_added>\n${added.join('\n')}\n</tools_added>`);
  }
  if (removed.length > 0) {
    sections.push(`<tools_removed>\n${removed.join('\n')}\n</tools_removed>`);
  }
  if (!hasLoadableTools) {
    sections.push(
      'No tools are currently available for dynamic loading in this session. ' +
        'Do not call select_tools or guess tool names; use the tools you already have. ' +
        'Only a later <tools_added> announcement can make new tools loadable.',
    );
    return sections.join('\n\n');
  }
  sections.push(
    'Use the select_tools tool with exact names to load full definitions of the ' +
      'announced tools before calling them. ' +
      'Only the announced names are loadable — tools you already have available are called ' +
      'directly, never passed to select_tools; plugin, skill, or category names do not work. ' +
      'Names listed as removed are no longer loadable — do not select them. ' +
      'Fold all announcements in this conversation in order to get the current list.',
  );
  return sections.join('\n\n');
}

export function renderRuntimeToolChangeReminder(
  added: readonly string[],
  removed: readonly string[],
): string {
  const sections: string[] = [];
  if (added.length > 0) sections.push(`<tools_added>\n${added.join('\n')}\n</tools_added>`);
  if (removed.length > 0) sections.push(`<tools_removed>\n${removed.join('\n')}\n</tools_removed>`);
  sections.push(
    'The available tools changed during this session. The current model cannot load runtime ' +
      'tool additions or replacements with select_tools. Do not call select_tools. Tools from ' +
      'the initial session snapshot remain visible, but removed or replaced definitions may be ' +
      'unavailable or fail when called.',
  );
  return sections.join('\n\n');
}
