/**
 * Notification XML rendering — produces the chat-history injection text
 * shared between the live ContextMemory and the projector.
 *
 * Output shape:
 *   <notification id="..." category="..." type="..." source_kind="..." source_id="..." [agent_id="..."]>
 *   Title: ...
 *   Severity: ...
 *   <body>
 *   <children...>
 *   </notification>
 *
 * The opening tag name (`<notification `) is load-bearing for notification
 * consumers that detect chat-history injections.
 *
 * `agent_id` is emitted only for background_task notifications whose
 * source task is an agent subagent — surfacing it structurally lets the
 * LLM identify the correct id to pass to `Agent(resume=...)` without
 * having to grep the body or the original spawn-success ToolResult.
 * It is intentionally a separate attribute from `source_id`: the two
 * look alike (`agent-...`) but live in different namespaces.
 */

import { escapeXmlAttr } from '#/utils/xml-escape';

export function renderNotificationXml(data: Record<string, unknown>): string {
  const id = stringAttr(data['id'], 'unknown');
  const category = stringAttr(data['category'], 'unknown');
  const type = stringAttr(data['type'], 'unknown');
  const sourceKind = stringAttr(data['source_kind'], 'unknown');
  const sourceId = stringAttr(data['source_id'], 'unknown');
  const agentId = optionalStringAttr(data['agent_id']);
  const title = typeof data['title'] === 'string' ? data['title'] : '';
  const severity = typeof data['severity'] === 'string' ? data['severity'] : '';
  const body = typeof data['body'] === 'string' ? data['body'] : '';
  const children = childBlocks(data['children'] ?? data['extraBlocks']);

  const agentIdAttr = agentId === undefined ? '' : ` agent_id="${agentId}"`;
  const lines: string[] = [
    `<notification id="${id}" category="${category}" type="${type}" source_kind="${sourceKind}" source_id="${sourceId}"${agentIdAttr}>`,
  ];
  if (title.length > 0) lines.push(`Title: ${title}`);
  if (severity.length > 0) lines.push(`Severity: ${severity}`);
  if (body.length > 0) lines.push(body);
  lines.push(...children);

  lines.push('</notification>');
  return lines.join('\n');
}

function stringAttr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return escapeXmlAttr(value);
}

/** Like `stringAttr` but returns `undefined` instead of a fallback so the
 *  caller can omit the attribute entirely when the source value is absent. */
function optionalStringAttr(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function childBlocks(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
