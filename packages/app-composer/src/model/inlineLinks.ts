import { parse, postprocess, preprocess } from 'micromark';
import { decodeURIComponentOrRaw, unescapeLinkDest, unescapeLinkText } from './linkCodec';
import { ATTACHMENT_LINK_BASE, COMPOSER_LINK_SCHEME, QUOTE_LINK_BASE, SESSION_LINK_BASE, classifyMentionHref, decodeQuoteAttrs, decodeSessionMention, decodeSkillMention, serializeAttachment, serializeMention, type AttachmentAttrs, type AttachmentKind, type MentionAttrs, type QuoteAttrs } from './wireCodec';
import { BROWSER_REFERENCE_LINK_BASE, PASTED_TEXT_LINK_BASE, type BrowserReferenceAttrs, type PastedTextAttrs } from './wireCodec';
import { isBrowserReferenceId } from '@moonshot-ai/app-core/browser-reference';
import { replaceWithSourceMap, trimSpans, type SourceMappedText, type TextReplacement } from '@moonshot-ai/app-core/lib';
const mentionLinkMicromarkOptions = {
  extensions: [
    {
      disable: {
        null: [
          'attention',
          'autolink',
          'blockQuote',
          'characterReference',
          'codeFenced',
          'codeIndented',
          'codeText',
          'definition',
          'hardBreakEscape',
          'headingAtx',
          'htmlFlow',
          'htmlText',
          'list',
          'setextUnderline',
          'thematicBreak',
        ],
      },
    },
  ],
};

export interface MentionLinkMatch {
  start: number;
  end: number;
  attrs: MentionAttrs;
  rawDest: string;
}

export interface AttachmentLinkMatch {
  start: number;
  end: number;
  attrs: AttachmentAttrs;
  rawDest: string;
}

export interface QuoteLinkMatch {
  start: number;
  end: number;
  attrs: QuoteAttrs;
  rawDest: string;
}

interface LinkCandidate {
  start: number;
  end: number;
  rawText: string;
  rawDest: string;
  angle: boolean;
  image: boolean;
}

const INLINE_LINK_MARK = '](';

type LinkParser = ReturnType<typeof parse>;

function walkLinkCandidates(text: string): LinkCandidate[] {
  if (!text.includes(INLINE_LINK_MARK)) return [];
  const parser = parse(mentionLinkMicromarkOptions);
  if (!text.includes('\n')) return walkLineCandidates(parser, text);
  const candidates: LinkCandidate[] = [];
  let lineOffset = 0;
  for (const line of text.split('\n')) {
    if (line.includes(INLINE_LINK_MARK)) {
      for (const candidate of walkLineCandidates(parser, line)) {
        candidates.push({ ...candidate, start: candidate.start + lineOffset, end: candidate.end + lineOffset });
      }
    }
    lineOffset += line.length + 1;
  }
  return candidates;
}

function walkLineCandidates(parser: LinkParser, text: string): LinkCandidate[] {
  const events = postprocess(parser.document().write(preprocess()(text, undefined, true)));
  const candidates: LinkCandidate[] = [];
  let label: { start: number; end: number } | null = null;
  let inResource = false;
  let hasTitle = false;
  let destSpan: { start: number; end: number } | null = null;
  let imageDepth = 0;
  for (const [event, token] of events) {
    if (token.type === 'image') {
      imageDepth += event === 'enter' ? 1 : -1;
      continue;
    }
    if (event === 'enter') {
      if (token.type === 'label') {
        label = { start: token.start.offset, end: token.end.offset };
      } else if (token.type === 'resource' && label !== null && token.start.offset === label.end) {
        inResource = true;
        hasTitle = false;
        destSpan = null;
      } else if (token.type === 'resourceTitle' && inResource) {
        hasTitle = true;
      } else if (token.type === 'resourceDestination' && inResource) {
        destSpan = { start: token.start.offset, end: token.end.offset };
      }
      continue;
    }
    if (token.type !== 'resource' || !inResource || label === null) continue;
    inResource = false;
    const { start, end: labelEnd } = label;
    label = null;
    const end = token.end.offset;
    const image = imageDepth > 0;
    if (hasTitle || text[start] !== (image ? '!' : '[') || destSpan === null) continue;
    const rawText = text.slice(start + (image ? 2 : 1), labelEnd - 1);
    let rawDest = text.slice(destSpan.start, destSpan.end);
    let angle = false;
    if (rawDest.startsWith('<')) {
      angle = true;
      rawDest = rawDest.slice(1, -1);
    }
    if (!rawText || !rawDest) continue;
    candidates.push({ start, end, rawText, rawDest, angle, image });
  }
  return candidates;
}

type InlineLinkMatch =
  | { type: 'browser-reference'; start: number; end: number; attrs: BrowserReferenceAttrs; rawDest: string }
  | { type: 'mention'; start: number; end: number; attrs: MentionAttrs; rawDest: string }
  | { type: 'attachment'; start: number; end: number; attrs: AttachmentAttrs; rawDest: string }
  | { type: 'quote'; start: number; end: number; attrs: QuoteAttrs; rawDest: string }
  | { type: 'pasted-text'; start: number; end: number; attrs: PastedTextAttrs; rawDest: string };

export type AttachmentKindSource = (attId: string) => AttachmentKind | undefined;

function classifyLinkCandidate(candidate: LinkCandidate, attachmentKindFor?: AttachmentKindSource): InlineLinkMatch | null {
  const { start, end, rawText, rawDest, angle, image } = candidate;
  if (image && !rawDest.startsWith(QUOTE_LINK_BASE) && !rawDest.startsWith(PASTED_TEXT_LINK_BASE)) return null;
  if (rawDest.startsWith(BROWSER_REFERENCE_LINK_BASE)) {
    const refId = rawDest.slice(BROWSER_REFERENCE_LINK_BASE.length);
    if (!isBrowserReferenceId(refId)) return null;
    return { type: 'browser-reference', start, end, attrs: { refId, label: unescapeLinkText(rawText) }, rawDest };
  }
  if (rawDest.startsWith(ATTACHMENT_LINK_BASE) && rawDest.length > ATTACHMENT_LINK_BASE.length) {
    const name = unescapeLinkText(rawText);
    const attId = rawDest.slice(ATTACHMENT_LINK_BASE.length);
    return {
      type: 'attachment',
      start,
      end,
      attrs: { attId, name, kind: attachmentKindFor?.(attId) ?? (name.endsWith('/') ? 'folder' : 'file') },
      rawDest,
    };
  }
  if (rawDest.startsWith(PASTED_TEXT_LINK_BASE) && rawDest.length > PASTED_TEXT_LINK_BASE.length) {
    return {
      type: 'pasted-text',
      start: image ? start + 1 : start,
      end,
      attrs: { text: decodeURIComponentOrRaw(rawDest.slice(PASTED_TEXT_LINK_BASE.length)) },
      rawDest,
    };
  }
  if (rawDest.startsWith(QUOTE_LINK_BASE) && rawDest.length > QUOTE_LINK_BASE.length) {
    return {
      type: 'quote',
      start,
      end,
      attrs: decodeQuoteAttrs(rawDest.slice(QUOTE_LINK_BASE.length)),
      rawDest,
    };
  }
  const kind = classifyMentionHref(rawDest);
  if (kind === null) return null;
  if (kind === 'skill') {
    return { type: 'mention', start, end, attrs: { kind, ...decodeSkillMention(rawDest) }, rawDest };
  }
  if (kind === 'session') {
    return { type: 'mention', start, end, attrs: { kind, name: unescapeLinkText(rawText), path: decodeSessionMention(rawDest)! }, rawDest };
  }
  return {
    type: 'mention',
    start,
    end,
    attrs: { kind, name: unescapeLinkText(rawText), path: unescapeLinkDest(rawDest, angle) },
    rawDest,
  };
}

function scanEscapedBlockLinks(text: string): InlineLinkMatch[] {
  const matches: InlineLinkMatch[] = [];
  if (!text.includes(QUOTE_LINK_BASE) && !text.includes(PASTED_TEXT_LINK_BASE)) return matches;
  const closes = new Int32Array(text.length + 1).fill(-1);
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === ']') closes[i] = i;
    else if (ch === '\\') {
      if (i + 1 < text.length && !/[\n\r\u2028\u2029]/.test(text[i + 1]!)) {
        closes[i] = closes[i + 2]!;
      }
    } else if (ch !== '[' && ch !== '\n') closes[i] = closes[i + 1]!;
  }
  let backslashes = 0;
  let destinationEnd = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      backslashes += 1;
      continue;
    }
    const escaped = backslashes % 2 === 1;
    backslashes = 0;
    if (text[i] !== '[') continue;
    const close = closes[i + 1]!;
    if (close === -1) continue;
    const base = text.startsWith(`](${QUOTE_LINK_BASE}`, close) ? QUOTE_LINK_BASE : text.startsWith(`](${PASTED_TEXT_LINK_BASE}`, close) ? PASTED_TEXT_LINK_BASE : null;
    if (base === null) continue;
    const start = close + 2;
    const payloadStart = start + base.length;
    if (destinationEnd < payloadStart) {
      destinationEnd = payloadStart;
      while (destinationEnd < text.length && !/[\s)]/.test(text[destinationEnd]!)) destinationEnd += 1;
    }
    if (destinationEnd === payloadStart || text[destinationEnd] !== ')') continue;
    if (escaped && base === PASTED_TEXT_LINK_BASE) {
      const rawDest = text.slice(start, destinationEnd);
      matches.push({ type: 'pasted-text', start: i, end: destinationEnd + 1, attrs: { text: decodeURIComponentOrRaw(rawDest.slice(base.length)) }, rawDest });
    } else if (escaped) {
      const rawDest = text.slice(start, destinationEnd);
      matches.push({
        type: 'quote',
        start: i - 1,
        end: destinationEnd + 1,
        attrs: decodeQuoteAttrs(rawDest.slice(QUOTE_LINK_BASE.length)),
        rawDest,
      });
    }
    i = destinationEnd;
  }
  return matches;
}

function collectInlineLinkMatches(text: string, attachmentKindFor?: AttachmentKindSource): InlineLinkMatch[] {
  const matches: InlineLinkMatch[] = [];
  for (const candidate of walkLinkCandidates(text)) {
    const match = classifyLinkCandidate(candidate, attachmentKindFor);
    if (match) matches.push(match);
  }
  matches.push(...scanEscapedBlockLinks(text));
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

const BARE_SESSION_LINK = /(?<!\w)kimi-code:\/\/sessions\/([A-Za-z0-9_-]+)(?![\w/%?#-])/g;

export function linkBareSessionUrls(text: string, sessionTitle: (sessionId: string) => string): string {
  if (!text.includes(SESSION_LINK_BASE)) return text;
  const links = walkLinkCandidates(text);
  return text.replace(BARE_SESSION_LINK, (url: string, sessionId: string, offset: number) =>
    links.some((link) => offset < link.end && offset + url.length > link.start)
      ? url
      : serializeMention({ kind: 'session', name: sessionTitle(sessionId), path: sessionId }));
}

export function parseMentionLinks(text: string): MentionLinkMatch[] {
  return collectInlineLinkMatches(text)
    .filter((match): match is Extract<InlineLinkMatch, { type: 'mention' }> => match.type === 'mention')
    .map(({ start, end, attrs, rawDest }) => ({ start, end, attrs, rawDest }));
}

export function parseAttachmentLinks(text: string): AttachmentLinkMatch[] {
  if (!text.includes(COMPOSER_LINK_SCHEME)) return [];
  return collectInlineLinkMatches(text)
    .map((match) => attachmentQuoteMatch(match) ?? match)
    .filter((match): match is Extract<InlineLinkMatch, { type: 'attachment' }> => match.type === 'attachment')
    .map(({ start, end, attrs, rawDest }) => ({ start, end, attrs, rawDest }));
}

function attachmentQuoteMatch(match: InlineLinkMatch, attachmentKindFor?: AttachmentKindSource): Extract<InlineLinkMatch, { type: 'attachment' }> | null {
  if (match.type !== 'quote' || match.attrs.source || !match.attrs.text.includes(ATTACHMENT_LINK_BASE)) return null;
  const candidates = walkLinkCandidates(match.attrs.text);
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate || candidate.start !== 0 || candidate.end !== match.attrs.text.length) return null;
  const attachment = classifyLinkCandidate(candidate, attachmentKindFor);
  if (attachment?.type !== 'attachment') return null;
  return {
    ...attachment,
    start: match.start,
    end: match.end,
    attrs: { ...attachment.attrs, ...(match.attrs.comment ? { comment: match.attrs.comment } : {}) },
  };
}

export function parseQuoteLinks(text: string): QuoteLinkMatch[] {
  if (!text.includes(QUOTE_LINK_BASE)) return [];
  return collectInlineLinkMatches(text)
    .filter((match): match is Extract<InlineLinkMatch, { type: 'quote' }> => match.type === 'quote')
    .map(({ start, end, attrs, rawDest }) => ({ start, end, attrs, rawDest }));
}

export interface PastedTextLinkMatch {
  start: number;
  end: number;
  attrs: PastedTextAttrs;
}

export function parsePastedTextLinks(text: string): PastedTextLinkMatch[] {
  if (!text.includes(PASTED_TEXT_LINK_BASE)) return [];
  return collectInlineLinkMatches(text).flatMap((match) => match.type === 'pasted-text' ? [{ start: match.start, end: match.end, attrs: match.attrs }] : []);
}

export function expandPastedTextLinks(text: string): string {
  const matches = parsePastedTextLinks(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start) + match.attrs.text;
    cursor = match.end;
  }
  return out + text.slice(cursor);
}

export type MentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; attrs: MentionAttrs; rawDest: string };

export function splitMentionSegments(text: string): MentionSegment[] {
  const matches = parseMentionLinks(text);
  if (matches.length === 0) return [{ type: 'text', value: text }];
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ type: 'text', value: text.slice(cursor, match.start) });
    segments.push({ type: 'mention', attrs: match.attrs, rawDest: match.rawDest });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}

export type InlineSegment =
  | { type: 'browser-reference'; attrs: BrowserReferenceAttrs; rawDest: string }
  | { type: 'text'; value: string }
  | { type: 'mention'; attrs: MentionAttrs; rawDest: string }
  | { type: 'attachment'; attrs: AttachmentAttrs; rawDest: string }
  | { type: 'quote'; attrs: QuoteAttrs; rawDest: string }
  | { type: 'pasted-text'; attrs: PastedTextAttrs; rawDest: string };

export function parseBrowserReferenceLinks(text: string): Array<{ start: number; end: number; attrs: BrowserReferenceAttrs }> {
  if (!text.includes(BROWSER_REFERENCE_LINK_BASE)) return [];
  return collectInlineLinkMatches(text).flatMap((match) => match.type === 'browser-reference' ? [{ start: match.start, end: match.end, attrs: match.attrs }] : []);
}

export function splitInlineSegments(text: string, attachmentKindFor?: AttachmentKindSource): InlineSegment[] {
  const matches = collectInlineLinkMatches(text, attachmentKindFor);
  if (matches.length === 0) return [{ type: 'text', value: text }];
  const segments: InlineSegment[] = [];
  let cursor = 0;
  for (const original of matches) {
    const match = attachmentQuoteMatch(original, attachmentKindFor) ?? original;
    if (match.start > cursor) segments.push({ type: 'text', value: text.slice(cursor, match.start) });
    if (match.type === 'mention') segments.push({ type: 'mention', attrs: match.attrs, rawDest: match.rawDest });
    else if (match.type === 'browser-reference') segments.push({ type: 'browser-reference', attrs: match.attrs, rawDest: match.rawDest });
    else if (match.type === 'attachment') segments.push({ type: 'attachment', attrs: match.attrs, rawDest: match.rawDest });
    else if (match.type === 'pasted-text') segments.push({ type: 'pasted-text', attrs: match.attrs, rawDest: match.rawDest });
    else segments.push({ type: 'quote', attrs: match.attrs, rawDest: match.rawDest });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}

export interface RewriteAttachmentLinksOptions {
  resolveFolder?: (attId: string) => string | undefined;
  resolveMediaName?: (attId: string, ordinal: number) => string | undefined;
}

export function rewriteAttachmentLinksForSubmit(
  text: string,
  indexes: { fileAttIds: readonly string[]; mediaAttIds: readonly string[] },
  opts?: RewriteAttachmentLinksOptions,
): string {
  const matches = parseAttachmentLinks(text);
  if (matches.length === 0) return text;
  const fileIndexByAttId = new Map(indexes.fileAttIds.map((attId, index) => [attId, index + 1] as const));
  const mediaIndexByAttId = new Map(indexes.mediaAttIds.map((attId, index) => [attId, index + 1] as const));
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    cursor = match.end;
    const { attId, name, kind } = match.attrs;
    const folderPath = kind === 'folder' ? opts?.resolveFolder?.(attId) : undefined;
    if (folderPath !== undefined) {
      const isRootPath = folderPath === '/' || /^[a-zA-Z]:\/$/.test(folderPath);
      const label = isRootPath ? folderPath.slice(0, -1) || '/' : name.endsWith('/') ? name.slice(0, -1) : name;
      out += serializeMention({ kind: 'folder', name: label, path: folderPath });
      continue;
    }
    const fileIndex = fileIndexByAttId.get(attId);
    if (fileIndex !== undefined) {
      out += serializeAttachment({ ...match.attrs, attId: String(fileIndex) });
      continue;
    }
    const mediaIndex = mediaIndexByAttId.get(attId);
    if (mediaIndex !== undefined) {
      const mediaName = opts?.resolveMediaName?.(attId, mediaIndex) ?? name;
      out += serializeAttachment({ ...match.attrs, attId: `m${mediaIndex}`, name: mediaName });
      continue;
    }
    out += name + (match.attrs.comment ? `\n${match.attrs.comment}` : '');
  }
  out += text.slice(cursor);
  return out;
}

export function offsetAttachmentLinkIndices(text: string, fileOffset: number, mediaOffset = 0): string {
  if (fileOffset <= 0 && mediaOffset <= 0) return text;
  const matches = parseAttachmentLinks(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    const { attId, name } = match.attrs;
    let rewritten: string | undefined;
    let rewrittenName = name;
    if (fileOffset > 0 && /^[1-9]\d*$/.test(attId)) rewritten = String(Number(attId) + fileOffset);
    else if (mediaOffset > 0 && /^m[1-9]\d*$/.test(attId)) {
      const currentIndex = Number(attId.slice(1));
      const nextIndex = currentIndex + mediaOffset;
      rewritten = `m${nextIndex}`;
      const generatedSuffix = ` ${currentIndex}`;
      if (name.endsWith(generatedSuffix)) {
        rewrittenName = `${name.slice(0, -generatedSuffix.length)} ${nextIndex}`;
      }
    }
    if (rewritten === undefined) continue;
    out += text.slice(cursor, match.start);
    cursor = match.end;
    out += serializeAttachment({ ...match.attrs, attId: rewritten, name: rewrittenName });
  }
  out += text.slice(cursor);
  return out;
}

export function stripAttachmentLinks(text: string, escapeName?: (name: string) => string): string {
  const matches = parseAttachmentLinks(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    const label = match.attrs.name + (match.attrs.comment ? `\n${match.attrs.comment}` : '');
    out += text.slice(cursor, match.start) + (escapeName?.(label) ?? label);
    cursor = match.end;
  }
  out += text.slice(cursor);
  return out;
}

export function degradeForeignAttachmentLinks(text: string, knownAttIds: ReadonlySet<string>): string {
  const matches = parseAttachmentLinks(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    if (knownAttIds.has(match.attrs.attId)) continue;
    out += text.slice(cursor, match.start) + match.attrs.name + (match.attrs.comment ? `\n${match.attrs.comment}` : '');
    cursor = match.end;
  }
  out += text.slice(cursor);
  return out;
}

export function attachmentLinkRemovals(text: string): TextReplacement[] {
  if (!text.includes(COMPOSER_LINK_SCHEME)) return [];
  return parseAttachmentLinks(text).map((match) => ({
    start: match.start,
    end: match.end,
    text: match.attrs.comment ? `${match.attrs.name}\n${match.attrs.comment}` : '',
  }));
}

export function removeAttachmentLinks(text: string): string {
  const removals = attachmentLinkRemovals(text);
  return removals.length === 0 ? text : replaceWithSourceMap(text, removals).text;
}

export function submitNormalizedText(text: string): SourceMappedText {
  const spans = trimSpans(text);
  const from = spans[0]!.end;
  const removals = attachmentLinkRemovals(text.slice(from, spans[1]!.start));
  return replaceWithSourceMap(text, [
    ...spans,
    ...removals.map((span) => ({ start: span.start + from, end: span.end + from, text: span.text })),
  ]);
}
