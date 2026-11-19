import { normalizeToolName } from './normalizeToolName';

export interface NotifyUserUpdate {
  title: string;
  message: string;
}

export function isNotifyUserTool(name: string): boolean {
  return normalizeToolName(name) === 'notifyuser';
}

function stripLeadingMarkdown(line: string): string {
  return line.replace(/^[\s#>*-]+/, '').replaceAll('**', '').trim();
}

export function parseNotifyUserArgs(arg: string): NotifyUserUpdate {
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(arg);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { title: '', message: '' };
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return { title: '', message: '' };
  }
  const message = typeof record['message'] === 'string' ? record['message'].trim() : '';
  const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
  if (title.length > 0) return { title, message };
  const lines = message.split('\n');
  const firstIndex = lines.findIndex((line) => stripLeadingMarkdown(line).length > 0);
  if (firstIndex === -1) return { title: '', message: '' };
  const rest = lines.slice(firstIndex + 1).join('\n').trim();
  return {
    title: stripLeadingMarkdown(lines[firstIndex]!),
    message: rest.length > 0 ? rest : message,
  };
}
