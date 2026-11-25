import { SESSION_LINK_PREFIX } from '@moonshot-ai/app-core/lib';
import { decodeURIComponentOrRaw, encodeWireComponent, escapeLinkDest, escapeLinkText } from './linkCodec';
import { splitGraphemes, truncateGraphemes } from './graphemes';

export { unescapeLinkText, unescapeRenderedLinkText, unescapeLinkDest } from './linkCodec';

export type AttachmentKind = 'file' | 'folder' | 'image' | 'video';
export type MentionKind = 'file' | 'folder' | 'skill' | 'session';

export interface MentionAttrs {
  kind: MentionKind;
  name: string;
  path: string;
  rawDest?: string;
}

export const SKILL_LINK_BASE = 'kimi-code://skill/';

const LEGACY_SESSION_LINK_BASE = 'kimi-code://session/';

export function mayContainSessionLink(text: string): boolean {
  return text.includes(SESSION_LINK_PREFIX) || text.includes(LEGACY_SESSION_LINK_BASE);
}

function legacySessionId(segments: readonly string[]): string | null {
  return segments.length === 2 && segments.every((segment) => segment !== '' && !segment.includes('/')) ? segments[1]! : null;
}

function decodeLegacySessionMention(dest: string): string | null {
  return legacySessionId(dest.slice(LEGACY_SESSION_LINK_BASE.length).split('/').map(decodeURIComponentOrRaw));
}

export function sessionIdFromMentionPath(path: string): string {
  return legacySessionId(path.split('/')) ?? path;
}

export function decodeSessionMention(dest: string): string | null {
  if (dest.startsWith(LEGACY_SESSION_LINK_BASE)) return decodeLegacySessionMention(dest);
  if (!dest.startsWith(SESSION_LINK_PREFIX)) return null;
  const tail = dest.slice(SESSION_LINK_PREFIX.length);
  if (tail === '' || /[/?#]/.test(tail)) return null;
  const sessionId = decodeURIComponentOrRaw(tail);
  return sessionId === '' || sessionId.includes('/') ? null : sessionId;
}

export function classifyMentionHref(href: string): MentionKind | null {
  if (!href) return null;
  if (href.startsWith(SKILL_LINK_BASE) && href.length > SKILL_LINK_BASE.length) return 'skill';
  if (decodeSessionMention(href) !== null) return 'session';
  if (href.startsWith('#')) return null;
  if (href.startsWith('?')) return null;
  if (href.startsWith('//')) return null;
  const hasUriScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
  const isWindowsDrive = /^[a-zA-Z]:(?:[\\/]|%5c)/i.test(href);
  const isBareFileLine = /^[^/\\:]+\.[a-z0-9]+:\d+$/i.test(href) || /^(?:Makefile|LICENSE|README|Dockerfile|Jenkinsfile|Vagrantfile|Gemfile|Rakefile|Procfile|BUILD|WORKSPACE):\d+$/.test(href);
  if (hasUriScheme && !isWindowsDrive && !isBareFileLine) return null;
  return href.endsWith('/') || href.endsWith('\\') || /%5c$/i.test(href) ? 'folder' : 'file';
}

export function mentionActionPath(path: string): string {
  const cut = path.search(/[#?]/);
  return (cut > 0 ? path.slice(0, cut) : path).replace(/:\d+$/, '');
}

export function mentionActionLine(path: string): number | undefined {
  const cut = path.search(/[#?]/);
  const actionPath = cut > 0 ? path.slice(0, cut) : path;
  const colonLine = /:(\d+)$/.exec(actionPath)?.[1];
  const hashLine = cut > 0 && !/\.html?$/i.test(actionPath) ? /^#L?(\d+)$/i.exec(path.slice(cut))?.[1] : undefined;
  const lineRaw = colonLine ?? hashLine;
  if (lineRaw === undefined) return undefined;
  const line = Number(lineRaw);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

export function mentionActionSuffix(path: string): string {
  const cut = path.search(/[#?]/);
  return cut > 0 ? path.slice(cut) : '';
}

export function decodeSkillMention(dest: string): Pick<MentionAttrs, 'name' | 'path'> {
  const tail = dest.slice(SKILL_LINK_BASE.length);
  const queryAt = tail.indexOf('?');
  const name = decodeURIComponentOrRaw(queryAt === -1 ? tail : tail.slice(0, queryAt));
  const params = new URLSearchParams(queryAt === -1 ? '' : tail.slice(queryAt + 1));
  return {
    name,
    path: params.get('path') ?? '',
  };
}

export function decodeSkillName(dest: string): string {
  return decodeSkillMention(dest).name;
}

export function serializeMention(attrs: MentionAttrs): string {
  const text = escapeLinkText(attrs.name);
  if (attrs.kind === 'skill') {
    const query: string[] = [];
    if (attrs.path) query.push(`path=${encodeWireComponent(attrs.path)}`);
    const suffix = query.length === 0 ? '' : `?${query.join('&')}`;
    return `[${text}](${SKILL_LINK_BASE}${encodeWireComponent(attrs.name)}${suffix})`;
  }
  if (attrs.kind === 'session') {
    return `[${text}](${SESSION_LINK_PREFIX}${encodeWireComponent(attrs.path)})`;
  }
  if (attrs.rawDest !== undefined) return `[${text}](${/\s/.test(attrs.rawDest) ? `<${attrs.rawDest}>` : attrs.rawDest})`;
  const path = attrs.kind === 'folder' && !attrs.path.endsWith('/') && !attrs.path.endsWith('\\') ? `${attrs.path}/` : attrs.path;
  return `[${text}](${escapeLinkDest(path)})`;
}

export const COMPOSER_LINK_SCHEME = 'kimi-code-composer://';

export const ATTACHMENT_LINK_BASE = `${COMPOSER_LINK_SCHEME}attachments/`;

export const BROWSER_REFERENCE_LINK_BASE = `${COMPOSER_LINK_SCHEME}browser-references/`;

export interface BrowserReferenceAttrs {
  refId: string;
  label: string;
}

export function serializeBrowserReference(attrs: BrowserReferenceAttrs): string {
  return `[${escapeLinkText(attrs.label)}](${BROWSER_REFERENCE_LINK_BASE}${encodeWireComponent(attrs.refId)})`;
}

export interface AttachmentAttrs {
  attId: string;
  name: string;
  kind: AttachmentKind;
  comment?: string;
}

export function serializeAttachment(attrs: AttachmentAttrs): string {
  const text = `[${escapeLinkText(attrs.name)}](${ATTACHMENT_LINK_BASE}${attrs.attId})`;
  return attrs.comment ? serializeQuote({ text, comment: attrs.comment }) : text;
}

export const QUOTE_LINK_BASE = `${COMPOSER_LINK_SCHEME}quote/`;

export interface QuoteAttrs {
  text: string;
  comment?: string;
  source?: string;
}

export const QUOTE_LABEL_MAX = 12;

export function quotePillLabel(text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  const label = truncateGraphemes(firstLine, QUOTE_LABEL_MAX);
  return label.length > 0 ? label : '…';
}

export function serializeQuote(attrs: QuoteAttrs): string {
  const source = attrs.source !== undefined && attrs.source.length > 0 ? `?source=${encodeWireComponent(attrs.source)}` : '';
  const comment = attrs.comment !== undefined && attrs.comment.length > 0 ? `?comment=${encodeWireComponent(attrs.comment)}` : '';
  return `[${escapeLinkText(quotePillLabel(attrs.text))}](${QUOTE_LINK_BASE}${encodeWireComponent(attrs.text)}${source}${comment})`;
}

export function decodeQuoteAttrs(encoded: string): QuoteAttrs {
  const sourceAt = encoded.indexOf('?source=');
  const commentAt = encoded.indexOf('?comment=');
  const firstParam = [sourceAt, commentAt].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
  const attrs: QuoteAttrs = { text: decodeURIComponentOrRaw(firstParam === -1 ? encoded : encoded.slice(0, firstParam)) };
  if (sourceAt >= 0) {
    const end = commentAt > sourceAt ? commentAt : encoded.length;
    attrs.source = decodeURIComponentOrRaw(encoded.slice(sourceAt + '?source='.length, end));
  }
  if (commentAt >= 0) {
    const end = sourceAt > commentAt ? sourceAt : encoded.length;
    attrs.comment = decodeURIComponentOrRaw(encoded.slice(commentAt + '?comment='.length, end));
  }
  return attrs;
}

export const PASTED_TEXT_LINK_BASE = `${COMPOSER_LINK_SCHEME}pasted-text/`;

export interface PastedTextAttrs {
  text: string;
}

export const PASTED_TEXT_MIN_CHARS = 2_000;
export const PASTED_TEXT_MIN_LINES = 40;
export const PASTED_TEXT_LABEL_MAX = 24;

export function pastedTextLineCount(text: string): number {
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines += 1;
  return lines;
}

export function isLongPastedText(text: string): boolean {
  if (text.length >= PASTED_TEXT_MIN_CHARS) return true;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    lines += 1;
    if (lines >= PASTED_TEXT_MIN_LINES) return true;
  }
  return false;
}

const PASTED_TEXT_LABEL_SCAN = PASTED_TEXT_LABEL_MAX * 8;

export function pastedTextPillLabel(text: string): string {
  const start = text.search(/\S/);
  if (start === -1) return '…';
  const lineEnd = text.indexOf('\n', start);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const scanEnd = Math.min(end, start + PASTED_TEXT_LABEL_SCAN);
  const head = text.slice(start, scanEnd).trimEnd();
  const chars = splitGraphemes(head);
  if (chars.length <= PASTED_TEXT_LABEL_MAX && scanEnd === end) return head;
  return `${chars.slice(0, PASTED_TEXT_LABEL_MAX - 1).join('')}…`;
}

export function pastedTextCharCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0xdc00 || code > 0xdfff) count += 1;
  }
  return count;
}

const PASTED_TEXT_WIRE_CACHE_MAX = 8;
const pastedTextWireCache = new Map<string, string>();

export function serializePastedText(attrs: PastedTextAttrs): string {
  const cached = pastedTextWireCache.get(attrs.text);
  if (cached !== undefined) return cached;
  const wire = `[${escapeLinkText(pastedTextPillLabel(attrs.text))}](${PASTED_TEXT_LINK_BASE}${encodeWireComponent(attrs.text)})`;
  pastedTextWireCache.set(attrs.text, wire);
  while (pastedTextWireCache.size > PASTED_TEXT_WIRE_CACHE_MAX) {
    const oldest = pastedTextWireCache.keys().next().value;
    if (oldest === undefined) break;
    pastedTextWireCache.delete(oldest);
  }
  return wire;
}
