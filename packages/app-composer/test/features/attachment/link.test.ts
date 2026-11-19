import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import {
  ATTACHMENT_LINK_BASE,
  attachmentNode,
  buildAttachmentInsertion,
  buildAttachmentWithTextInsertion,
  classifyMentionHref,
  composerSchema,
  docToText,
  offsetAttachmentLinkIndices,
  parseAttachmentLinks,
  parseMentionLinks,
  posToTextOffset,
  removeAttachmentLinks,
  rewriteAttachmentLinksForSubmit,
  serializeAttachment,
  serializeQuote,
  splitInlineSegments,
  splitMentionSegments,
  stripAttachmentLinks,
  textOffsetToPos,
  textToDoc,
  type AttachmentAttrs,
} from '../../../src/model';

const link = (attrs: AttachmentAttrs): string => serializeAttachment(attrs);
const FILE: AttachmentAttrs = { attId: 'abc12345', name: 'a.ts', kind: 'file' };
const FOLDER: AttachmentAttrs = { attId: 'def67890', name: 'src/', kind: 'folder' };

describe('attachment link — serialize', () => {
  it('serializes file/folder attachments as Markdown links with the private scheme', () => {
    expect(link(FILE)).toBe('[a.ts](kimi-code-composer://attachments/abc12345)');
    expect(link(FOLDER)).toBe('[src/](kimi-code-composer://attachments/def67890)');
  });

  it('escapes the label like any link label', () => {
    expect(link({ attId: 'x', name: 'a[b].md', kind: 'file' })).toBe('[a\\[b\\].md](kimi-code-composer://attachments/x)');
    expect(link({ attId: 'x', name: 'a%20b.md', kind: 'file' })).toBe('[a%2520b.md](kimi-code-composer://attachments/x)');
  });
});

describe('attachment link — parse/serialize round-trip', () => {
  it('round-trips an annotated image through a draft and remaps its submitted media index', () => {
    const attrs: AttachmentAttrs = { attId: 'shot1', name: '截图[1].png', kind: 'image', comment: '看这里? 50%\n第二行' };
    const draft = link(attrs);
    const doc = textToDoc(draft, { reviveMentions: true, attachmentKindFor: () => 'image' });
    expect(doc.firstChild?.childCount).toBe(1);
    expect(doc.firstChild?.firstChild?.attrs).toMatchObject(attrs);
    expect(docToText(doc)).toBe(draft);
    const submitted = rewriteAttachmentLinksForSubmit(draft, { fileAttIds: [], mediaAttIds: ['shot1'] });
    expect(parseAttachmentLinks(submitted)[0]?.attrs).toMatchObject({ attId: 'm1', comment: attrs.comment });
    expect(parseAttachmentLinks(offsetAttachmentLinkIndices(submitted, 0, 2))[0]?.attrs).toMatchObject({ attId: 'm3', comment: attrs.comment });
    expect(stripAttachmentLinks(draft)).toBe(`${attrs.name}\n${attrs.comment}`);
  });

  it('does not turn quotes with a source or surrounding text into attachment references', () => {
    expect(parseAttachmentLinks(serializeQuote({ text: link(FILE), source: 'src/a.ts' }))).toEqual([]);
    expect(parseAttachmentLinks(serializeQuote({ text: `看 ${link(FILE)}`, comment: '说明' }))).toEqual([]);
  });
  it('round-trips plain, spaced, parenthesized, non-ASCII and percent names', () => {
    const cases: AttachmentAttrs[] = [
      FILE,
      FOLDER,
      { attId: 'id1', name: 'my file.txt', kind: 'file' },
      { attId: 'id2', name: 'final (v2).txt', kind: 'file' },
      { attId: 'id3', name: '稿件.md', kind: 'file' },
      { attId: 'id4', name: 'a%20b.md', kind: 'file' },
      { attId: 'id5', name: 'a[b].md', kind: 'file' },
      { attId: 'id6', name: '设计稿/', kind: 'folder' },
      { attId: 'id7', name: '/', kind: 'folder' },
      { attId: 'id8', name: 'C:/', kind: 'folder' },
    ];
    for (const attrs of cases) {
      const matches = parseAttachmentLinks(link(attrs));
      expect(matches).toHaveLength(1);
      expect(matches[0]!.attrs).toEqual(attrs);
      expect(matches[0]!.start).toBe(0);
      expect(matches[0]!.end).toBe(link(attrs).length);
    }
  });

  it('keeps the raw (verbatim) destination on the match', () => {
    const match = parseAttachmentLinks(link(FILE))[0]!;
    expect(match.rawDest).toBe(`${ATTACHMENT_LINK_BASE}abc12345`);
  });

  it('rejects an empty attId tail and non-attachment links', () => {
    expect(parseAttachmentLinks('[x](kimi-code-composer://attachments/)')).toEqual([]);
    expect(parseAttachmentLinks('[a.ts](src/a.ts)')).toEqual([]);
    expect(parseAttachmentLinks('[deploy](kimi-code://skill/deploy)')).toEqual([]);
    expect(parseAttachmentLinks('![a.ts](kimi-code-composer://attachments/abc12345)')).toEqual([]);
  });

  it('parses links line by line, rebased onto the original offsets', () => {
    const text = `头部\n中间 ${link(FILE)} 尾`;
    const matches = parseAttachmentLinks(text);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe(link(FILE));
  });
});

describe('attachment link — coexistence with mentions', () => {
  it('classifies an attachment href as a non-mention', () => {
    expect(classifyMentionHref(`${ATTACHMENT_LINK_BASE}abc12345`)).toBe(null);
  });

  it('parseMentionLinks ignores attachment links entirely', () => {
    expect(parseMentionLinks(`看 ${link(FILE)} 吧`)).toEqual([]);
  });

  it('splitMentionSegments keeps attachment links as literal text (back-compat)', () => {
    const text = `看 [a.ts](src/a.ts) 和 ${link(FILE)} 尾`;
    expect(splitMentionSegments(text)).toEqual([
      { type: 'text', value: '看 ' },
      { type: 'mention', attrs: { kind: 'file', name: 'a.ts', path: 'src/a.ts' }, rawDest: 'src/a.ts' },
      { type: 'text', value: ` 和 ${link(FILE)} 尾` },
    ]);
  });

  it('splitInlineSegments segments both pill kinds in one scan, in order', () => {
    const text = `看 [a.ts](src/a.ts) 和 ${link(FILE)} 尾`;
    expect(splitInlineSegments(text)).toEqual([
      { type: 'text', value: '看 ' },
      { type: 'mention', attrs: { kind: 'file', name: 'a.ts', path: 'src/a.ts' }, rawDest: 'src/a.ts' },
      { type: 'text', value: ' 和 ' },
      { type: 'attachment', attrs: FILE, rawDest: `${ATTACHMENT_LINK_BASE}abc12345` },
      { type: 'text', value: ' 尾' },
    ]);
  });
});

describe('attachment node — text ↔ doc', () => {
  it('textToDoc revives mention and attachment links on the same line', () => {
    const text = `看 [a.ts](src/a.ts) 和 ${link(FILE)} 尾`;
    const doc = textToDoc(text, { reviveMentions: true });
    const para = doc.firstChild!;
    const types: string[] = [];
    para.forEach((child) => types.push(child.type.name));
    expect(types).toEqual(['text', 'mention', 'text', 'attachment', 'text']);
    const att = para.child(3);
    expect(att.attrs).toEqual(FILE);
    expect(docToText(doc)).toBe(text);
  });

  it('does not revive without reviveMentions', () => {
    const doc = textToDoc(link(FILE));
    expect(doc.firstChild!.firstChild!.isText).toBe(true);
  });

  it('keeps char offsets consistent across an attachment pill', () => {
    const text = `ab ${link(FILE)} cd`;
    const doc = textToDoc(text, { reviveMentions: true });
    for (const offset of [0, 1, 2, 3, text.length - 3, text.length - 2, text.length - 1, text.length]) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, offset))).toBe(offset);
    }
    expect(posToTextOffset(doc, textOffsetToPos(doc, 6))).toBe(3 + link(FILE).length);
  });

  it('serializes via leafText, so docToText and textBetween stay in sync', () => {
    const doc = textToDoc(`x ${link(FILE)}`, { reviveMentions: true });
    expect(doc.textBetween(0, doc.content.size, '\n')).toBe(`x ${link(FILE)}`);
  });
});

describe('buildAttachmentInsertion', () => {
  it('inserts at the current selection when no range is given, adding a trailing space', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('') });
    const tr = buildAttachmentInsertion(state, FILE);
    const next = state.apply(tr);
    expect(docToText(next.doc)).toBe(`${link(FILE)} `);
    expect(posToTextOffset(next.doc, next.selection.from)).toBe(link(FILE).length + 1);
  });

  it('skips the trailing space when the pill already sits before whitespace', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('a b') });
    const sel = TextSelection.create(state.doc, textOffsetToPos(state.doc, 1));
    const withSel = state.apply(state.tr.setSelection(sel));
    const next = withSel.apply(buildAttachmentInsertion(withSel, FILE));
    expect(docToText(next.doc)).toBe(`a${link(FILE)} b`);
  });

  it('replaces a char-offset range when one is given', () => {
    const text = 'att @tok end';
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc(text) });
    const next = state.apply(buildAttachmentInsertion(state, FILE, { start: 4, end: 8 }));
    expect(docToText(next.doc)).toBe(`att ${link(FILE)} end`);
  });

  it('breaks a `!` prefix with a space so the pill still parses as a link (not an image)', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('!') });
    const next = state.apply(buildAttachmentInsertion(state, FILE, { start: 1, end: 1 }));
    expect(docToText(next.doc)).toBe(`! ${link(FILE)} `);
    expect(parseAttachmentLinks(docToText(next.doc))).toHaveLength(1);
  });

  it('breaks a `\\` prefix with a space so the pill’s `[` is not escaped', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('\\') });
    const next = state.apply(buildAttachmentInsertion(state, FILE, { start: 1, end: 1 }));
    expect(docToText(next.doc)).toBe(`\\ ${link(FILE)} `);
    expect(parseAttachmentLinks(docToText(next.doc))).toHaveLength(1);
  });

  it('adds no separator at a normal position (no prefix to break)', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('ab') });
    const next = state.apply(buildAttachmentInsertion(state, FILE, { start: 2, end: 2 }));
    expect(docToText(next.doc)).toBe(`ab${link(FILE)} `);
  });
});

describe('buildAttachmentWithTextInsertion', () => {
  it.each([
    ['look', 'tail'],
    ['look ', 'tail'],
    ['look', ' tail'],
    ['look', '\ntail'],
    ['look\n', 'tail'],
  ])('bundles comment %j without changing following text %j', (comment, tail) => {
    const doc = textToDoc('before ' + tail);
    const state = EditorState.create({ schema: composerSchema, doc });
    const next = state.apply(buildAttachmentWithTextInsertion(state, FILE, comment, 'before '.length));
    expect(docToText(next.doc)).toBe(`before ${link({ ...FILE, comment })}${/^\s/.test(tail) ? '' : ' '}${tail}`);
  });

  it('separates a comment from text after the replaced selection', () => {
    const doc = textToDoc('before replace tail');
    const state = EditorState.create({
      schema: composerSchema, doc,
      selection: TextSelection.create(doc, textOffsetToPos(doc, 7), textOffsetToPos(doc, 15)),
    });
    const next = state.apply(buildAttachmentWithTextInsertion(state, FILE, 'look'));
    expect(docToText(next.doc)).toBe(`before ${link({ ...FILE, comment: 'look' })} tail`);
  });

  it('inserts the attachment and comment in one transaction', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('before ') });
    const tr = buildAttachmentWithTextInsertion(state, FILE, '请关注这个错误', 'before '.length);
    const next = state.apply(tr);
    expect(docToText(next.doc)).toBe(`before ${link({ ...FILE, comment: '请关注这个错误' })} `);
    const nodes = next.doc.firstChild!;
    expect(nodes.childCount).toBe(3);
    expect(nodes.child(1).type.name).toBe('attachment');
    expect(nodes.child(1).attrs.comment).toBe('请关注这个错误');
    expect(nodes.child(2).text).toBe(' ');
  });

  it('does not add an empty comment paragraph', () => {
    const state = EditorState.create({ schema: composerSchema, doc: textToDoc('') });
    const next = state.apply(buildAttachmentWithTextInsertion(state, FILE, ''));
    expect(docToText(next.doc)).toBe(`${link(FILE)} `);
  });
});

describe('rewriteAttachmentLinksForSubmit', () => {
  const A: AttachmentAttrs = { attId: 'aaaaaaaa', name: 'a.pdf', kind: 'file' };
  const B: AttachmentAttrs = { attId: 'bbbbbbbb', name: 'b.pdf', kind: 'file' };

  it('rewrites attIds to 1-based indexes in orderedAttIds order', () => {
    const text = `看 ${link(A)} 和 ${link(B)}`;
    expect(rewriteAttachmentLinksForSubmit(text, { fileAttIds: ['bbbbbbbb', 'aaaaaaaa'], mediaAttIds: [] })).toBe(
      `看 [a.pdf](${ATTACHMENT_LINK_BASE}2) 和 [b.pdf](${ATTACHMENT_LINK_BASE}1)`,
    );
  });

  it('gives a repeated attId the same index everywhere', () => {
    const text = `${link(A)} 又 ${link(A)}`;
    expect(rewriteAttachmentLinksForSubmit(text, { fileAttIds: ['aaaaaaaa'], mediaAttIds: [] })).toBe(
      `[a.pdf](${ATTACHMENT_LINK_BASE}1) 又 [a.pdf](${ATTACHMENT_LINK_BASE}1)`,
    );
  });

  it('rewrites a folder link to its mention form via resolveFolder', () => {
    const text = `打开 ${link(FOLDER)} 看看`;
    const out = rewriteAttachmentLinksForSubmit(text, { fileAttIds: ['def67890'], mediaAttIds: [] }, {
      resolveFolder: (attId) => (attId === 'def67890' ? '/abs/src' : undefined),
    });
    expect(out).toBe('打开 [src](/abs/src/) 看看');
    expect(parseAttachmentLinks(out)).toEqual([]);
    expect(parseMentionLinks(out)[0]!.attrs).toEqual({ kind: 'folder', name: 'src', path: '/abs/src/' });
  });

  it('leaves a folder link on the index rule when resolveFolder has no path', () => {
    const text = link(FOLDER);
    expect(rewriteAttachmentLinksForSubmit(text, { fileAttIds: ['def67890'], mediaAttIds: [] })).toBe(`[src/](${ATTACHMENT_LINK_BASE}1)`);
  });

  it('keeps a root folder’s label non-empty on the mention rewrite (and it parses back as a folder)', () => {
    const rootAtt: AttachmentAttrs = { attId: 'rootroot', name: '/', kind: 'folder' };
    const out = rewriteAttachmentLinksForSubmit(`打开 ${link(rootAtt)}`, { fileAttIds: ['rootroot'], mediaAttIds: [] }, {
      resolveFolder: () => '/',
    });
    expect(out).toBe('打开 [/](/)');
    expect(parseMentionLinks(out)[0]!.attrs).toEqual({ kind: 'folder', name: '/', path: '/' });
    const driveAtt: AttachmentAttrs = { attId: 'drive000', name: 'C:/', kind: 'folder' };
    const outDrive = rewriteAttachmentLinksForSubmit(link(driveAtt), { fileAttIds: ['drive000'], mediaAttIds: [] }, {
      resolveFolder: () => 'C:/',
    });
    expect(outDrive).toBe('[C:](C:/)');
    expect(parseMentionLinks(outDrive)[0]!.attrs).toEqual({ kind: 'folder', name: 'C:', path: 'C:/' });
  });

  it('degrades an unknown attId to the bare name (no scheme, no link syntax)', () => {
    const text = `看 ${link(A)} 吧`;
    expect(rewriteAttachmentLinksForSubmit(text, { fileAttIds: ['bbbbbbbb'], mediaAttIds: [] })).toBe('看 a.pdf 吧');
    expect(rewriteAttachmentLinksForSubmit(text, { fileAttIds: [], mediaAttIds: [] })).toBe('看 a.pdf 吧');
    expect(rewriteAttachmentLinksForSubmit(link(FOLDER), { fileAttIds: [], mediaAttIds: [] })).toBe('src/');
  });

  it('never lets a dangling NUMERIC attId alias a rewritten index', () => {
    const text = `${link(A)} 对比 [x.pdf](${ATTACHMENT_LINK_BASE}2)`;
    const out = rewriteAttachmentLinksForSubmit(text, { fileAttIds: ['aaaaaaaa'], mediaAttIds: [] });
    expect(out).toBe(`[a.pdf](${ATTACHMENT_LINK_BASE}1) 对比 x.pdf`);
    expect(out).not.toContain('attachments/2');
  });

  it('never touches mention links or plain text', () => {
    const text = '[a.ts](src/a.ts) [deploy](kimi-code://skill/deploy) 普通 (文本)';
    expect(rewriteAttachmentLinksForSubmit(text, { fileAttIds: ['aaaaaaaa'], mediaAttIds: [] })).toBe(text);
  });

  it('rewrites media links to the m-prefixed media family (files keep the legacy 1..N)', () => {
    const M1: AttachmentAttrs = { attId: 'mediaaaa1', name: 'a.png', kind: 'image' };
    const M2: AttachmentAttrs = { attId: 'mediabbb2', name: 'b.mp4', kind: 'video' };
    const text = `看 ${link(A)} ${link(M1)} ${link(B)} ${link(M2)}`;
    const out = rewriteAttachmentLinksForSubmit(text, {
      fileAttIds: ['aaaaaaaa', 'bbbbbbbb'],
      mediaAttIds: ['mediaaaa1', 'mediabbb2'],
    });
    expect(out).toBe(
      `看 [a.pdf](${ATTACHMENT_LINK_BASE}1) [a.png](${ATTACHMENT_LINK_BASE}m1) [b.pdf](${ATTACHMENT_LINK_BASE}2) [b.mp4](${ATTACHMENT_LINK_BASE}m2)`,
    );
    expect(rewriteAttachmentLinksForSubmit(`[a.pdf](${ATTACHMENT_LINK_BASE}1)`, { fileAttIds: ['x'], mediaAttIds: [] })).toBe('a.pdf');
    expect(rewriteAttachmentLinksForSubmit(`[a.png](${ATTACHMENT_LINK_BASE}m1)`, { fileAttIds: [], mediaAttIds: ['x'] })).toBe('a.png');
  });

  it('returns the input unchanged when there are no attachment links', () => {
    expect(rewriteAttachmentLinksForSubmit('hello world', { fileAttIds: ['aaaaaaaa'], mediaAttIds: [] })).toBe('hello world');
  });
});

describe('stripAttachmentLinks', () => {
  it('degrades file and folder links to their bare names', () => {
    expect(stripAttachmentLinks(`看 ${link(FILE)} 加 ${link(FOLDER)} 吧`)).toBe('看 a.ts 加 src/ 吧');
  });

  it('strips the submit-time 1..N index links too (the history-recall case)', () => {
    const stripped = stripAttachmentLinks(
      `对比 [a.pdf](${ATTACHMENT_LINK_BASE}1) 和 [b.pdf](${ATTACHMENT_LINK_BASE}2)`,
    );
    expect(stripped).toBe('对比 a.pdf 和 b.pdf');
    expect(stripped).not.toContain(ATTACHMENT_LINK_BASE);
    expect(parseAttachmentLinks(stripped)).toEqual([]);
  });

  it('never touches mention links or other text', () => {
    const text = '[a.ts](src/a.ts) [deploy](kimi-code://skill/deploy) 普通 (文本)';
    expect(stripAttachmentLinks(text)).toBe(text);
  });

  it('returns the input unchanged when there are no attachment links', () => {
    expect(stripAttachmentLinks('hello world')).toBe('hello world');
  });

  it('runs the bare name through the surface escaper when one is given (the Markdown export case)', () => {
    const escapeHash = (name: string) => name.replace(/#/g, '\\#');
    expect(stripAttachmentLinks(`看 [# notes](${ATTACHMENT_LINK_BASE}aaaaaaaa) 吧`, escapeHash)).toBe('看 \\# notes 吧');
    expect(stripAttachmentLinks(`看 [# notes](${ATTACHMENT_LINK_BASE}aaaaaaaa) 吧`)).toBe('看 # notes 吧');
  });
});

describe('removeAttachmentLinks (the bare work-mode command match)', () => {
  it('drops attachment links wholesale, so a command plus only pills still matches bare', () => {
    const text = `/plan ${link(FILE)}`;
    expect(removeAttachmentLinks(text).trim()).toBe('/plan');
    expect(removeAttachmentLinks(`${link(FOLDER)} /goal`).trim()).toBe('/goal');
    expect(removeAttachmentLinks(`/swarm ${link(FILE)} ${link(FOLDER)}`).trim()).toBe('/swarm');
  });

  it('keeps real args, so a command with pills AND text is no bare match', () => {
    const text = `/plan ${link(FILE)} do it`;
    expect(removeAttachmentLinks(text).trim()).toBe('/plan  do it');
    expect(removeAttachmentLinks(text).trim()).not.toBe('/plan');
  });

  it('never touches mention links or other text', () => {
    const text = '/btw [a.ts](src/a.ts) [deploy](kimi-code://skill/deploy) 普通 (文本)';
    expect(removeAttachmentLinks(text)).toBe(text);
    expect(removeAttachmentLinks('hello world')).toBe('hello world');
  });
});

describe('offsetAttachmentLinkIndices (the steer merge renumbering)', () => {
  it('shifts 1-based index links by the offset', () => {
    const text = `看 [a.pdf](${ATTACHMENT_LINK_BASE}1) 和 [b.pdf](${ATTACHMENT_LINK_BASE}2)`;
    expect(offsetAttachmentLinkIndices(text, 2)).toBe(
      `看 [a.pdf](${ATTACHMENT_LINK_BASE}3) 和 [b.pdf](${ATTACHMENT_LINK_BASE}4)`,
    );
  });

  it('is a no-op for a zero/negative offset and for link-free text', () => {
    const text = `看 [a.pdf](${ATTACHMENT_LINK_BASE}1)`;
    expect(offsetAttachmentLinkIndices(text, 0)).toBe(text);
    expect(offsetAttachmentLinkIndices(text, -1)).toBe(text);
    expect(offsetAttachmentLinkIndices('hello world', 3)).toBe('hello world');
  });

  it('never renumbers a composer-private (non-index) attId', () => {
    const text = `看 ${link(FILE)} 吧`;
    expect(offsetAttachmentLinkIndices(text, 5)).toBe(text);
  });

  it('never touches mention links or other text', () => {
    const text = '[a.ts](src/a.ts) [deploy](kimi-code://skill/deploy) 普通 (文本)';
    expect(offsetAttachmentLinkIndices(text, 3)).toBe(text);
  });

  it('shifts m-prefixed media links by the media offset only', () => {
    const text = `看 [a.png](${ATTACHMENT_LINK_BASE}m1) 和 [b.pdf](${ATTACHMENT_LINK_BASE}1)`;
    expect(offsetAttachmentLinkIndices(text, 2, 1)).toBe(
      `看 [a.png](${ATTACHMENT_LINK_BASE}m2) 和 [b.pdf](${ATTACHMENT_LINK_BASE}3)`,
    );
    expect(offsetAttachmentLinkIndices(text, 0, 1)).toBe(
      `看 [a.png](${ATTACHMENT_LINK_BASE}m2) 和 [b.pdf](${ATTACHMENT_LINK_BASE}1)`,
    );
    expect(offsetAttachmentLinkIndices(text, 2, 0)).toBe(
      `看 [a.png](${ATTACHMENT_LINK_BASE}m1) 和 [b.pdf](${ATTACHMENT_LINK_BASE}3)`,
    );
  });

  it('shifts generated media labels together with their attachment indexes', () => {
    const text =
      `[Image 1](${ATTACHMENT_LINK_BASE}m1) ` +
      `[视频 2](${ATTACHMENT_LINK_BASE}m2) ` +
      `[reference 7](${ATTACHMENT_LINK_BASE}m2)`;
    expect(offsetAttachmentLinkIndices(text, 0, 3)).toBe(
      `[Image 4](${ATTACHMENT_LINK_BASE}m4) ` +
      `[视频 5](${ATTACHMENT_LINK_BASE}m5) ` +
      `[reference 7](${ATTACHMENT_LINK_BASE}m5)`,
    );
  });
});

describe('attachment node — schema contract', () => {
  it('builds an atom node with the pill attrs', () => {
    const node = attachmentNode(FILE);
    expect(node.type).toBe(composerSchema.nodes.attachment);
    expect(node.isAtom).toBe(true);
    expect(node.attrs).toEqual(FILE);
  });
});


it('serializes media names with the current order and locale without changing the source text', () => {
  const text = `[Image 1](${ATTACHMENT_LINK_BASE}image) [Video 2](${ATTACHMENT_LINK_BASE}video)`;
  const serialized = rewriteAttachmentLinksForSubmit(text, {
    fileAttIds: [], mediaAttIds: ['video', 'image'],
  }, { resolveMediaName: (id, ordinal) => `${id === 'image' ? '图片' : '视频'} ${ordinal}` });
  expect(serialized).toBe(`[图片 2](${ATTACHMENT_LINK_BASE}m2) [视频 1](${ATTACHMENT_LINK_BASE}m1)`);
  expect(text).toBe(`[Image 1](${ATTACHMENT_LINK_BASE}image) [Video 2](${ATTACHMENT_LINK_BASE}video)`);
});
