import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import {
  buildQuoteInsertion,
  composerSchema,
  docToText,
  parseQuoteLinks,
  quotePillLabel,
  serializeQuote,
  textToDoc,
  type QuoteAttrs,
} from '../../../src/model';

const link = (text: string): string => serializeQuote({ text });

describe('quote link — serialize/parse round-trip', () => {
  it('round-trips plain, multi-line, non-ASCII, and metachar quotes', () => {
    const cases = [
      'hello',
      '多行\n引用\n文本',
      'a[b](c) 50% & <tag>',
      '稿件 “quoted” ✓',
      '/path/with/slashes',
      'trailing space inside ',
    ];
    for (const text of cases) {
      const matches = parseQuoteLinks(link(text));
      expect(matches).toHaveLength(1);
      expect(matches[0]!.attrs).toEqual({ text });
      expect(matches[0]!.start).toBe(0);
      expect(matches[0]!.end).toBe(link(text).length);
    }
  });

  it('round-trips the bundled comment and provenance (parameter pairs)', () => {
    const withComment: QuoteAttrs = { text: '引用?带问号', comment: '评论?也带问号' };
    expect(parseQuoteLinks(serializeQuote(withComment))[0]!.attrs).toEqual(withComment);
    const withSource: QuoteAttrs = { text: 'const x = 1;', source: 'src/a.ts:L42-L58' };
    expect(parseQuoteLinks(serializeQuote(withSource))[0]!.attrs).toEqual(withSource);
    const both: QuoteAttrs = { text: '引用', source: 'docs/指南.md', comment: '看这段' };
    expect(parseQuoteLinks(serializeQuote(both))[0]!.attrs).toEqual(both);
    expect(serializeQuote({ text: '引用' })).not.toContain('?comment=');
    expect(serializeQuote({ text: '引用' })).not.toContain('?source=');
    const tricky = parseQuoteLinks(serializeQuote({ text: 'a?comment=b', comment: 'c' }));
    expect(tricky[0]!.attrs).toEqual({ text: 'a?comment=b', comment: 'c' });
  });

  it('rejects an empty tail and the other link families', () => {
    expect(parseQuoteLinks('[x](kimi-code-composer://quote/)')).toEqual([]);
    expect(parseQuoteLinks('[a.ts](src/a.ts)')).toEqual([]);
    expect(parseQuoteLinks('[f](kimi-code-composer://attachments/abc12345)')).toEqual([]);
    expect(parseQuoteLinks('[deploy](kimi-code://skill/deploy)')).toEqual([]);
    expect(parseQuoteLinks('![x](src/a.ts)')).toEqual([]);
    expect(parseQuoteLinks('![x](kimi-code-composer://quote/)')).toEqual([]);
  });

  it('parses the image form (a `!` typed against the pill), `!` inside the span', () => {
    const wire = `!${link('引用')}`;
    const matches = parseQuoteLinks(wire);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.attrs).toEqual({ text: '引用' });
    expect(matches[0]!.start).toBe(0);
    expect(matches[0]!.end).toBe(wire.length);
  });

  it('parses the backslash-escaped form, the escaping `\\` inside the span', () => {
    const wire = `\\${link('引用')}`;
    const matches = parseQuoteLinks(wire);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.attrs).toEqual({ text: '引用' });
    expect(matches[0]!.start).toBe(0);
    expect(matches[0]!.end).toBe(wire.length);
  });

  it('an even backslash run stays a real link (the walk finds it; backslashes stay literal)', () => {
    const wire = `\\\\${link('引用')}`;
    const matches = parseQuoteLinks(wire);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(2);
    expect(matches[0]!.attrs).toEqual({ text: '引用' });
  });

  it('revives the image/escaped forms back into the pill through textToDoc', () => {
    for (const wire of [`!${link('引用')}`, `\\${link('引用')}`]) {
      expect(docToText(textToDoc(wire, { reviveMentions: true }))).toBe(link('引用'));
    }
  });

  it('revives through textToDoc and re-serializes byte-identically (draft persistence)', () => {
    const wire = `before\n\n${link('多行\n引用')}`;
    expect(docToText(textToDoc(wire, { reviveMentions: true }))).toBe(wire);
  });

  it('stays literal text without reviveMentions (paste of foreign text)', () => {
    const wire = link('引用');
    expect(docToText(textToDoc(wire))).toBe(wire);
  });
});

describe('quotePillLabel', () => {
  it('uses the first non-empty line, trimmed', () => {
    expect(quotePillLabel('\n  第一段 \n第二段')).toBe('第一段');
  });

  it('end-ellipsizes beyond the cap', () => {
    expect(quotePillLabel('x'.repeat(40))).toBe('x'.repeat(11) + '…');
  });

  it('never returns an empty label (the link form needs one to parse back)', () => {
    expect(quotePillLabel('   \n  ')).toBe('…');
  });
});

describe('buildQuoteInsertion', () => {
  function state(text: string, caret: 'start' | 'end' = 'end') {
    const doc = textToDoc(text);
    return EditorState.create({
      schema: composerSchema,
      doc,
      selection: caret === 'end' ? TextSelection.atEnd(doc) : TextSelection.atStart(doc),
    });
  }

  it('fills the placeholder paragraph of an empty doc (no leading blank line)', () => {
    const s = state('');
    const doc = s.apply(buildQuoteInsertion(s, { text: '引用' })).doc;
    expect(docToText(doc)).toBe(`${link('引用')} `);
  });

  it('inserts INLINE at the caret, space-separated from preceding text', () => {
    const s = state('hello');
    const doc = s.apply(buildQuoteInsertion(s, { text: '引用' })).doc;
    expect(docToText(doc)).toBe(`hello ${link('引用')} `);
  });

  it('accumulates: a second pill lands on the SAME line (no paragraph break)', () => {
    let s = state('');
    s = s.apply(buildQuoteInsertion(s, { text: 'q1' }));
    const doc = s.apply(buildQuoteInsertion(s, { text: 'q2' })).doc;
    expect(docToText(doc)).toBe(`${link('q1')} ${link('q2')} `);
  });

  it('inserts mid-line at the caret without disturbing surrounding text', () => {
    const doc = textToDoc('ab cd');
    const mid = 1 + 3;
    const s = EditorState.create({ schema: composerSchema, doc, selection: TextSelection.create(doc, mid) });
    expect(docToText(s.apply(buildQuoteInsertion(s, { text: '引用' })).doc)).toBe(`ab ${link('引用')} cd`);
  });

  it('never doubles an existing following space (caret before whitespace)', () => {
    const doc = textToDoc('a b');
    const s = EditorState.create({ schema: composerSchema, doc, selection: TextSelection.create(doc, 2) });
    expect(docToText(s.apply(buildQuoteInsertion(s, { text: '引用' })).doc)).toBe(`a ${link('引用')} b`);
  });

  it('collapses a stale non-collapsed selection instead of replacing its text', () => {
    const doc = textToDoc('hello world');
    const s = EditorState.create({ schema: composerSchema, doc, selection: TextSelection.create(doc, 1, 6) });
    expect(docToText(s.apply(buildQuoteInsertion(s, { text: '引用' })).doc)).toBe(`hello ${link('引用')} world`);
  });

  it('bundles the 评论 comment INTO the pill (its attrs), one undoable step', () => {
    const s = state('');
    const doc = s.apply(buildQuoteInsertion(s, { text: '引用' }, '评论')).doc;
    expect(docToText(doc)).toBe(`${serializeQuote({ text: '引用', comment: '评论' })} `);
    let quoteAttrs: QuoteAttrs | null = null;
    doc.descendants((node) => {
      if (node.type.name === 'quote') quoteAttrs = node.attrs as QuoteAttrs;
      return true;
    });
    expect(quoteAttrs).toEqual({ text: '引用', comment: '评论', source: '' });
  });

  it('places the caret right after the inserted pill + space', () => {
    const s = state('hello');
    const next = s.apply(buildQuoteInsertion(s, { text: '引用' }));
    expect(next.selection.to).toBe(next.doc.content.size - 1);
  });
});

describe('escaped quote scan performance', () => {
  it('handles many escaped brackets while still parsing a following quote', () => {
    const prefix = '\\['.repeat(40_000);
    const wire = prefix + '\n\\' + serializeQuote({ text: 'quote' });
    const started = performance.now();
    const matches = parseQuoteLinks(wire);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.attrs.text).toBe('quote');
    expect(matches[0]?.start).toBe(prefix.length + 1);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
