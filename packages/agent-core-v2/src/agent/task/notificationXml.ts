import { escapeXmlAttr } from '#/_base/utils/xml-escape';

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

function optionalStringAttr(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return escapeXmlAttr(value);
}

function childBlocks(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
