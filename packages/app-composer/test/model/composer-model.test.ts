import { describe, expect, it } from 'vitest';
import { composerSchema, buildMentionInsertion, buildTextRangeReplacement, classifyMentionHref, collectSkillMentions, docToText, extendToTextblock, inlineRunStartOffset, linkBareSessionUrls, mentionActionLine, mentionActionPath, mentionNode, parseClipboardText, parseMentionLinks, posToTextOffset, quoteNode, serializeClipboardSlice, serializeMention, splitMentionSegments, textOffsetToPos, textToDoc, unescapeRenderedLinkText } from '../../src/model';
import { mentionHrefToPath } from '../../src/features/mention/linkPath';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { history, undo, closeHistory } from 'prosemirror-history';

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
    const state = EditorState.create({
      schema: composerSchema,
      doc: textToDoc('x [a.ts](src/a.ts)', { reviveMentions: true }),
    });
    const slice = NodeSelection.create(state.doc, 3).content();
    expect(serializeClipboardSlice(slice)).toBe('[a.ts](src/a.ts)');
  });

  it('degrades a quote pill to blockquote + comment, padding only between real neighbors', () => {
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
    const own = composerSchema.nodes.doc.create(null, [
      composerSchema.nodes.paragraph.create(null, composerSchema.text('前文')),
      composerSchema.nodes.paragraph.create(null, quoteNode({ text: '引用' })),
    ]);
    expect(serializeClipboardSlice(own.slice(0, own.content.size))).toBe('前文\n> 引用');
    const head = composerSchema.nodes.doc.create(null, [
      composerSchema.nodes.paragraph.create(null, [quoteNode({ text: '引用' }), composerSchema.text(' 吧')]),
    ]);
    expect(serializeClipboardSlice(head.slice(0, head.content.size))).toBe('> 引用\n\n吧');
  });
});

describe('composerTextDoc — mentions', () => {
  it('serializes file/folder/skill mentions as Markdown links', () => {
    expect(serializeMention({ kind: 'file', name: 'a.ts', path: 'src/a.ts' })).toBe('[a.ts](src/a.ts)');
    expect(serializeMention({ kind: 'folder', name: 'src', path: 'src' })).toBe('[src](src/)');
    expect(serializeMention({ kind: 'folder', name: 'src', path: 'src/' })).toBe('[src](src/)');
    expect(serializeMention({ kind: 'skill', name: 'translator', path: '' })).toBe(
      '[translator](kimi-code://skill/translator)',
    );
  });

  it('keeps a Windows folder’s own trailing separator (no mixed tail glued on)', () => {
    const attrs = { kind: 'folder', name: 'docs', path: 'C:\\docs\\' } as const;
    const wire = serializeMention(attrs);
    expect(wire).toBe('[docs](C:%5Cdocs%5C)');
    expect(parseMentionLinks(wire)).toEqual([{ start: 0, end: wire.length, attrs, rawDest: 'C:%5Cdocs%5C' }]);
  });

  it('canonical-encodes destinations (whitespace, parens, </>), escapes brackets in names', () => {
    expect(serializeMention({ kind: 'file', name: 'a b.ts', path: 'my dir/a b.ts' })).toBe('[a b.ts](my%20dir/a%20b.ts)');
    expect(serializeMention({ kind: 'file', name: 'a]b.ts', path: 'x' })).toBe('[a\\]b.ts](x)');
    expect(serializeMention({ kind: 'file', name: 'a', path: 'x(1)' })).toBe('[a](x%281%29)');
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
    const ser = 'ab[x.ts](a/x.ts)cd';
    expect(docToText(doc)).toBe(ser);
    expect(textOffsetToPos(doc, 0)).toBe(1);
    expect(textOffsetToPos(doc, 2)).toBe(3);
    expect(textOffsetToPos(doc, 3)).toBe(4);
    expect(textOffsetToPos(doc, 16)).toBe(4);
    expect(textOffsetToPos(doc, 18)).toBe(6);
    expect(posToTextOffset(doc, 1)).toBe(0);
    expect(posToTextOffset(doc, 3)).toBe(2);
    expect(posToTextOffset(doc, 4)).toBe(16);
    expect(posToTextOffset(doc, 6)).toBe(18);
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
    expect(docToText(next.doc)).toBe('hello [a.ts](src/a.ts) ');
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
    expect(text.endsWith(' @b')).toBe(true);
  });

  it('breaks `!` and `\\` prefixes with a space so the mention still parses as a link', () => {
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

describe('composerTextDoc — buildTextRangeReplacement (Tab completion)', () => {
  function stateOf(text: string): EditorState {
    return EditorState.create({ schema: composerSchema, doc: textToDoc(text) });
  }

  it('replaces the range and lands the caret after the inserted text', () => {
    const state = stateOf('@fo');
    const next = state.apply(buildTextRangeReplacement(state, 'Folder', { start: 1, end: 3 }));
    expect(docToText(next.doc)).toBe('@Folder');
    expect(posToTextOffset(next.doc, next.selection.from)).toBe('@Folder'.length);
  });

  it('replaces only the token\'s current path segment', () => {
    const state = stateOf('@src/fo done');
    const next = state.apply(buildTextRangeReplacement(state, 'Folder/', { start: 5, end: 7 }));
    expect(docToText(next.doc)).toBe('@src/Folder/ done');
    expect(posToTextOffset(next.doc, next.selection.from)).toBe('@src/Folder/'.length);
  });

  it('an empty range is a pure insertion (bare-@ completion)', () => {
    const state = stateOf('@');
    const next = state.apply(buildTextRangeReplacement(state, 'a.ts', { start: 1, end: 1 }));
    expect(docToText(next.doc)).toBe('@a.ts');
    expect(posToTextOffset(next.doc, next.selection.from)).toBe(5);
  });

  it('inserts link-looking names literally (no pill, no clipboard parse)', () => {
    const state = stateOf('@x');
    const next = state.apply(buildTextRangeReplacement(state, '[a](b)', { start: 1, end: 2 }));
    expect(docToText(next.doc)).toBe('@[a](b)');
    let mentionCount = 0;
    next.doc.descendants((node) => {
      if (node.type.name === 'mention') mentionCount++;
      return true;
    });
    expect(mentionCount).toBe(0);
  });

  it('a completion is its own undo group — one undo keeps the typed token', () => {
    function histStateOf(text: string): EditorState {
      return EditorState.create({ schema: composerSchema, doc: textToDoc(text), plugins: [history()] });
    }
    let state = histStateOf('hello @f');
    state = state.apply(state.tr.insertText('o', 9));
    state = state.apply(buildTextRangeReplacement(state, 'Folder/', { start: 7, end: 9 }));
    expect(docToText(state.doc)).toBe('hello @Folder/');
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(docToText(state.doc)).toBe('hello @fo');
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(docToText(state.doc)).toBe('hello @f');
  });

  it('post-completion typing starts a new group — three units after Tab + type', () => {
    function histStateOf(text: string): EditorState {
      return EditorState.create({ schema: composerSchema, doc: textToDoc(text), plugins: [history()] });
    }
    let state = histStateOf('hello @f');
    state = state.apply(state.tr.insertText('o', 9));
    state = state.apply(buildTextRangeReplacement(state, 'Folder/', { start: 7, end: 9 }));
    state = state.apply(closeHistory(state.tr));
    state = state.apply(state.tr.insertText('x', state.doc.content.size - 1));
    expect(docToText(state.doc)).toBe('hello @Folder/x');
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(docToText(state.doc)).toBe('hello @Folder/');
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(docToText(state.doc)).toBe('hello @fo');
    expect(undo(state, (tr) => { state = state.apply(tr); })).toBe(true);
    expect(docToText(state.doc)).toBe('hello @f');
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
    expect(inlineRunStartOffset(docOf(['hello']), docOf(['hello']).resolve(3))).toBe(0);
  });

  it('caret at a text-node END boundary → start of that text node (not the caret)', () => {
    const doc = docOf(['ab', PILL()]);
    expect(inlineRunStartOffset(doc, doc.resolve(3))).toBe(0);
  });

  it('caret right after a pill → the caret position itself', () => {
    const doc = docOf([PILL(), '']);
    expect(inlineRunStartOffset(doc, doc.resolve(2))).toBe(docToText(doc).length);
  });

  it('caret at paragraph start → 0', () => {
    const doc = docOf(['', PILL(), 'x']);
    expect(inlineRunStartOffset(doc, doc.resolve(1))).toBe(0);
  });

  it('caret at end of a post-pill text run → start of that run', () => {
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
    expect(classifyMentionHref('kimi-code://skill/')).toBeNull();
  });
  it('classifies session links that carry a single session segment', () => {
    expect(classifyMentionHref('kimi-code://sessions/session_1')).toBe('session');
  });
  it('rejects session links without exactly one non-empty segment', () => {
    for (const href of [
      'kimi-code://sessions/',
      'kimi-code://sessions/session_1/',
      'kimi-code://sessions/wd_app_0123456789ab/session_1',
      'kimi-code://sessions/a%2Fb',
      'kimi-code://sessions/session_1?x=1',
      'kimi-code://sessions/session_1#top',
      'kimi-code://session/session_1',
    ]) {
      expect(classifyMentionHref(href), href).toBeNull();
    }
  });
  it('classifies folder links by trailing slash (no query/fragment stripping — folder names may contain them)', () => {
    expect(classifyMentionHref('apps/')).toBe('folder');
    expect(classifyMentionHref('my#dir/')).toBe('folder');
    expect(classifyMentionHref('my?dir/')).toBe('folder');
    expect(classifyMentionHref('apps/#frag')).toBe('file');
  });
  it('classifies Windows directories by a trailing backslash (raw or renderer-encoded)', () => {
    expect(classifyMentionHref('C:\\docs\\')).toBe('folder');
    expect(classifyMentionHref('C:%5Cdocs%5C')).toBe('folder');
    expect(classifyMentionHref('c:%5cdocs%5c')).toBe('folder');
  });
  it('classifies plain paths as files', () => {
    expect(classifyMentionHref('src/a.ts')).toBe('file');
    expect(classifyMentionHref('src/a.ts#L12')).toBe('file');
  });
  it('classifies bare filenames with line suffixes as files, not schemes', () => {
    expect(classifyMentionHref('README.md:78')).toBe('file');
    expect(classifyMentionHref('package.json:10')).toBe('file');
    expect(classifyMentionHref('Makefile:10')).toBe('file');
    expect(classifyMentionHref('LICENSE:2')).toBe('file');
    expect(classifyMentionHref('mailto:78')).toBeNull();
    expect(classifyMentionHref('tel:123')).toBeNull();
    expect(classifyMentionHref('facetime:123')).toBeNull();
    expect(classifyMentionHref('data:123')).toBeNull();
  });
  it('returns null for external/anchor hrefs', () => {
    expect(classifyMentionHref('https://x.com/a')).toBeNull();
    expect(classifyMentionHref('mailto:a@b.c')).toBeNull();
    expect(classifyMentionHref('#anchor')).toBeNull();
    expect(classifyMentionHref('')).toBeNull();
  });
  it('returns null for query-only hrefs (same-page navigation, not a file)', () => {
    expect(classifyMentionHref('?page=2')).toBeNull();
    expect(classifyMentionHref('%3Fnotes.md')).toBe('file');
  });
  it('returns null for protocol-relative URLs (//host/path is a network target, not a file)', () => {
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
  it('strips numeric line suffixes without stripping a Windows drive prefix', () => {
    expect(mentionActionPath('docs/情况.md:78')).toBe('docs/情况.md');
    expect(mentionActionPath('C:/docs/a.ts:78')).toBe('C:/docs/a.ts');
    expect(mentionActionPath('docs/情况.md#L78')).toBe('docs/情况.md');
  });
  it('parses numeric line suffixes and ignores other URL tails', () => {
    expect(mentionActionLine('docs/情况.md:78')).toBe(78);
    expect(mentionActionLine('docs/情况.md#L78')).toBe(78);
    expect(mentionActionLine('docs/情况.md#78')).toBe(78);
    expect(mentionActionLine('C:/docs/a.ts:78')).toBe(78);
    expect(mentionActionLine('README.md#usage')).toBeUndefined();
    expect(mentionActionLine('docs/a.md?plain=1')).toBeUndefined();
    expect(mentionActionLine('docs/a%3A78.md')).toBeUndefined();
    expect(mentionActionLine('site/index.html#78')).toBeUndefined();
    expect(mentionActionLine('site/index.htm#L78')).toBeUndefined();
  });
  it('keeps percent-encoded %23/%3F when applied on the raw href', () => {
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

  it.each(['[foo](docs/foo.ts:78)', '[foo](docs/foo.ts#L78)', '[说明](<docs/my file.ts:78>)'])('preserves an action destination in the wire text: %s', (wire) => {
    const doc = textToDoc(wire, { reviveMentions: true });
    expect(docToText(doc)).toBe(wire);
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
    for (const text of ['![preview](img.png)', 'see ![p](x.png) end', '\\[a.ts](src/a.ts)']) {
      const doc = textToDoc(text, { reviveMentions: true });
      expect(doc.firstChild?.firstChild?.isText).toBe(true);
      expect(docToText(doc)).toBe(text);
      expect(parseMentionLinks(text)).toEqual([]);
    }
    const matches = parseMentionLinks('\\![a.ts](src/a.ts)');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(2);
    expect(matches[0]!.attrs.name).toBe('a.ts');
  });

  it('takes a revived skill’s identity from the link TARGET, not the label', () => {
    const doc = textToDoc('[发布](kimi-code://skill/deploy)', { reviveMentions: true });
    const pill = doc.firstChild?.firstChild;
    expect(pill?.type.name).toBe('mention');
    expect(pill?.attrs).toEqual({ kind: 'skill', name: 'deploy', path: '' });
    expect(docToText(doc)).toBe('[deploy](kimi-code://skill/deploy)');
    expect(collectSkillMentions(doc)[0]?.name).toBe('deploy');
  });

  it('round-trips a session mention: the label is the title and the path is the session id', () => {
    const attrs = { kind: 'session', name: '修复 [登录] 跳转', path: 'session_1' } as const;
    const wire = serializeMention(attrs);
    expect(wire).toBe('[修复 \\[登录\\] 跳转](kimi-code://sessions/session_1)');
    const doc = textToDoc(`see ${wire} now`, { reviveMentions: true });
    expect(doc.firstChild?.child(1).attrs).toEqual(attrs);
    expect(docToText(doc)).toBe(`see ${wire} now`);
    expect(parseMentionLinks(wire)[0]?.attrs).toEqual(attrs);
  });

  it('leaves session links with a malformed target as literal text', () => {
    for (const bad of ['[x](kimi-code://sessions/wd/session_1)', '[x](kimi-code://sessions/)', '[x](kimi-code://session/session_1)', '[x](kimi-code://session/wd/a/b)']) {
      const doc = textToDoc(bad, { reviveMentions: true });
      expect(doc.firstChild?.firstChild?.isText).toBe(true);
      expect(docToText(doc)).toBe(bad);
    }
  });

  it('still reads the earlier <workspaceId>/<sessionId> session links and writes them in the current form', () => {
    const legacy = '[修复登录](kimi-code://session/wd_app_0123456789ab/session_1)';
    expect(classifyMentionHref('kimi-code://session/wd_app_0123456789ab/session_1')).toBe('session');
    expect(parseMentionLinks(legacy)[0]?.attrs).toEqual({ kind: 'session', name: '修复登录', path: 'session_1' });
    const doc = textToDoc(legacy, { reviveMentions: true });
    expect(doc.firstChild?.firstChild?.attrs).toMatchObject({ kind: 'session', path: 'session_1' });
    expect(docToText(doc)).toBe('[修复登录](kimi-code://sessions/session_1)');
  });

  it('turns bare session addresses into session links titled by the resolver', () => {
    const title = (sessionId: string) => (sessionId === 's_1' ? 'Fix [login]' : `Title ${sessionId}`);
    expect(linkBareSessionUrls('see kimi-code://sessions/s_1.', title)).toBe('see [Fix \\[login\\]](kimi-code://sessions/s_1).');
    expect(linkBareSessionUrls('(kimi-code://sessions/s_2)\nkimi-code://sessions/s_3', title))
      .toBe('([Title s_2](kimi-code://sessions/s_2))\n[Title s_3](kimi-code://sessions/s_3)');
    const doc = textToDoc(linkBareSessionUrls('kimi-code://sessions/s_1', title), { reviveMentions: true });
    expect(doc.firstChild?.firstChild?.attrs).toMatchObject({ kind: 'session', name: 'Fix [login]', path: 's_1' });
  });

  it('leaves session addresses inside links and malformed addresses untouched', () => {
    const title = () => 'Title';
    for (const text of [
      '[Alpha](kimi-code://sessions/s_1)',
      '[kimi-code://sessions/s_1](https://example.com)',
      '![shot](kimi-code://sessions/s_1)',
      'kimi-code://sessions/s_1/turns',
      'kimi-code://sessions/s_1?x=1',
      'kimi-code://sessions/s_1#top',
      'kimi-code://sessions/s%2F1',
      'xkimi-code://sessions/s_1',
      'kimi-code://sessions/',
      'kimi-code://session/s_1',
    ]) {
      expect(linkBareSessionUrls(text, title), text).toBe(text);
    }
  });

  it('decodes url-encoded skill names from the target', () => {
    const matches = parseMentionLinks('[label](kimi-code://skill/write%20goal)');
    expect(matches[0]?.attrs).toEqual({ kind: 'skill', name: 'write goal', path: '' });
  });

  it('decodes a skill name with a literal % triplet exactly once (round trip)', () => {
    const attrs = { kind: 'skill', name: 'review%20draft', path: '' } as const;
    const wire = serializeMention(attrs);
    expect(wire).toBe('[review%2520draft](kimi-code://skill/review%2520draft)');
    expect(parseMentionLinks(wire)).toEqual([{ start: 0, end: wire.length, attrs, rawDest: 'kimi-code://skill/review%2520draft' }]);
  });

  it('percent-encodes parens in skill names (CommonMark bare destinations require balanced parens)', () => {
    const attrs = { kind: 'skill', name: 'x(1', path: '' } as const;
    const wire = serializeMention(attrs);
    expect(wire).toBe('[x(1](kimi-code://skill/x%281)');
    expect(parseMentionLinks(wire)).toEqual([{ start: 0, end: wire.length, attrs, rawDest: 'kimi-code://skill/x%281' }]);
    expect(parseMentionLinks('[y(z)](kimi-code://skill/y(z))')[0]?.attrs).toEqual({
      kind: 'skill',
      name: 'y(z)',
      path: '',
    });
  });

  it('round-trips filenames with literal percent triplets (% travels as %25)', () => {
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
    const paths = [
      'plain.md',
      'my dir/a b.md',
      'x(1).md',
      'x(1.md',
      'docs/a<b.md',
      'docs/a>b.md',
      'a<b>c.md',
      'report%final.md',
      'report%20final.md',
      'docs/a#b.md',
      'docs/a?b.md',
      '#notes.md',
      'docs/#notes.md',
      'notes:old.md',
      'http:fixture',
      'docs\nold/a.md',
      'a\nb.md',
      'a%0Ab.md',
      '//mount/file.md',
      'a&amp;b.md',
      'a<b.md',
      'a\\b.md',
      '第一/稿 件.md',
      'emoji 🍱/bento 🍱.md',
      'combining/éclair.md',
    ];
    for (const path of paths) {
      const attrs = { kind: 'file', name: path.split('/').pop()!, path } as const;
      const wire = serializeMention(attrs);
      expect(parseMentionLinks(wire)).toEqual([
        { start: 0, end: wire.length, attrs, rawDest: wire.slice(wire.lastIndexOf('](') + 2, -1) },
      ]);
      const doc = textToDoc(wire, { reviveMentions: true });
      expect(doc.firstChild?.firstChild?.attrs).toEqual(attrs);
      expect(docToText(doc)).toBe(wire);
    }
  });
});

describe('composerTextDoc — unescapeRenderedLinkText (rendered-surface label decode)', () => {
  it('undoes only the serializer percent layers (renderer already ate the backslash layer)', () => {
    expect(unescapeRenderedLinkText('a%2520b.md')).toBe('a%20b.md');
    expect(unescapeRenderedLinkText('a%26amp;b.md')).toBe('a&amp;b.md');
    expect(unescapeRenderedLinkText('a%3Cb.md')).toBe('a<b.md');
    expect(unescapeRenderedLinkText('a%250Ab.md')).toBe('a%0Ab.md');
  });

  it('keeps a literal backslash in the filename (no second CommonMark decode)', () => {
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
    const matches = parseMentionLinks('[文档](my%20file.md)');
    expect(matches).toEqual([
      { start: 0, end: 18, attrs: { kind: 'file', name: '文档', path: 'my file.md' }, rawDest: 'my%20file.md' },
    ]);
    const wire = serializeMention(matches[0]!.attrs);
    expect(parseMentionLinks(wire)[0]!.attrs).toEqual(matches[0]!.attrs);
  });

  it('exposes the raw destination exactly as written (angle brackets stripped, escapes intact)', () => {
    expect(parseMentionLinks('[a](x.md)')[0]?.rawDest).toBe('x.md');
    const escaped = parseMentionLinks('[x(1.md](x\\(1.md)');
    expect(escaped[0]?.rawDest).toBe('x\\(1.md');
    expect(escaped[0]?.attrs.path).toBe('x(1.md');
    const angled = parseMentionLinks('[a b.md](<my dir/a b.md>)');
    expect(angled[0]?.rawDest).toBe('my dir/a b.md');
    expect(angled[0]?.attrs.path).toBe('my dir/a b.md');
  });

  it('never spans a line boundary — parsing is per line, matching textToDoc exactly', () => {
    expect(parseMentionLinks('[foo\nbar](kimi-code://skill/deploy)')).toEqual([]);
    expect(parseMentionLinks('a [x](y)\nb [dir](z/)')).toEqual([
      { start: 2, end: 8, attrs: { kind: 'file', name: 'x', path: 'y' }, rawDest: 'y' },
      { start: 11, end: 20, attrs: { kind: 'folder', name: 'dir', path: 'z/' }, rawDest: 'z/' },
    ]);
  });

  it('an unescaped inner [ invalidates the outer candidate — the inner link wins, the prefix stays literal', () => {
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
    const brackets = '['.repeat(3000);
    const text = `pre ${brackets}[a.ts](src/a.ts) mid ${'[k](<'.repeat(800)} tail`;
    const matches = parseMentionLinks(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.attrs).toEqual({ kind: 'file', name: 'a.ts', path: 'src/a.ts' });
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('[a.ts](src/a.ts)');
    expect(parseMentionLinks('[x]('.repeat(1500))).toEqual([]);
    expect(parseMentionLinks('['.repeat(5000))).toEqual([]);
  });

  it('keeps a link with a TITLE as literal text (the old scanner revived it with the title glued to the path)', () => {
    for (const text of ['[a](b "title")', "[a](b 'title')", '[a](b (title))', '[a](<b> "t")']) {
      expect(parseMentionLinks(text)).toEqual([]);
      const doc = textToDoc(text, { reviveMentions: true });
      expect(docToText(doc)).toBe(text);
    }
  });

  it('keeps reference-style links as literal text', () => {
    for (const text of ['[a][b]', '[a][]', '[a]', '[a][b]\n\n[b]: /url', '[a][]\n\n[a]: /url']) {
      expect(parseMentionLinks(text)).toEqual([]);
      const doc = textToDoc(text, { reviveMentions: true });
      expect(docToText(doc)).toBe(text);
    }
  });

  it('revives link-shaped text inside CODE delimiters too (round-trip invariant)', () => {
    for (const text of ['`[a](b)`', '```\n[a](b)\n```', '    [a](b)']) {
      const matches = parseMentionLinks(text);
      expect(matches).toHaveLength(1);
      expect(matches[0]!.attrs).toEqual({ kind: 'file', name: 'a', path: 'b' });
    }
    const doc = textToDoc('see `[a](b)` end', { reviveMentions: true });
    expect(doc.firstChild?.child(1).type.name).toBe('mention');
    expect(docToText(doc)).toBe('see `[a](b)` end');
    const matches = parseMentionLinks('`x` [a](b)');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(4);
  });

  it('reports mention ranges as UTF-16 offsets into the original text (emoji/CJK)', () => {
    const text = '🍱看 [x](a/b.txt) 和 [发布](kimi-code://skill/deploy)';
    const matches = parseMentionLinks(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.start).toBe(4);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('[x](a/b.txt)');
    expect(matches[0]!.attrs).toEqual({ kind: 'file', name: 'x', path: 'a/b.txt' });
    expect(text.slice(matches[1]!.start, matches[1]!.end)).toBe('[发布](kimi-code://skill/deploy)');
    expect(matches[1]!.attrs).toEqual({ kind: 'skill', name: 'deploy', path: '' });
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
    const hand = splitMentionSegments('[Usage](README.md#usage)')[0];
    if (hand.type !== 'mention') throw new Error('expected a mention segment');
    expect(hand.attrs.path).toBe('README.md#usage');
    expect(mentionHrefToPath(mentionActionPath(hand.rawDest))).toBe('README.md');
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
