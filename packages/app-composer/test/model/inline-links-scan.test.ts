import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LINK_BASE,
  BROWSER_REFERENCE_LINK_BASE,
  COMPOSER_LINK_SCHEME,
  QUOTE_LINK_BASE,
  attachmentLinkRemovals,
  docText,
  mayStartWithSlashCommand,
  normalizedDocText,
  parseAttachmentLinks,
  parseBrowserReferenceLinks,
  parseMentionLinks,
  parseQuoteLinks,
  serializeAttachment,
  serializeMention,
  serializeQuote,
  splitInlineSegments,
  submitNormalizedText,
  textToDoc,
} from '../../src/model';

const attachment = serializeAttachment({ attId: 'a1', name: 'spec.pdf', kind: 'file' });
const mention = serializeMention({ kind: 'file', name: 'index.ts', path: 'src/index.ts' });
const quote = serializeQuote({ text: 'quoted words', comment: 'why' });
const browserRef = `[page](${BROWSER_REFERENCE_LINK_BASE}ref_0123456789abcdef)`;

const prose = Array.from({ length: 2000 }, (_, i) => `${i}: plain prose without any link syntax, just words.`).join('\n');

describe('inline link scanning guards', () => {
  it('shares one scheme prefix across composer link bases', () => {
    for (const base of [ATTACHMENT_LINK_BASE, QUOTE_LINK_BASE, BROWSER_REFERENCE_LINK_BASE]) {
      expect(base.startsWith(COMPOSER_LINK_SCHEME)).toBe(true);
    }
  });

  it('finds nothing in text without link syntax', () => {
    expect(parseMentionLinks(prose)).toEqual([]);
    expect(parseAttachmentLinks(prose)).toEqual([]);
    expect(parseQuoteLinks(prose)).toEqual([]);
    expect(parseBrowserReferenceLinks(prose)).toEqual([]);
    expect(attachmentLinkRemovals(prose)).toEqual([]);
    expect(splitInlineSegments(prose)).toEqual([{ type: 'text', value: prose }]);
  });

  it('ignores ordinary markdown links for composer-specific scanners', () => {
    const text = 'see [docs](https://example.com/docs) and [x](https://example.com/x)';
    expect(parseAttachmentLinks(text)).toEqual([]);
    expect(parseQuoteLinks(text)).toEqual([]);
    expect(parseBrowserReferenceLinks(text)).toEqual([]);
    expect(attachmentLinkRemovals(text)).toEqual([]);
    expect(submitNormalizedText(text).text).toBe(text);
  });

  it('finds links on the lines that carry them inside a large multi-line text', () => {
    const lines = prose.split('\n');
    lines.splice(500, 0, `first ${attachment} then ${mention}`);
    lines.splice(1200, 0, `${quote} and ${browserRef}`);
    const text = lines.join('\n');
    const offset = (needle: string) => text.indexOf(needle);

    expect(parseAttachmentLinks(text)).toEqual([
      expect.objectContaining({ start: offset(attachment), end: offset(attachment) + attachment.length, attrs: expect.objectContaining({ attId: 'a1', name: 'spec.pdf' }) }),
    ]);
    expect(parseMentionLinks(text)).toEqual([
      expect.objectContaining({ start: offset(mention), end: offset(mention) + mention.length, attrs: { kind: 'file', name: 'index.ts', path: 'src/index.ts' } }),
    ]);
    expect(parseQuoteLinks(text)).toEqual([
      expect.objectContaining({ start: offset(quote), end: offset(quote) + quote.length, attrs: { text: 'quoted words', comment: 'why' } }),
    ]);
    expect(parseBrowserReferenceLinks(text)).toEqual([
      expect.objectContaining({ start: offset(browserRef), end: offset(browserRef) + browserRef.length, attrs: { refId: 'ref_0123456789abcdef', label: 'page' } }),
    ]);
  });

  it('keeps splitInlineSegments faithful line by line', () => {
    const text = `plain line\n${attachment} tail\nanother plain line\n${mention}`;
    const segments = splitInlineSegments(text);
    expect(segments).toEqual([
      { type: 'text', value: 'plain line\n' },
      { type: 'attachment', attrs: { attId: 'a1', name: 'spec.pdf', kind: 'file' }, rawDest: `${ATTACHMENT_LINK_BASE}a1` },
      { type: 'text', value: ' tail\nanother plain line\n' },
      { type: 'mention', attrs: { kind: 'file', name: 'index.ts', path: 'src/index.ts' }, rawDest: 'src/index.ts' },
    ]);
  });

  it('roundtrips skill variant paths and workspace labels', () => {
    const wire = serializeMention({
      kind: 'skill',
      name: 'review',
      path: '/work/B/.agents/skills/review/SKILL.md',
    });
    expect(parseMentionLinks(wire)[0]?.attrs).toEqual({
      kind: 'skill',
      name: 'review',
      path: '/work/B/.agents/skills/review/SKILL.md',
    });
  });

  it('still strips attachment links wrapped in a quote with a comment', () => {
    const annotated = serializeAttachment({ attId: 'shot', name: 'shot.png', kind: 'image', comment: 'look here' });
    const removals = attachmentLinkRemovals(`before ${annotated} after`);
    expect(removals).toEqual([{ start: 7, end: 7 + annotated.length, text: 'shot.png\nlook here' }]);
  });
});

describe('mayStartWithSlashCommand', () => {
  it('accepts text that can only start with a command after normalization', () => {
    expect(mayStartWithSlashCommand('/plan')).toBe(true);
    expect(mayStartWithSlashCommand('  \n/new')).toBe(true);
    expect(mayStartWithSlashCommand(`${attachment} /plan`)).toBe(true);
  });

  it('rejects text whose normalized form cannot start with a slash', () => {
    expect(mayStartWithSlashCommand('hello /plan')).toBe(false);
    expect(mayStartWithSlashCommand(`${mention} /plan`)).toBe(false);
    expect(mayStartWithSlashCommand(prose)).toBe(false);
    expect(mayStartWithSlashCommand('')).toBe(false);
  });
});

describe('document text memoization', () => {
  it('reuses the serialized and normalized text for the same document', () => {
    const doc = textToDoc(`${attachment} /plan check`, { reviveMentions: true });
    expect(docText(doc)).toBe(docText(doc));
    expect(normalizedDocText(doc)).toBe(normalizedDocText(doc));
    expect(normalizedDocText(doc).text).toBe(' /plan check');
    expect(docText(doc)).toBe(`${attachment} /plan check`);
  });

  it('serializes each document independently', () => {
    const first = textToDoc('first', { reviveMentions: true });
    const second = textToDoc('second', { reviveMentions: true });
    expect(docText(first)).toBe('first');
    expect(docText(second)).toBe('second');
    expect(normalizedDocText(first)).not.toBe(normalizedDocText(second));
  });
});
