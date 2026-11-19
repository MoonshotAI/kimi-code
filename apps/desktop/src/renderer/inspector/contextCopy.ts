import type { SessionContextItemDetail, SessionContextItemPart } from '@moonshot-ai/app-core/api';

function readableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

export function contextPartText(part: SessionContextItemPart): string {
  if ((part.kind === 'text' || part.kind === 'think') && typeof part.text === 'string') {
    return part.name ? `# ${part.name}\n\n${part.text}` : part.text;
  }
  const children = part.children
    ?.map((child) => contextPartText(child))
    .filter((text) => text.length > 0) ?? [];
  const body = children.length > 0 ? children.join('\n\n') : readableValue(part.data);
  const name = part.name ?? part.id ?? '';
  if (!name) return body;
  if (!body) return name;
  return `${name}\n${body}`;
}

export function contextItemText(detail: SessionContextItemDetail): string {
  if (typeof detail.raw === 'string') return detail.raw;
  return detail.parts
    .map((part) => contextPartText(part))
    .filter((text) => text.length > 0)
    .join('\n\n');
}
