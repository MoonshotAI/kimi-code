export interface TaskNotificationOutput {
  readonly file?: string;
  readonly preview?: string;
  readonly bytes?: number;
  readonly truncated?: boolean;
}

export interface TaskAnswer {
  readonly answers: Readonly<Record<string, string | true>>;
  readonly note?: string;
}

export interface TaskNotification {
  readonly id: string;
  readonly type: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly agentId?: string;
  readonly title: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly body: string;
  readonly output?: TaskNotificationOutput;
  readonly answer?: TaskAnswer;
}

interface XmlElement {
  readonly attributes: string;
  readonly content: string;
}

const TITLE_RE = /^Title: (.*)$/m;
const SEVERITY_RE = /^Severity: (.*)$/m;
const ATTRIBUTE_NAME_RE = /[\w-]/;

export function parseTaskNotifications(text: string): TaskNotification[] {
  if (!text.includes('<notification')) return [];
  return [...xmlElements(text, 'notification')].map(({ attributes, content }) => notificationOf(attributes, content));
}

export function plainTaskNotification(sourceKind: string, sourceId: string, body: string): TaskNotification {
  return { id: '', type: '', sourceKind, sourceId, title: '', severity: 'info', body };
}

function notificationOf(rawAttributes: string, content: string): TaskNotification {
  const attributes = xmlAttributes(rawAttributes);
  const severity = SEVERITY_RE.exec(content)?.[1]?.trim();
  const answerText = answerTextOf(content);
  const answer = answerText === undefined ? undefined : taskAnswerOf(answerText);
  return {
    id: attributes['id'] ?? '',
    type: attributes['type'] ?? '',
    sourceKind: attributes['source_kind'] ?? '',
    sourceId: attributes['source_id'] ?? '',
    agentId: attributes['agent_id'],
    title: unescapeXml(TITLE_RE.exec(content)?.[1]?.trim() ?? ''),
    severity: severity === 'warning' || severity === 'error' ? severity : 'info',
    body: unescapeXml(bodyOf(content)),
    output: answer !== undefined ? undefined : answerText !== undefined ? { preview: answerText, truncated: false } : outputOf(content),
    answer,
  };
}

function answerTextOf(content: string): string | undefined {
  const answer = xmlElements(content, 'answer').next().value;
  if (answer === undefined) return undefined;
  return answer.content.replace(/^\n/, '').replace(/\n$/, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function taskAnswerOf(text: string): TaskAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { answers, note } = value as { answers?: unknown; note?: unknown };
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return undefined;
  const entries = Object.entries(answers);
  if (!entries.every((entry): entry is [string, string | true] => typeof entry[1] === 'string' || entry[1] === true)) return undefined;
  return {
    answers: Object.fromEntries(entries),
    note: typeof note === 'string' && note.length > 0 ? note : undefined,
  };
}

function bodyOf(content: string): string {
  const body = content
    .split('\n')
    .filter((line) => !line.startsWith('Title: ') && !line.startsWith('Severity: '))
    .join('\n');
  const childAt = body.search(/^<\w/m);
  return (childAt === -1 ? body : body.slice(0, childAt)).trim();
}

function outputOf(content: string): TaskNotificationOutput | undefined {
  const file = xmlElements(content, 'output-file').next().value;
  const preview = xmlElements(content, 'output-preview').next().value;
  if (file === undefined && preview === undefined) return undefined;
  const fileAttributes = file === undefined ? {} : xmlAttributes(file.attributes);
  const previewAttributes = preview === undefined ? {} : xmlAttributes(preview.attributes);
  const truncated = previewAttributes['truncated'];
  return {
    file: nonEmpty(fileAttributes['path']),
    preview: preview === undefined ? undefined : previewText(preview.content),
    bytes: byteCount(fileAttributes['bytes']) ?? byteCount(previewAttributes['total_bytes']),
    truncated: truncated === 'true' ? true : truncated === 'false' ? false : undefined,
  };
}

function previewText(content: string): string {
  const text = content.replace(/^\n/, '');
  const newline = text.indexOf('\n');
  return unescapeXml(newline === -1 ? '' : text.slice(newline + 1)).replace(/\n$/, '');
}

function* xmlElements(text: string, tag: string): Generator<XmlElement, undefined> {
  const opening = `<${tag}`;
  const closing = `</${tag}>`;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(opening, cursor);
    if (start === -1) return;
    const attributesStart = start + opening.length;
    cursor = attributesStart;
    if (/\w/.test(text[attributesStart] ?? '')) continue;
    const contentStart = text.indexOf('>', attributesStart);
    if (contentStart === -1) return;
    const contentEnd = text.indexOf(closing, contentStart + 1);
    if (contentEnd === -1) return;
    cursor = contentEnd + closing.length;
    yield { attributes: text.slice(attributesStart, contentStart), content: text.slice(contentStart + 1, contentEnd) };
  }
}

function xmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < raw.length) {
    if (!ATTRIBUTE_NAME_RE.test(raw[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < raw.length && ATTRIBUTE_NAME_RE.test(raw[index]!)) index += 1;
    if (raw[index] !== '=' || raw[index + 1] !== '"') continue;
    const end = raw.indexOf('"', index + 2);
    if (end === -1) break;
    attributes[raw.slice(start, index)] = unescapeXml(raw.slice(index + 2, end));
    index = end + 1;
  }
  return attributes;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function byteCount(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
