// packages/app-composer/test/quote-link.test.ts
// The quote pill's wire codec (selection quote actions — 划词): link-form
// serialize/parse round-trip, label derivation, doc revive, and the
// end-of-document insertion the transcript actions dispatch. DOM-free — the
// same node env as the attachment-link tests.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import {
  buildQuoteInsertion,
  composerSchema,
  docToText,
  parseQuoteLinks,
  quotePillLabel,
  serializeQuote,
  textToDoc,
} from '../src/composerTextDoc';

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

  it('rejects an empty tail and the other link families', () => {
    expect(parseQuoteLinks('[x](kimi-code-composer://quote/)')).toEqual([]);
    expect(parseQuoteLinks('[a.ts](src/a.ts)')).toEqual([]);
    expect(parseQuoteLinks('[f](kimi-code-composer://attachments/abc12345)')).toEqual([]);
    expect(parseQuoteLinks('[deploy](kimi-code://skill/deploy)')).toEqual([]);
    // The image form of a NON-quote link stays literal (mentions and
    // attachments keep their old behavior); an image quote link with an
    // empty tail rejects like the plain form.
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
    expect(quotePillLabel('x'.repeat(40))).toBe('x'.repeat(23) + '…');
  });

  it('never returns an empty label (the link form needs one to parse back)', () => {
    expect(quotePillLabel('   \n  ')).toBe('…');
  });
});

describe('buildQuoteInsertion', () => {
  function state(text: string) {
    return EditorState.create({ schema: composerSchema, doc: textToDoc(text) });
  }

  it('fills the placeholder paragraph of an empty doc (no leading blank line)', () => {
    const s = state('');
    const doc = s.apply(buildQuoteInsertion(s, { text: '引用' })).doc;
    expect(docToText(doc)).toBe(`${link('引用')} `);
  });

  it('separates from a non-empty doc with a blank line (the text-era join)', () => {
    const s = state('hello');
    const doc = s.apply(buildQuoteInsertion(s, { text: '引用' })).doc;
    expect(docToText(doc)).toBe(`hello\n\n${link('引用')} `);
  });

  it('reuses a single trailing empty paragraph as the separator (Shift+Enter tail)', () => {
    const s = state('hello\n');
    const doc = s.apply(buildQuoteInsertion(s, { text: '引用' })).doc;
    expect(docToText(doc)).toBe(`hello\n\n${link('引用')} `);
  });

  it('collapses a multi-newline tail to exactly one separator blank line', () => {
    for (const draft of ['hello\n\n', 'hello\n\n\n']) {
      const s = state(draft);
      const doc = s.apply(buildQuoteInsertion(s, { text: '引用' })).doc;
      expect(docToText(doc)).toBe(`hello\n\n${link('引用')} `);
    }
  });

  it('rides the 评论 comment after the pill in the same paragraph, one undoable step', () => {
    const s = state('');
    const doc = s.apply(buildQuoteInsertion(s, { text: '引用' }, '评论')).doc;
    expect(docToText(doc)).toBe(`${link('引用')} 评论`);
  });

  it('accumulates: a second pill lands after a blank-line separation', () => {
    let s = state('');
    s = s.apply(buildQuoteInsertion(s, { text: 'q1' }));
    const doc = s.apply(buildQuoteInsertion(s, { text: 'q2' })).doc;
    expect(docToText(doc)).toBe(`${link('q1')} \n\n${link('q2')} `);
  });

  it('places the caret at the very end', () => {
    const s = state('hello');
    const next = s.apply(buildQuoteInsertion(s, { text: '引用' }));
    expect(next.selection.to).toBe(next.doc.content.size - 1);
  });
});
