// packages/app-core/src/client/notificationXml.ts
// Parses the model-facing `<notification …>` blocks that agent-core injects as
// hidden user messages (origin kind 'task_notification', see renderNotificationXml
// in agent-core) into structured display data. One message may carry several
// blocks (the step request is mergeable), so parsing is global; text that
// yields no well-formed block returns [] and the caller keeps the message
// hidden, exactly as before.
import type { TaskNotification } from './types';

export const TASK_NOTIFICATION_METADATA_KEY = 'kimiWeb.taskNotification';

const NOTIFICATION_RE = /<notification\b([^>]*)>([\s\S]*?)<\/notification>/g;
const ATTR_RE = /([\w-]+)="([^"]*)"/g;
const OUTPUT_FILE_RE = /<output-file\b([^>]*)>[\s\S]*?<\/output-file>/;
const OUTPUT_PREVIEW_RE = /<output-preview\b([^>]*)>([\s\S]*?)<\/output-preview>/;
const TITLE_RE = /^Title: (.*)$/m;
const SEVERITY_RE = /^Severity: (.*)$/m;

function unescapeAttr(value: string): string {
  // &amp; last so a doubly-escaped value isn't decoded twice.
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = unescapeAttr(m[2]);
  }
  return out;
}

function parseBlock(attrRaw: string, bodyRaw: string, raw: string): TaskNotification {
  const a = attrs(attrRaw);
  const title = TITLE_RE.exec(bodyRaw)?.[1]?.trim() ?? '';
  const severity = SEVERITY_RE.exec(bodyRaw)?.[1]?.trim() ?? '';
  // Body text runs from after the Title/Severity header lines to the first
  // child block (e.g. <output-file>); child markup itself is not prose.
  let body = bodyRaw
    .split('\n')
    .filter((line) => !line.startsWith('Title: ') && !line.startsWith('Severity: '))
    .join('\n');
  const childAt = body.search(/^<\w/m);
  if (childAt !== -1) body = body.slice(0, childAt);
  body = body.trim();

  const out = OUTPUT_FILE_RE.exec(bodyRaw);
  const outputFile = out
    ? (() => {
        const oa = attrs(out[1] ?? '');
        const bytes = Number(oa['bytes']);
        return oa['path'] !== undefined && oa['path'] !== ''
          ? { path: oa['path'], bytes: Number.isFinite(bytes) ? bytes : undefined }
          : undefined;
      })()
    : undefined;

  // `<output-preview>` carries the buffered task output when no persisted
  // full output file exists. Its content is a one-line explanation ("Showing
  // the last N bytes…") followed by the XML-escaped output text — only the
  // text is kept, the explanation is redisplayed from the parsed attrs.
  const prev = OUTPUT_PREVIEW_RE.exec(bodyRaw);
  const outputPreview = prev
    ? (() => {
        const pa = attrs(prev[1] ?? '');
        // The rendered block puts a newline right after the opening tag.
        const content = (prev[2] ?? '').replace(/^\n/, '');
        const nl = content.indexOf('\n');
        const text = unescapeAttr(nl === -1 ? '' : content.slice(nl + 1)).replace(/\n$/, '');
        const bytes = Number(pa['bytes']);
        const totalBytes = Number(pa['total_bytes']);
        return {
          text,
          bytes: Number.isFinite(bytes) ? bytes : undefined,
          totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
          truncated:
            pa['truncated'] === 'true' ? true : pa['truncated'] === 'false' ? false : undefined,
        };
      })()
    : undefined;

  return {
    id: a['id'] ?? '',
    category: a['category'] ?? '',
    type: a['type'] ?? '',
    sourceKind: a['source_kind'] ?? '',
    sourceId: a['source_id'] ?? '',
    agentId: a['agent_id'],
    // Text nodes are XML-escaped just like attributes (e.g. a task title with
    // `&&` arrives as `&amp;&amp;`) — decode before display.
    title: unescapeAttr(title),
    severity,
    body: unescapeAttr(body),
    outputFile,
    outputPreview,
    raw,
  };
}

/** Extract every well-formed `<notification>` block from a hidden user
    message's text. */
export function parseTaskNotifications(text: string): TaskNotification[] {
  if (!text.includes('<notification')) return [];
  const out: TaskNotification[] = [];
  for (const m of text.matchAll(NOTIFICATION_RE)) {
    if (m[1] === undefined || m[2] === undefined) continue;
    out.push(parseBlock(m[1], m[2], m[0]));
  }
  return out;
}

export function taskNotificationFromMetadata(
  metadata: Record<string, unknown> | undefined,
): TaskNotification | undefined {
  const value = metadata?.[TASK_NOTIFICATION_METADATA_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  for (const key of [
    'id',
    'category',
    'type',
    'sourceKind',
    'sourceId',
    'title',
    'severity',
    'body',
    'raw',
  ]) {
    if (typeof candidate[key] !== 'string') return undefined;
  }
  return value as TaskNotification;
}

/** Display status derived from the raw type/severity — drives the card's
    variant, icon and wording. 'lost' maps to the failed look (danger). */
export type NotificationStatus = 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost' | 'info';

export function notificationStatus(n: TaskNotification): NotificationStatus {
  for (const s of ['completed', 'failed', 'timed_out', 'killed', 'lost'] as const) {
    if (n.type.endsWith(`.${s}`)) return s;
  }
  return 'info';
}

export type NotificationVariant = 'ok' | 'err' | 'warn' | 'info';

export function notificationVariant(n: TaskNotification): NotificationVariant {
  const status = notificationStatus(n);
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'timed_out' || status === 'lost') return 'err';
  if (status === 'killed') return 'warn';
  // Unknown type: fall back to the declared severity for colouring.
  if (n.severity === 'error') return 'err';
  if (n.severity === 'warning') return 'warn';
  return 'info';
}
