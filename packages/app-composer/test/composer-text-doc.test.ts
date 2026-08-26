import { describe, expect, it } from 'vitest';
import { composerSchema, buildMentionInsertion, classifyMentionHref, collectSkillMentions, docToText, extendToTextblock, inlineRunStartOffset, mentionActionPath, mentionNode, parseClipboardText, parseMentionLinks, posToTextOffset, quoteNode, serializeClipboardSlice, serializeMention, splitMentionSegments, textOffsetToPos, textToDoc, unescapeRenderedLinkText } from '../src/composerTextDoc';
import { mentionHrefToPath } from '../src/mentionLinkPath';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';

describe('composerTextDoc — text ↔ doc', () => {
  it('round-trips plain text through the doc model', () => {
    const cases = ['', 'a', 'hello world', 'a\nb', '\n', 'a\n', '\na', 'a\n\nb', '第一行\n第二行', '  spaced  \n\ttabbed'];
    for (const text of cases) {
      expect(docToText(textToDoc(text))).toBe(text);
    }
  });

  it('models every line as its own paragraph', () => {
    const doc = textToDoc('a\nb\nc');
    expect(doc.childCount).toBe(3);
    expect(doc.firstChild?.type).toBe(composerSchema.nodes.paragraph);
  });

  it('keeps an empty string as a single empty paragraph (schema minimum)', () => {
    const doc = textToDoc('');
    expect(doc.childCount).toBe(1);
    expect(doc.textContent).toBe('');
  });
});

describe('composerTextDoc — char offset ↔ PM position', () => {
  it('maps every caret position of a single-line doc both ways', () => {
    const text = 'hello';
    const doc = textToDoc(text);
    for (let offset = 0; offset <= text.length; offset++) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, offset))).toBe(offset);
    }
  });

  it('round-trips offsets in a multi-line doc', () => {
    const text = 'ab\n\ncde';
    const doc = textToDoc(text);
    for (let offset = 0; offset <= text.length; offset++) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, offset))).toBe(offset);
    }
  });

  it('treats the newline offset as the end of the preceding line', () => {
    const text = 'ab\ncd';
    const doc = textToDoc(text);
    // offset 2 is the '\n' itself — it maps to the end of line 1's text, and
    // offset 3 ('c') to the start of line 2.
    expect(posToTextOffset(doc, textOffsetToPos(doc, 2))).toBe(2);
    expect(posToTextOffset(doc, textOffsetToPos(doc, 3))).toBe(3);
  });

  it('clamps offsets past the end to the document end', () => {
    const doc = textToDoc('ab\ncd');
    expect(posToTextOffset(doc, textOffsetToPos(doc, 999))).toBe(5);
  });

  it('clamps negative offsets to the document start', () => {
    const doc = textToDoc('ab\ncd');
    expect(posToTextOffset(doc, textOffsetToPos(doc, -3))).toBe(0);
  });

  it('keeps the produced positions valid for a TextSelection', () => {
    const text = 'one\ntwo\nthree';
    const doc = textToDoc(text);
    for (let offset = 0; offset <= text.length; offset++) {
      const pos = textOffsetToPos(doc, offset);
      const $pos = doc.resolve(pos);
      // A caret position must sit inside a textblock.
      expect($pos.parent.isTextblock).toBe(true);
    }
  });
});

describe('composerTextDoc — clipboard single-newline contract', () => {
  it('paste parsing preserves consecutive blank lines', () => {
    const slice = parseClipboardText('a\n\nb');
    expect(slice.content.childCount).toBe(3);
    expect(serializeClipboardSlice(slice)).toBe('a\n\nb');
  });

  it('paste parsing normalizes CRLF and lone CR', () => {
    expect(serializeClipboardSlice(parseClipboardText('a\r\nb\rc'))).toBe('a\nb\nc');
  });

  it('paste parsing opens the slice so it merges with the target paragraph', () => {
    const slice = parseClipboardText('x\ny');
    expect(slice.openStart).toBeGreaterThan(0);
    expect(slice.openEnd).toBeGreaterThan(0);
  });

  it('copy serialization joins lines with single newlines (no doubling)', () => {
    const doc = textToDoc('a\nb\nc');
    expect(serializeClipboardSlice(doc.slice(0, doc.content.size))).toBe('a\nb\nc');
  });

  it('serialize/parse round-trips empty and trailing-newline text', () => {
    expect(serializeClipboardSlice(parseClipboardText(''))).toBe('');
    expect(serializeClipboardSlice(parseClipboardText('a\n'))).toBe('a\n');
  });

  it('copies a NodeSelection’d pill as its link form, not an empty string', () => {
    // selection.content() puts the pill itself at the slice's top level, where
    // textBetween only walks the node's (empty) content and would yield ''.
    const state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('x [a.ts](src/a.ts)', { reviveMentions: true }),
    });
    // The pill sits right after the 'x ' text run, at position 3.
    const slice = NodeSelection.create(state.doc, 3).content();
    expect(serializeClipboardSlice(slice)).toBe('[a.ts](src/a.ts)');
  });

  it('degrades a quote pill to blockquote + comment, padding only between real neighbors', () => {
    // Mid-paragraph: blank lines on both sides, ONE following space eaten.
    const mid = composerSchema.nodes.doc.create(null, [
      composerSchema.nodes.paragraph.create(null, [
        composerSchema.text('看 '),
        quoteNode({ text: '引用\n第二行', source: 'src/a.ts:L1-L2', comment: '为什么' }),
        composerSchema.text(' 吧'),
      ]),
    ]);
    expect(serializeClipboardSlice(mid.slice(0, mid.content.size))).toBe(
      '看\n\nfrom: src/a.ts:L1-L2\n> 引用\n> 第二行\n\n为什么\n\n吧',
    );
    // Quote ALONE in its paragraph: no invented blank lines on either side.
    const own = composerSchema.nodes.doc.create(null, [
      composerSchema.nodes.paragraph.create(null, composerSchema.text('前文')),
      composerSchema.nodes.paragraph.create(null, quoteNode({ text: '引用' })),
    ]);
    expect(serializeClipboardSlice(own.slice(0, own.content.size))).toBe('前文\n> 引用');
    // Quote at paragraph START: pads only after.
    const head = composerSchema.nodes.doc.create(null, [
      composerSchema.nodes.paragraph.create(null, [quoteNode({ text: '引用' }), composerSchema.text(' 吧')]),
    ]);
    expect(serializeClipboardSlice(head.slice(0, head.content.size))).toBe('> 引用\n\n吧');
  });
});

describe('composerTextDoc — mentions', () => {
  it('serializes file/folder/skill mentions as Markdown links', () => {
    expect(serializeMention({ kind: 'file', name: 'a.ts', path: 'src/a.ts' })).toBe('[a.ts](src/a.ts)');
    // Folder paths gain the trailing slash
    expect(serializeMention({ kind: 'folder', name: 'src', path: 'src' })).toBe('[src](src/)');
    expect(serializeMention({ kind: 'folder', name: 'src', path: 'src/' })).toBe('[src](src/)');
    expect(serializeMention({ kind: 'skill', name: 'translator', path: '' })).toBe(
      '[translator](kimi-code://skill/translator)',
    );
  });

  it('keeps a Windows folder’s own trailing separator (no mixed tail glued on)', () => {
    // A revived Windows directory ('[docs](C:\docs\)' → attrs.path 'C:\docs\')
    // already carries its separator; appending '/' would serialize the mixed
    // 'C:\docs\/' and every surface would display/probe that verbatim.
    const attrs = { kind: 'folder', name: 'docs', path: 'C:\\docs\\' } as const;
    const wire = serializeMention(attrs);
    expect(wire).toBe('[docs](C%3A%5Cdocs%5C)');
    expect(parseMentionLinks(wire)).toEqual([{ start: 0, end: wire.length, attrs, rawDest: 'C%3A%5Cdocs%5C' }]);
  });

  it('canonical-encodes destinations (whitespace, parens, </>), escapes brackets in names', () => {
    // Every non-unreserved character percent-encodes per segment; no angle
    // form, no positional cases.
    expect(serializeMention({ kind: 'file', name: 'a b.ts', path: 'my dir/a b.ts' })).toBe('[a b.ts](my%20dir/a%20b.ts)');
    expect(serializeMention({ kind: 'file', name: 'a]b.ts', path: 'x' })).toBe('[a\\]b.ts](x)');
    expect(serializeMention({ kind: 'file', name: 'a', path: 'x(1)' })).toBe('[a](x%281%29)');
    // '<'/'>' are POSIX-legal filename characters; the canonical form needs
    // no angle workaround — '%3C' is inert to every Markdown parser.
    expect(serializeMention({ kind: 'file', name: 'a<b.md', path: 'docs/a<b.md' })).toBe('[a%3Cb.md](docs/a%3Cb.md)');
  });

  it('docToText keeps mentions in link form between text', () => {
    const doc = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [
        composerSchema.text('see '),
        mentionNode({ kind: 'file', name: 'a.ts', path: 'src/a.ts' }),
        composerSchema.text(' please'),
      ]),
    ]);
    expect(docToText(doc)).toBe('see [a.ts](src/a.ts) please');
  });

  it('maps offsets around a mention consistently (interior clamps to its end)', () => {
    const doc = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [
        composerSchema.text('ab'),
        mentionNode({ kind: 'file', name: 'x.ts', path: 'a/x.ts' }),
        composerSchema.text('cd'),
      ]),
    ]);
    const ser = 'ab[x.ts](a/x.ts)cd'; // serialized form, 18 chars
    expect(docToText(doc)).toBe(ser);
    // text offsets → PM positions
    expect(textOffsetToPos(doc, 0)).toBe(1); // before 'a'
    expect(textOffsetToPos(doc, 2)).toBe(3); // end of 'ab' == pill start
    expect(textOffsetToPos(doc, 3)).toBe(4); // inside pill → clamped after it
    expect(textOffsetToPos(doc, 16)).toBe(4); // pill end → after it ('c' starts here in text)
    expect(textOffsetToPos(doc, 18)).toBe(6); // doc end
    // PM positions → text offsets
    expect(posToTextOffset(doc, 1)).toBe(0);
    expect(posToTextOffset(doc, 3)).toBe(2); // before the pill
    expect(posToTextOffset(doc, 4)).toBe(16); // after the pill
    expect(posToTextOffset(doc, 6)).toBe(18);
    // Every boundary offset round-trips
    for (const o of [0, 1, 2, 16, 17, 18]) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, o))).toBe(o);
    }
  });

  it('collectSkillMentions returns skill pills in document order', () => {
    const doc = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [
        composerSchema.text('use '),
        mentionNode({ kind: 'file', name: 'a.ts', path: 'a.ts' }),
        composerSchema.text(' and '),
        mentionNode({ kind: 'skill', name: 'goal', path: '' }),
        composerSchema.text(' now'),
      ]),
    ]);
    const refs = collectSkillMentions(doc);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe('goal');
    // The activation args are the FULL serialized text: the skill pill stays
    // in its link form, so the sent bubble revives it in place.
    expect(docToText(doc)).toBe('use [a.ts](a.ts) and [goal](kimi-code://skill/goal) now');
  });

  it('clipboard serialization keeps the pill link form', () => {
    const doc = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [
        composerSchema.text('a '),
        mentionNode({ kind: 'folder', name: 'src', path: 'src' }),
      ]),
    ]);
    expect(serializeClipboardSlice(doc.slice(0, doc.content.size))).toBe('a [src](src/)');
  });
});

describe('composerTextDoc — buildMentionInsertion', () => {
  function stateOf(text: string): EditorState {
    return EditorState.create({ schema: composerSchema, doc: textToDoc(text) });
  }
  const FILE = { kind: 'file', name: 'a.ts', path: 'src/a.ts' } as const;

  it('replaces the @token with the pill and appends a trailing space at line end (caret home)', () => {
    const state = stateOf('hello @a');
    const next = state.apply(buildMentionInsertion(state, FILE, { start: 6, end: 8 }));
    // The trailing space is deliberate: a paragraph-ending atom would
    // otherwise need PM's trailing <br>, which strands the caret on a
    // phantom line.
    expect(docToText(next.doc)).toBe('hello [a.ts](src/a.ts) ');
    // Caret right after the pill + space → serialized offset = full text length.
    expect(posToTextOffset(next.doc, next.selection.from)).toBe('hello [a.ts](src/a.ts) '.length);
  });

  it('adds a trailing space when the next char is not whitespace', () => {
    const state = stateOf('@a,fix');
    const next = state.apply(buildMentionInsertion(state, FILE, { start: 0, end: 2 }));
    expect(docToText(next.doc)).toBe('[a.ts](src/a.ts) ,fix');
  });

  it('keeps existing trailing whitespace untouched', () => {
    const state = stateOf('@a rest');
    const next = state.apply(buildMentionInsertion(state, FILE, { start: 0, end: 2 }));
    expect(docToText(next.doc)).toBe('[a.ts](src/a.ts) rest');
  });

  it('a new @token after a pill stays detectable (whitespace-delimited scan)', () => {
    const state = stateOf('@a @b');
    const next = state.apply(buildMentionInsertion(state, FILE, { start: 0, end: 2 }));
    const text = docToText(next.doc);
    // The second token is separated from the pill's link form by a space.
    expect(text.endsWith(' @b')).toBe(true);
  });

  it('breaks `!` and `\\` prefixes with a space so the mention still parses as a link', () => {
    // `![alt](src)` tokenizes as ONE image construct (rejected wholesale)
    // and `\[` is an escaped literal — the editor's own product must still
    // round-trip, so the insertion separates the prefix.
    const bang = stateOf('!');
    const afterBang = bang.apply(buildMentionInsertion(bang, FILE, { start: 1, end: 1 }));
    expect(docToText(afterBang.doc)).toBe('! [a.ts](src/a.ts) ');
    expect(parseMentionLinks(docToText(afterBang.doc))).toHaveLength(1);

    const backslash = stateOf('\\');
    const afterBackslash = backslash.apply(buildMentionInsertion(backslash, FILE, { start: 1, end: 1 }));
    expect(docToText(afterBackslash.doc)).toBe('\\ [a.ts](src/a.ts) ');
    expect(parseMentionLinks(docToText(afterBackslash.doc))).toHaveLength(1);
  });
});

describe('composerTextDoc — inlineRunStartOffset (token-scan lower bound)', () => {
  const docOf = (parts: Array<string | ReturnType<typeof mentionNode>>) =>
    composerSchema.node('doc', null, [
      composerSchema.node(
        'paragraph',
        null,
        parts.filter((p) => p !== '').map((p) => (typeof p === 'string' ? composerSchema.text(p) : p)),
      ),
    ]);
  const PILL = () => mentionNode({ kind: 'file', name: 'a.ts', path: 'src/a.ts' });

  it('caret inside a text node → start of that text node', () => {
    // 'hello' text; caret between 'e' and 'l' (pos 3)
    expect(inlineRunStartOffset(docOf(['hello']), docOf(['hello']).resolve(3))).toBe(0);
  });

  it('caret at a text-node END boundary → start of that text node (not the caret)', () => {
    // The regression case: after typing, the caret sits at the run's end
    // boundary where $pos.textOffset is 0. 'ab' + pill; caret right after 'ab'.
    const doc = docOf(['ab', PILL()]);
    expect(inlineRunStartOffset(doc, doc.resolve(3))).toBe(0);
  });

  it('caret right after a pill → the caret position itself', () => {
    const doc = docOf([PILL(), '']);
    // pill at [1,2]; caret at 2 (right after it)
    expect(inlineRunStartOffset(doc, doc.resolve(2))).toBe(docToText(doc).length);
  });

  it('caret at paragraph start → 0', () => {
    const doc = docOf(['', PILL(), 'x']);
    expect(inlineRunStartOffset(doc, doc.resolve(1))).toBe(0);
  });

  it('caret at end of a post-pill text run → start of that run', () => {
    // 'x' + pill + 'ab'; serialized: 'x[a.ts](src/a.ts)ab' (len 1+14+2=17); caret at doc end
    const doc = docOf(['x', PILL(), 'ab']);
    const end = doc.content.size - 1;
    expect(inlineRunStartOffset(doc, doc.resolve(end))).toBe('x[a.ts](src/a.ts)'.length);
  });
});

describe('composerTextDoc — classifyMentionHref (message-side pill routing)', () => {
  it('classifies skill links', () => {
    expect(classifyMentionHref('kimi-code://skill/write-goal')).toBe('skill');
  });
  it('rejects a skill link with an empty name (no round-trip, dead pill)', () => {
    // '[x](kimi-code://skill/)' would decode to an empty name — a dead
    // icon-only pill that re-serializes with an empty label, which the
    // parser in turn rejects. It stays ordinary text.
    expect(classifyMentionHref('kimi-code://skill/')).toBeNull();
  });
  it('classifies folder links by trailing slash (no query/fragment stripping — folder names may contain them)', () => {
    expect(classifyMentionHref('apps/')).toBe('folder');
    expect(classifyMentionHref('my#dir/')).toBe('folder');
    expect(classifyMentionHref('my?dir/')).toBe('folder');
    // A fragment tail means the href no longer ends with '/' — not a folder mention.
    expect(classifyMentionHref('apps/#frag')).toBe('file');
  });
  it('classifies Windows directories by a trailing backslash (raw or renderer-encoded)', () => {
    // A hand-written '[d](C:\docs\)' and its renderer-normalized form both
    // end with the Windows separator — a directory, not a clickable file.
    expect(classifyMentionHref('C:\\docs\\')).toBe('folder');
    expect(classifyMentionHref('C:%5Cdocs%5C')).toBe('folder');
    expect(classifyMentionHref('c:%5cdocs%5c')).toBe('folder');
  });
  it('classifies plain paths as files', () => {
    expect(classifyMentionHref('src/a.ts')).toBe('file');
    expect(classifyMentionHref('src/a.ts#L12')).toBe('file');
  });
  it('returns null for external/anchor hrefs', () => {
    expect(classifyMentionHref('https://x.com/a')).toBeNull();
    expect(classifyMentionHref('mailto:a@b.c')).toBeNull();
    expect(classifyMentionHref('#anchor')).toBeNull();
    expect(classifyMentionHref('')).toBeNull();
  });
  it('returns null for query-only hrefs (same-page navigation, not a file)', () => {
    // [next](?page=2) must stay an ordinary link: on openFile surfaces a
    // 'file' classification would intercept the click to preview a fake
    // '?page=2' file. Our own '?'-leading filenames are '%3F'-encoded on the
    // wire, so the raw guard never rejects a composer product.
    expect(classifyMentionHref('?page=2')).toBeNull();
    expect(classifyMentionHref('%3Fnotes.md')).toBe('file');
  });
  it('returns null for protocol-relative URLs (//host/path is a network target, not a file)', () => {
    // No scheme for the regex to catch, and not anchor- or skill-prefixed —
    // without an explicit guard it would misclassify as a file/folder and the
    // Markdown side would intercept navigation to preview a fake local file.
    expect(classifyMentionHref('//example.com/path')).toBeNull();
    expect(classifyMentionHref('//example.com/dir/')).toBeNull();
  });
  it('returns null for non-skill URI schemes (not workspace files)', () => {
    expect(classifyMentionHref('ftp://host/path')).toBeNull();
    expect(classifyMentionHref('vscode://file/x')).toBeNull();
    expect(classifyMentionHref('kimi-code://other/x')).toBeNull();
  });
  it('treats Windows drive paths as files/folders, not schemes', () => {
    expect(classifyMentionHref('C:\\Users\\a.ts')).toBe('file');
    expect(classifyMentionHref('C:/Users/a.ts')).toBe('file');
    expect(classifyMentionHref('D:/dir/')).toBe('folder');
  });
  it('treats a renderer-normalized drive href (%5C backslashes) as a file', () => {
    // markdown-it URI-normalizes [a](C:\docs\a.ts) into 'C:%5Cdocs%5Ca.ts' —
    // without the '%5C' in the drive exemption the scheme guard would reject
    // it and the link would never become a pill.
    expect(classifyMentionHref('C:%5Cdocs%5Ca.ts')).toBe('file');
    expect(classifyMentionHref('c:%5cdocs%5ca.ts')).toBe('file');
  });
});

describe('composerTextDoc — mentionActionPath (action-layer path)', () => {
  it('strips an unencoded # anchor or ? query tail', () => {
    expect(mentionActionPath('README.md#usage')).toBe('README.md');
    expect(mentionActionPath('docs/a.md?plain=1')).toBe('docs/a.md');
    expect(mentionActionPath('docs/a.md#sec?t=1')).toBe('docs/a.md');
  });
  it('leaves paths without a raw #/? untouched', () => {
    expect(mentionActionPath('docs/a.md')).toBe('docs/a.md');
    expect(mentionActionPath('/abs/dir/folder/')).toBe('/abs/dir/folder/');
  });
  it('keeps percent-encoded %23/%3F when applied on the raw href', () => {
    // Action sites strip BEFORE decoding, so an encoded separator survives
    // as a genuine filename character.
    expect(mentionActionPath('docs/a%23b.md')).toBe('docs/a%23b.md');
    expect(mentionActionPath('docs/my%20file.md#usage')).toBe('docs/my%20file.md');
  });
  it('keeps a bare query/anchor href instead of cutting to an empty path', () => {
    expect(mentionActionPath('?page=2')).toBe('?page=2');
    expect(mentionActionPath('#only')).toBe('#only');
  });
});

describe('composerTextDoc — mention revival (textToDoc reviveMentions)', () => {
  it('revives a file link into a pill (round-trips)', () => {
    const doc = textToDoc('see [a.ts](src/a.ts) please', { reviveMentions: true });
    expect(doc.firstChild?.childCount).toBe(3);
    expect(doc.firstChild?.child(1).type.name).toBe('mention');
    expect(doc.firstChild?.child(1).attrs).toEqual({ kind: 'file', name: 'a.ts', path: 'src/a.ts' });
    expect(docToText(doc)).toBe('see [a.ts](src/a.ts) please');
  });

  it('revives folder and skill forms', () => {
    const doc = textToDoc('[apps](apps/) and [goal](kimi-code://skill/goal)', { reviveMentions: true });
    const para = doc.firstChild!;
    expect(para.child(0).attrs.kind).toBe('folder');
    expect(para.child(0).attrs.path).toBe('apps/');
    expect(para.child(2).attrs).toEqual({ kind: 'skill', name: 'goal', path: '' });
    expect(docToText(doc)).toBe('[apps](apps/) and [goal](kimi-code://skill/goal)');
  });

  it('revives the legacy angle-bracket form and re-serializes it canonically', () => {
    // Old wire (angle form, pre-canonical) keeps parsing — but new output is
    // always the canonical percent form (§9: never rewrite stored text, but
    // new serializations take the new shape).
    const doc = textToDoc('[a b.ts](<my dir/a b.ts>)', { reviveMentions: true });
    expect(doc.firstChild?.firstChild?.attrs.path).toBe('my dir/a b.ts');
    expect(docToText(doc)).toBe('[a b.ts](my%20dir/a%20b.ts)');
  });

  it('unescapes bracket/paren escapes from the serializer', () => {
    const doc = textToDoc('[a\\]b.ts](x\\(1\\))', { reviveMentions: true });
    expect(doc.firstChild?.firstChild?.attrs).toEqual({ kind: 'file', name: 'a]b.ts', path: 'x(1)' });
  });

  it('leaves malformed or non-local links as literal text', () => {
    for (const bad of ['[a.ts] (src/a.ts)', '[a.ts](', '[](x)', '[x]()', '[x](https://a.b/c)', '[站点](//example.com/path)', '[server](ftp://host/path)', '[open](vscode://file/x)']) {
      const doc = textToDoc(bad, { reviveMentions: true });
      expect(doc.firstChild?.firstChild?.isText).toBe(true);
      expect(docToText(doc)).toBe(bad);
    }
  });

  it('revives pills on the paste path too (copy-paste round-trips)', () => {
    const slice = parseClipboardText('see [a.ts](src/a.ts)', { reviveMentions: true });
    const para = slice.content.firstChild!;
    expect(para.child(1).type.name).toBe('mention');
    expect(serializeClipboardSlice(slice)).toBe('see [a.ts](src/a.ts)');
  });

  it('does NOT revive on the paste path when the flag is off', () => {
    const doc = textToDoc('[a.ts](src/a.ts)');
    expect(doc.firstChild?.firstChild?.isText).toBe(true);
  });

  it('does not revive Markdown images or escaped brackets', () => {
    // ![alt](src) is an image, \[...] an escaped bracket — neither is a pill.
    for (const text of ['![preview](img.png)', 'see ![p](x.png) end', '\\[a.ts](src/a.ts)']) {
      const doc = textToDoc(text, { reviveMentions: true });
      expect(doc.firstChild?.firstChild?.isText).toBe(true);
      expect(docToText(doc)).toBe(text);
      expect(parseMentionLinks(text)).toEqual([]);
    }
    // An ESCAPED '!' is literal text; the link after it still revives.
    const matches = parseMentionLinks('\\![a.ts](src/a.ts)');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(2);
    expect(matches[0]!.attrs.name).toBe('a.ts');
  });

  it('takes a revived skill’s identity from the link TARGET, not the label', () => {
    const doc = textToDoc('[发布](kimi-code://skill/deploy)', { reviveMentions: true });
    const pill = doc.firstChild?.firstChild;
    expect(pill?.type.name).toBe('mention');
    // The pill normalizes to the real skill name — that is what the submit
    // path activates — and the doc text rewrites to the canonical form.
    expect(pill?.attrs).toEqual({ kind: 'skill', name: 'deploy', path: '' });
    expect(docToText(doc)).toBe('[deploy](kimi-code://skill/deploy)');
    expect(collectSkillMentions(doc)[0]?.name).toBe('deploy');
  });

  it('decodes url-encoded skill names from the target', () => {
    const matches = parseMentionLinks('[label](kimi-code://skill/write%20goal)');
    expect(matches[0]?.attrs).toEqual({ kind: 'skill', name: 'write goal', path: '' });
  });

  it('decodes a skill name with a literal % triplet exactly once (round trip)', () => {
    // 'review%20draft' serializes as '%2520' — decoding twice would land on
    // 'review draft', a different (nonexistent) skill.
    const attrs = { kind: 'skill', name: 'review%20draft', path: '' } as const;
    const wire = serializeMention(attrs);
    expect(wire).toBe('[review%2520draft](kimi-code://skill/review%2520draft)');
    expect(parseMentionLinks(wire)).toEqual([{ start: 0, end: wire.length, attrs, rawDest: 'kimi-code://skill/review%2520draft' }]);
  });

  it('percent-encodes parens in skill names (CommonMark bare destinations require balanced parens)', () => {
    // A skill named 'x(1' would otherwise serialize an unbalanced-paren bare
    // destination that no CommonMark parser revives. decodeSkillName reverses
    // the encoding, so both the new form and the historical unencoded form
    // (when its parens happen to balance) read back the same name.
    const attrs = { kind: 'skill', name: 'x(1', path: '' } as const;
    const wire = serializeMention(attrs);
    expect(wire).toBe('[x(1](kimi-code://skill/x%281)');
    expect(parseMentionLinks(wire)).toEqual([{ start: 0, end: wire.length, attrs, rawDest: 'kimi-code://skill/x%281' }]);
    // Historical wire form (parens unencoded but balanced) still revives.
    expect(parseMentionLinks('[y(z)](kimi-code://skill/y(z))')[0]?.attrs).toEqual({
      kind: 'skill',
      name: 'y(z)',
      path: '',
    });
  });

  it('round-trips filenames with literal percent triplets (% travels as %25)', () => {
    // A real file named 'a%20b.md' must survive the chain untouched: the
    // serializer encodes '%' as '%25' — a valid triplet the Markdown renderer
    // keeps verbatim — and revival decodes it back. Same for '%2F', which
    // must never end up decoded into a path separator. The label encodes '%'
    // the same way as the destination (the '%0A'/'%0D' newline layer would
    // otherwise alias it).
    for (const path of ['docs/a%20b.md', 'a%2Fb.md']) {
      const attrs = { kind: 'file', name: path.split('/').pop()!, path } as const;
      const wire = serializeMention(attrs);
      expect(wire).toBe(`[${attrs.name.replace(/%/g, '%25')}](${path.replace(/%/g, '%25')})`);
      expect(parseMentionLinks(wire)).toEqual([{ start: 0, end: wire.length, attrs, rawDest: path.replace(/%/g, '%25') }]);
      const doc = textToDoc(wire, { reviveMentions: true });
      expect(doc.firstChild?.firstChild?.attrs).toEqual(attrs);
      expect(docToText(doc)).toBe(wire);
    }
  });

  it('serialization corpus: every serializer-produced wire form round-trips exactly (arbiter test)', () => {
    // This corpus is THE arbiter for all future serialization questions. For
    // each filename shape below, parse(serialize(x)) must be EXACTLY x —
    // kind/name/path all equal — and the match must span the WHOLE wire form
    // (start 0, end wire.length), which proves micromark really tokenized the
    // wire form as one link: a parseMentionLinks match can only arise from a
    // genuine label+resource token pair, the reject pipeline only ever drops
    // candidates. Rule of thumb: a serializer change that breaks a shape
    // fails here first; a newly reported filename shape is added here first.
    const paths = [
      'plain.md',
      'my dir/a b.md', // whitespace → angle form
      'x(1).md', // balanced parens
      'x(1.md', // unbalanced paren (POSIX-legal) → escaped bare form
      'docs/a<b.md', // '<' → angle form
      'docs/a>b.md', // '>' → angle form
      'a<b>c.md',
      'report%final.md', // raw '%' → '%25'
      'report%20final.md', // a literal, valid %xx triplet must never decode
      'docs/a#b.md', // '#'
      'docs/a?b.md', // '?'
      '#notes.md', // leading '#' — would classify as an anchor unencoded
      'docs/#notes.md', // '#' after a slash stays a file (no anchor form)
      'notes:old.md', // leading colon would classify as a URI scheme
      'http:fixture', // scheme-shaped name — must not revive as a scheme
      'docs\nold/a.md', // POSIX-legal newline — must travel as '%0A'
      'a\nb.md', // newline in the BASENAME — the label encodes it too
      'a%0Ab.md', // literal '%0A' in the name — must not alias the newline layer
      '//mount/file.md', // leading '//' would classify as protocol-relative
      'a&amp;b.md', // looks like an HTML character reference ('&' → '%26')
      'a<b.md', // '<' in the name — inline-HTML metachar in the label ('%3C')
      'a\\b.md', // backslash
      '第一/稿 件.md', // CJK (+ whitespace → angle)
      'emoji 🍱/bento 🍱.md', // emoji (surrogate pairs; offsets are UTF-16)
      'combining/éclair.md', // combining char (é as 'e' + U+0301)
    ];
    for (const path of paths) {
      const attrs = { kind: 'file', name: path.split('/').pop()!, path } as const;
      const wire = serializeMention(attrs);
      // The canonical dest alphabet contains neither ']' nor '(', so the LAST
      // '](' is always the label/dest boundary — rawDest is the span after it.
      expect(parseMentionLinks(wire)).toEqual([
        { start: 0, end: wire.length, attrs, rawDest: wire.slice(wire.lastIndexOf('](') + 2, -1) },
      ]);
      // …and through the doc model, the way draft restore / history recall /
      // bubble pillify consume it.
      const doc = textToDoc(wire, { reviveMentions: true });
      expect(doc.firstChild?.firstChild?.attrs).toEqual(attrs);
      expect(docToText(doc)).toBe(wire);
    }
  });
});

describe('composerTextDoc — unescapeRenderedLinkText (rendered-surface label decode)', () => {
  it('undoes only the serializer percent layers (renderer already ate the backslash layer)', () => {
    // Rendered textContent of the wire label for a real 'a%20b.md'.
    expect(unescapeRenderedLinkText('a%2520b.md')).toBe('a%20b.md');
    // '&' and inline-HTML metachars ride as '%26' / '%3C' / '%3E'.
    expect(unescapeRenderedLinkText('a%26amp;b.md')).toBe('a&amp;b.md');
    expect(unescapeRenderedLinkText('a%3Cb.md')).toBe('a<b.md');
    // A literal '%0A' in the name never aliases the newline layer.
    expect(unescapeRenderedLinkText('a%250Ab.md')).toBe('a%0Ab.md');
  });

  it('keeps a literal backslash in the filename (no second CommonMark decode)', () => {
    // Real filename 'a\[b.md': the serializer emits 'a\\\[b.md', the renderer
    // consumes one escape layer → textContent is 'a\[b.md' — stripping the
    // remaining backslash would rewrite the name to 'a[b.md'.
    expect(unescapeRenderedLinkText('a\\[b.md')).toBe('a\\[b.md');
    expect(unescapeRenderedLinkText('a\\b.md')).toBe('a\\b.md');
  });
});

describe('composerTextDoc — parseMentionLinks (message-side pillify)', () => {
  it('finds all mention links with their ranges', () => {
    const text = 'a [x.ts](src/x.ts) b [dir](dir/) c [goal](kimi-code://skill/goal)';
    const matches = parseMentionLinks(text);
    expect(matches.map((m) => m.attrs.kind)).toEqual(['file', 'folder', 'skill']);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('[x.ts](src/x.ts)');
    expect(text.slice(matches[2]!.start, matches[2]!.end)).toBe('[goal](kimi-code://skill/goal)');
  });

  it('skips non-mention bracket text', () => {
    expect(parseMentionLinks('see [docs](https://x.com) or [draft] here')).toEqual([]);
  });

  it('decodes standard Markdown percent-encoding in hand-written links (no %25 compounding)', () => {
    // '[文档](my%20file.md)' is an ordinary local link with a real space —
    // reviving and re-serializing must preserve the MEANING, not compound
    // the '%' into '%25' on every pass.
    const matches = parseMentionLinks('[文档](my%20file.md)');
    expect(matches).toEqual([
      { start: 0, end: 18, attrs: { kind: 'file', name: '文档', path: 'my file.md' }, rawDest: 'my%20file.md' },
    ]);
    const wire = serializeMention(matches[0]!.attrs);
    expect(parseMentionLinks(wire)[0]!.attrs).toEqual(matches[0]!.attrs);
  });

  it('exposes the raw destination exactly as written (angle brackets stripped, escapes intact)', () => {
    // Bare form: the dest span verbatim.
    expect(parseMentionLinks('[a](x.md)')[0]?.rawDest).toBe('x.md');
    // Hand-written escaped bare form: the backslash layer stays in rawDest —
    // it is pre-unescape by definition (attrs.path already consumed it).
    const escaped = parseMentionLinks('[x(1.md](x\\(1.md)');
    expect(escaped[0]?.rawDest).toBe('x\\(1.md');
    expect(escaped[0]?.attrs.path).toBe('x(1.md');
    // Hand-written angle form: the brackets are not part of the dest.
    const angled = parseMentionLinks('[a b.md](<my dir/a b.md>)');
    expect(angled[0]?.rawDest).toBe('my dir/a b.md');
    expect(angled[0]?.attrs.path).toBe('my dir/a b.md');
  });

  it('never spans a line boundary — parsing is per line, matching textToDoc exactly', () => {
    // micromark accepts a single '\n' inside a label, but textToDoc splits
    // paragraphs first and revives nothing: the same text must not pillify
    // either (a bubble pill that was never submitted as a mention).
    expect(parseMentionLinks('[foo\nbar](kimi-code://skill/deploy)')).toEqual([]);
    // Mentions on separate lines still parse, with offsets rebased onto the
    // original text.
    expect(parseMentionLinks('a [x](y)\nb [dir](z/)')).toEqual([
      { start: 2, end: 8, attrs: { kind: 'file', name: 'x', path: 'y' }, rawDest: 'y' },
      { start: 11, end: 20, attrs: { kind: 'folder', name: 'dir', path: 'z/' }, rawDest: 'z/' },
    ]);
  });

  it('an unescaped inner [ invalidates the outer candidate — the inner link wins, the prefix stays literal', () => {
    // The serializer escapes '[' inside labels, so a genuine mention label
    // never contains a raw one: '[unfinished ...' is plain text and the inner
    // '[README](README.md)' is the real mention.
    const text = 'prefix [unfinished [README](README.md)';
    const matches = parseMentionLinks(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.attrs).toEqual({ kind: 'file', name: 'README', path: 'README.md' });
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('[README](README.md)');
    const doc = textToDoc(text, { reviveMentions: true });
    expect(doc.firstChild?.firstChild?.isText).toBe(true);
    expect(docToText(doc)).toBe(text);
  });

  it('stays correct on long texts full of dead link starts (linear scan)', () => {
    // Runs that used to defeat naive rescanning in the hand-rolled scanner
    // (unescaped inner brackets, unclosed '<' destinations — the old i+1
    // rescan made these O(n²)). Parsing now goes through micromark's linear
    // tokenizer; these stay as regression guards for the edge shapes.
    const brackets = '['.repeat(3000);
    const text = `pre ${brackets}[a.ts](src/a.ts) mid ${'[k](<'.repeat(800)} tail`;
    const matches = parseMentionLinks(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.attrs).toEqual({ kind: 'file', name: 'a.ts', path: 'src/a.ts' });
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('[a.ts](src/a.ts)');
    // Pure dead ends: '(' with no ')' anywhere, '[' with no ']' anywhere.
    expect(parseMentionLinks('[x]('.repeat(1500))).toEqual([]);
    expect(parseMentionLinks('['.repeat(5000))).toEqual([]);
  });

  it('keeps a link with a TITLE as literal text (the old scanner revived it with the title glued to the path)', () => {
    // micromark tokenizes these as links carrying a resourceTitle; our wire
    // format has no title concept, so they are rejected wholesale.
    for (const text of ['[a](b "title")', "[a](b 'title')", '[a](b (title))', '[a](<b> "t")']) {
      expect(parseMentionLinks(text)).toEqual([]);
      const doc = textToDoc(text, { reviveMentions: true });
      expect(docToText(doc)).toBe(text);
    }
  });

  it('keeps reference-style links as literal text', () => {
    // With micromark's `definition` construct disabled, references never
    // resolve — full/collapsed/shortcut forms all stay literal, even when a
    // definition line is present in the same blob (pillify sees whole texts).
    for (const text of ['[a][b]', '[a][]', '[a]', '[a][b]\n\n[b]: /url', '[a][]\n\n[a]: /url']) {
      expect(parseMentionLinks(text)).toEqual([]);
      const doc = textToDoc(text, { reviveMentions: true });
      expect(docToText(doc)).toBe(text);
    }
  });

  it('revives link-shaped text inside CODE delimiters too (round-trip invariant)', () => {
    // Backticks / fences / indent are literal text to the wire format, and the
    // editor can legitimately insert a real mention atom between them — its
    // link form MUST revive on draft restore / history recall / bubble
    // pillify, or the pill silently degrades to plain text. So the code
    // constructs are disabled and this parser recognizes links in EVERY
    // context.
    for (const text of ['`[a](b)`', '```\n[a](b)\n```', '    [a](b)']) {
      const matches = parseMentionLinks(text);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.attrs).toEqual({ kind: 'file', name: 'a', path: 'b' });
    }
    const doc = textToDoc('see `[a](b)` end', { reviveMentions: true });
    expect(doc.firstChild?.child(1).type.name).toBe('mention');
    expect(docToText(doc)).toBe('see `[a](b)` end');
    // …and a link right AFTER literal backticks still revives at its offset.
    const matches = parseMentionLinks('`x` [a](b)');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(4);
  });

  it('reports mention ranges as UTF-16 offsets into the original text (emoji/CJK)', () => {
    // 🍱 is a surrogate pair (2 UTF-16 units), 看 one unit: the '[' sits at
    // offset 4. Offsets come straight from micromark tokens, which index the
    // original string — the offset math in this file depends on it.
    const text = '🍱看 [x](a/b.txt) 和 [发布](kimi-code://skill/deploy)';
    const matches = parseMentionLinks(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.start).toBe(4);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('[x](a/b.txt)');
    expect(matches[0]!.attrs).toEqual({ kind: 'file', name: 'x', path: 'a/b.txt' });
    expect(text.slice(matches[1]!.start, matches[1]!.end)).toBe('[发布](kimi-code://skill/deploy)');
    expect(matches[1]!.attrs).toEqual({ kind: 'skill', name: 'deploy', path: '' });
    // CRLF shifts nothing: offsets still index the original string.
    const crlf = parseMentionLinks('a\r\n[x](y)');
    expect(crlf).toHaveLength(1);
    expect(crlf[0]!.start).toBe(3);
  });
});

describe('composerTextDoc — splitMentionSegments (message-side segmentation)', () => {
  it('returns a single text run when there is no mention', () => {
    expect(splitMentionSegments('plain [text] (nothing)')).toEqual([{ type: 'text', value: 'plain [text] (nothing)' }]);
    expect(splitMentionSegments('')).toEqual([{ type: 'text', value: '' }]);
  });

  it('segments alternating text and mentions in document order', () => {
    expect(splitMentionSegments('a [x.ts](src/x.ts) b [dir](dir/) c')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'mention', attrs: { kind: 'file', name: 'x.ts', path: 'src/x.ts' }, rawDest: 'src/x.ts' },
      { type: 'text', value: ' b ' },
      { type: 'mention', attrs: { kind: 'folder', name: 'dir', path: 'dir/' }, rawDest: 'dir/' },
      { type: 'text', value: ' c' },
    ]);
  });

  it('handles mentions at the boundaries and back to back (no empty text runs)', () => {
    expect(splitMentionSegments('[x](y)[g](kimi-code://skill/g) tail')).toEqual([
      { type: 'mention', attrs: { kind: 'file', name: 'x', path: 'y' }, rawDest: 'y' },
      { type: 'mention', attrs: { kind: 'skill', name: 'g', path: '' }, rawDest: 'kimi-code://skill/g' },
      { type: 'text', value: ' tail' },
    ]);
    expect(splitMentionSegments('pre [x](y)')).toEqual([
      { type: 'text', value: 'pre ' },
      { type: 'mention', attrs: { kind: 'file', name: 'x', path: 'y' }, rawDest: 'y' },
    ]);
  });

  it('keeps rejected link-shaped text verbatim inside the text runs', () => {
    expect(splitMentionSegments('see ![img](a.png) and [a](b "t")')).toEqual([
      { type: 'text', value: 'see ![img](a.png) and [a](b "t")' },
    ]);
  });

  it('keeps a cross-line link label verbatim, and newlines inside the text runs', () => {
    // Same line boundaries as textToDoc: a label spanning '\n' is not a
    // mention on ANY surface (see parseMentionLinks).
    expect(splitMentionSegments('[foo\nbar](kimi-code://skill/deploy)')).toEqual([
      { type: 'text', value: '[foo\nbar](kimi-code://skill/deploy)' },
    ]);
    expect(splitMentionSegments('[x](y)\n[z](w)')).toEqual([
      { type: 'mention', attrs: { kind: 'file', name: 'x', path: 'y' }, rawDest: 'y' },
      { type: 'text', value: '\n' },
      { type: 'mention', attrs: { kind: 'file', name: 'z', path: 'w' }, rawDest: 'w' },
    ]);
  });

  it('carries the raw destination so action paths strip a fragment tail without touching canonical filenames', () => {
    // A hand-written chat link: the action path (click-to-open, probe) cuts
    // the unencoded '#' tail on the RAW dest; the display path keeps it.
    const hand = splitMentionSegments('[Usage](README.md#usage)')[0];
    if (hand.type !== 'mention') throw new Error('expected a mention segment');
    expect(hand.attrs.path).toBe('README.md#usage');
    expect(mentionHrefToPath(mentionActionPath(hand.rawDest))).toBe('README.md');
    // A canonical composer-wire filename: '%23' is not a literal '#', so the
    // action cut passes it by and the single decode restores the real name —
    // action and display paths coincide (no data-mention-action-path then).
    const canonical = splitMentionSegments('[#notes.md](docs/%23notes.md)')[0];
    if (canonical.type !== 'mention') throw new Error('expected a mention segment');
    expect(canonical.attrs.path).toBe('docs/#notes.md');
    expect(mentionHrefToPath(mentionActionPath(canonical.rawDest))).toBe('docs/#notes.md');
  });
});

describe('composerTextDoc — extendToTextblock (Cmd-Shift-Arrow line selection)', () => {
  function stateOf(text: string, cursor: number): EditorState {
    const doc = textToDoc(text, { reviveMentions: true });
    return EditorState.create({ schema: composerSchema, doc, selection: TextSelection.create(doc, cursor) });
  }

  it('moves the head to the paragraph end from before an attachment pill', () => {
    // The native Chromium moveTo*OfLine sticks on non-editable inline atoms —
    // this command is the explicit replacement (one paragraph == one line).
    // Caret at the pill's left = position 1 (inside the paragraph, before
    // its first inline node) — position 0 is outside the textblock and not a
    // valid caret.
    const text = '[a.pdf](kimi-code-composer://attachments/ab12cd34) rest';
    const state = stateOf(text, 1);
    let applied: EditorState | undefined;
    const ok = extendToTextblock(false)(state, (tr) => (applied = state.apply(tr)));
    expect(ok).toBe(true);
    expect(applied).toBeDefined();
    expect(applied!.selection.head).toBe(state.doc.child(0).nodeSize - 1);
    expect(applied!.selection.anchor).toBe(1);
  });

  it('moves the head to the paragraph start', () => {
    const state = stateOf('[a.pdf](kimi-code-composer://attachments/ab12cd34) rest', 5);
    let applied: EditorState | undefined;
    extendToTextblock(true)(state, (tr) => (applied = state.apply(tr)));
    expect(applied!.selection.head).toBe(1);
    expect(applied!.selection.anchor).toBe(5);
  });

  it('dry-runs (no dispatch) report applicability without touching state', () => {
    const state = stateOf('plain', 2);
    expect(extendToTextblock(false)(state)).toBe(true);
    expect(state.selection.head).toBe(2);
  });
});
