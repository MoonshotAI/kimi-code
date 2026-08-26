// packages/app-composer/test/quote-block.test.ts
// Message-side quote blocks (ComposerText): splitQuoteBlocks segments a user
// message's wire text into quote chips / inline chunks / separators, and the
// segmentation is byte-reversible — quote chip → buildQuoteWireLines, every
// other block → its raw text, so a full-message copy round-trips exactly.
// DOM-free, same node env as the quote-link tests.
import { describe, expect, it } from 'vitest';
import { buildQuoteWireLines, encodeQuoteSourceHeader, reviveQuoteBlockLinks, serializeQuote, splitQuoteBlocks, type ComposerTextBlock } from '../src/composerTextDoc';

/** The copy-path inverse: map every render block back to its wire text. */
function reassemble(blocks: ComposerTextBlock[]): string {
  return blocks
    .map((block) =>
      block.type === 'quote'
        ? (block.source !== undefined ? `from: ${encodeQuoteSourceHeader(block.source)}\n` : '') +
          buildQuoteWireLines(block.text) +
          (block.comment !== undefined ? (block.commentSep ?? '') + block.comment : '')
        : block.text,
    )
    .join('');
}

describe('splitQuoteBlocks — segmentation', () => {
  it('a lone canonical blockquote chunk is one quote block (prefixes stripped)', () => {
    expect(splitQuoteBlocks('> 引用')).toEqual([{ type: 'quote', text: '引用' }]);
  });

  it('quote + comment PAIRS into one bundled block (sep absorbed verbatim)', () => {
    expect(splitQuoteBlocks('> 引用\n\n评论')).toEqual([{ type: 'quote', text: '引用', comment: '评论', commentSep: '\n\n' }]);
  });

  it('consecutive quotes: a quote followed by another quote never pairs, the last one pairs with its trailing text', () => {
    expect(splitQuoteBlocks('> q1\n\n> q2\n\n文本')).toEqual([
      { type: 'quote', text: 'q1' },
      { type: 'sep', text: '\n\n' },
      { type: 'quote', text: 'q2', comment: '文本', commentSep: '\n\n' },
    ]);
  });

  it('pairing keeps a longer separator verbatim (hand-typed 3+ newlines)', () => {
    expect(splitQuoteBlocks('> q\n\n\n评论')).toEqual([{ type: 'quote', text: 'q', comment: '评论', commentSep: '\n\n\n' }]);
  });

  it('a `from: …` header line splits off as the block source (single \\n join)', () => {
    expect(splitQuoteBlocks('from: src/a.ts:L42-L58\n> 代码')).toEqual([{ type: 'quote', text: '代码', source: 'src/a.ts:L42-L58' }]);
    expect(splitQuoteBlocks('from: docs/x.md\n> 引用\n\n评论')).toEqual([
      { type: 'quote', text: '引用', source: 'docs/x.md', comment: '评论', commentSep: '\n\n' },
    ]);
  });

  it('a bare `from: …` line without quote lines is not a quote block', () => {
    expect(splitQuoteBlocks('from: x')).toEqual([{ type: 'inline', text: 'from: x' }]);
    expect(splitQuoteBlocks('from: x\nplain text')).toEqual([{ type: 'inline', text: 'from: x\nplain text' }]);
  });

  it('a multiline quote stays one block, inner newlines preserved', () => {
    expect(splitQuoteBlocks('> 第一行\n> 第二行')).toEqual([{ type: 'quote', text: '第一行\n第二行' }]);
  });

  it('a bare `>` line inside a quote is an empty content line', () => {
    expect(splitQuoteBlocks('> a\n>\n> b')).toEqual([{ type: 'quote', text: 'a\n\nb' }]);
  });

  it('quote lines mixed with plain lines (hand-typed, no blank line) stay plain text', () => {
    expect(splitQuoteBlocks('前文\n> 引用')).toEqual([{ type: 'inline', text: '前文\n> 引用' }]);
    expect(splitQuoteBlocks('> 引用\n后文')).toEqual([{ type: 'inline', text: '> 引用\n后文' }]);
  });

  it('a non-canonical quote line (>没有空格) is not a quote block', () => {
    expect(splitQuoteBlocks('>没有空格')).toEqual([{ type: 'inline', text: '>没有空格' }]);
  });

  it('plain text and separators pass through untouched (3+ newlines kept)', () => {
    expect(splitQuoteBlocks('前文\n\n\n后文')).toEqual([
      { type: 'inline', text: '前文' },
      { type: 'sep', text: '\n\n\n' },
      { type: 'inline', text: '后文' },
    ]);
  });

  it('edges: empty text, lone separator, quote at the end (never pairs)', () => {
    expect(splitQuoteBlocks('')).toEqual([]);
    expect(splitQuoteBlocks('\n\n')).toEqual([{ type: 'sep', text: '\n\n' }]);
    expect(splitQuoteBlocks('评论\n\n> 引用')).toEqual([
      { type: 'inline', text: '评论' },
      { type: 'sep', text: '\n\n' },
      { type: 'quote', text: '引用' },
    ]);
  });
});

describe('splitQuoteBlocks — byte-reversible (the copy contract)', () => {
  it('reassembling every block reproduces the wire text exactly', () => {
    const wires = [
      '> 引用',
      '> 引用\n\n评论',
      '> q1\n\n> q2\n\n文本',
      '前文\n\n> 引用\n\n后文\n\n> 第二段\n\n收尾',
      '前文\n\n\n后文',
      '纯文本，没有引用',
      '前文\n> 手打混排',
      '> 多行\n> 引用\n> \n> 带空行\n\n',
      'from: src/a.ts:L42-L58\n> 代码',
      'from: docs/x.md\n> 引用\n\n评论',
      '前文\n\nfrom: p/a.ts:L1\n> q1\n\n> q2\n\n评论',
    ];
    for (const wire of wires) {
      expect(reassemble(splitQuoteBlocks(wire))).toBe(wire);
    }
  });
});

describe('buildQuoteWireLines', () => {
  it('prefixes every line with `> ` (the inverse of the chip)', () => {
    expect(buildQuoteWireLines('引用')).toBe('> 引用');
    expect(buildQuoteWireLines('a\nb')).toBe('> a\n> b');
    // Same mapping as app-client's buildQuoteLines: an empty content line is
    // `> ` (trailing space) — the canonical wire form.
    expect(buildQuoteWireLines('a\n\nb')).toBe('> a\n> \n> b');
  });
});

describe('splitQuoteBlocks — pairing only absorbs PLAIN text as the comment', () => {
  it('a following chunk with a mention/attachment/quote link stays its own inline block', () => {
    expect(splitQuoteBlocks('> 引用\n\n看 [a.ts](src/a.ts)')).toEqual([
      { type: 'quote', text: '引用' },
      { type: 'sep', text: '\n\n' },
      { type: 'inline', text: '看 [a.ts](src/a.ts)' },
    ]);
    expect(splitQuoteBlocks('> 引用\n\n[f](kimi-code-composer://attachments/1)')).toEqual([
      { type: 'quote', text: '引用' },
      { type: 'sep', text: '\n\n' },
      { type: 'inline', text: '[f](kimi-code-composer://attachments/1)' },
    ]);
    expect(splitQuoteBlocks('> 引用\n\n[x](kimi-code-composer://quote/%E5%BC%95%E7%94%A8)')).toEqual([
      { type: 'quote', text: '引用' },
      { type: 'sep', text: '\n\n' },
      { type: 'inline', text: '[x](kimi-code-composer://quote/%E5%BC%95%E7%94%A8)' },
    ]);
  });

  it('plain text after the block still pairs', () => {
    expect(splitQuoteBlocks('> 引用\n\n评论')).toEqual([{ type: 'quote', text: '引用', comment: '评论', commentSep: '\n\n' }]);
  });
});

describe('quote source header encoding (newline-safe from: line)', () => {
  it('percent-encodes newlines so the header stays one line, decoding round-trips', () => {
    expect(encodeQuoteSourceHeader('a\nb.ts')).toBe('a%0Ab.ts');
    expect(splitQuoteBlocks('from: a%0Ab.ts\n> 代码')).toEqual([{ type: 'quote', text: '代码', source: 'a\nb.ts' }]);
    expect(reassemble(splitQuoteBlocks('from: a%0Ab.ts\n> 代码'))).toBe('from: a%0Ab.ts\n> 代码');
  });

  it('protects a literal %0A in the path via the %25 layer', () => {
    expect(splitQuoteBlocks('from: a%250Ab.ts\n> q')).toEqual([{ type: 'quote', text: 'q', source: 'a%0Ab.ts' }]);
  });
});

describe('reviveQuoteBlockLinks (the paste/refill inverse of the submit rewrite)', () => {
  it('folds canonical quote blocks back to self-contained pill links', () => {
    expect(reviveQuoteBlockLinks('> 引用')).toBe(serializeQuote({ text: '引用' }));
    expect(reviveQuoteBlockLinks('from: src/a.ts:L1\n> 代码\n\n看这段')).toBe(
      serializeQuote({ text: '代码', source: 'src/a.ts:L1', comment: '看这段' }),
    );
  });

  it('surrounding text passes through byte-identical', () => {
    expect(reviveQuoteBlockLinks('前文\n\n> q\n\n后文')).toBe(`前文\n\n${serializeQuote({ text: 'q', comment: '后文' })}`);
    expect(reviveQuoteBlockLinks('纯文本')).toBe('纯文本');
  });
});
