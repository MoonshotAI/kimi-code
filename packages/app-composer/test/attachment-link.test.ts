import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import {
  ATTACHMENT_LINK_BASE,
  attachmentNode,
  buildAttachmentInsertion,
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
  splitInlineSegments,
  splitMentionSegments,
  stripAttachmentLinks,
  textOffsetToPos,
  textToDoc,
  type AttachmentAttrs,
} from '../src/composerTextDoc';

const link = (attrs: AttachmentAttrs): string => serializeAttachment(attrs);
const FILE: AttachmentAttrs = { attId: 'abc12345', name: 'a.ts', kind: 'file' };
const FOLDER: AttachmentAttrs = { attId: 'def67890', name: 'src/', kind: 'folder' };

describe('attachment link — serialize', () => {
  it('serializes file/folder attachments as Markdown links with the private scheme', () => {
    expect(link(FILE)).toBe('[a.ts](kimi-code-composer://attachments/abc12345)');
    // The folder's trailing slash lives in the NAME (the label) — the dest
    // carries only the marker + attId.
    expect(link(FOLDER)).toBe('[src/](kimi-code-composer://attachments/def67890)');
  });

  it('escapes the label like any link label', () => {
    expect(link({ attId: 'x', name: 'a[b].md', kind: 'file' })).toBe('[a\\[b\\].md](kimi-code-composer://attachments/x)');
    expect(link({ attId: 'x', name: 'a%20b.md', kind: 'file' })).toBe('[a%2520b.md](kimi-code-composer://attachments/x)');
  });
});

describe('attachment link — parse/serialize round-trip', () => {
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
      // Root folders carry no basename — the root itself is the name, and
      // its trailing '/' must still revive the folder kind.
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
    // Boundary offsets round-trip exactly; interior offsets clamp to the
    // pill's edges (same contract as a mention).
    for (const offset of [0, 1, 2, 3, text.length - 3, text.length - 2, text.length - 1, text.length]) {
      expect(posToTextOffset(doc, textOffsetToPos(doc, offset))).toBe(offset);
    }
    // The pill's serialized form starts at 3; an interior offset clamps to
    // the pill END.
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
    // The caret lands right after the inserted run (pill + space).
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
    // `![…](…)` tokenizes as ONE image construct the wire parser rejects —
    // the editor's own product would never revive nor be rewritten at
    // submit (leaking the private attId into the transcript).
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

describe('rewriteAttachmentLinksForSubmit', () => {
  const A: AttachmentAttrs = { attId: 'aaaaaaaa', name: 'a.pdf', kind: 'file' };
  const B: AttachmentAttrs = { attId: 'bbbbbbbb', name: 'b.pdf', kind: 'file' };

  it('rewrites attIds to 1-based indexes in orderedAttIds order', () => {
    const text = `看 ${link(A)} 和 ${link(B)}`;
    expect(rewriteAttachmentLinksForSubmit(text, ['bbbbbbbb', 'aaaaaaaa'])).toBe(
      `看 [a.pdf](${ATTACHMENT_LINK_BASE}2) 和 [b.pdf](${ATTACHMENT_LINK_BASE}1)`,
    );
  });

  it('gives a repeated attId the same index everywhere', () => {
    const text = `${link(A)} 又 ${link(A)}`;
    expect(rewriteAttachmentLinksForSubmit(text, ['aaaaaaaa'])).toBe(
      `[a.pdf](${ATTACHMENT_LINK_BASE}1) 又 [a.pdf](${ATTACHMENT_LINK_BASE}1)`,
    );
  });

  it('rewrites a folder link to its mention form via resolveFolder', () => {
    const text = `打开 ${link(FOLDER)} 看看`;
    const out = rewriteAttachmentLinksForSubmit(text, ['def67890'], {
      resolveFolder: (attId) => (attId === 'def67890' ? '/abs/src' : undefined),
    });
    // Mention folder form: bare basename label, trailing slash on the dest.
    expect(out).toBe('打开 [src](/abs/src/) 看看');
    // And it parses back as a folder mention, not an attachment.
    expect(parseAttachmentLinks(out)).toEqual([]);
    expect(parseMentionLinks(out)[0]!.attrs).toEqual({ kind: 'folder', name: 'src', path: '/abs/src/' });
  });

  it('leaves a folder link on the index rule when resolveFolder has no path', () => {
    const text = link(FOLDER);
    expect(rewriteAttachmentLinksForSubmit(text, ['def67890'])).toBe(`[src/](${ATTACHMENT_LINK_BASE}1)`);
  });

  it('keeps a root folder’s label non-empty on the mention rewrite (and it parses back as a folder)', () => {
    // POSIX root: stripping the name's trailing '/' would leave an EMPTY
    // label — an unparseable `[](…)` the bubble renders as a Markdown
    // literal — so the root display stays.
    const rootAtt: AttachmentAttrs = { attId: 'rootroot', name: '/', kind: 'folder' };
    const out = rewriteAttachmentLinksForSubmit(`打开 ${link(rootAtt)}`, ['rootroot'], {
      resolveFolder: () => '/',
    });
    expect(out).toBe('打开 [/](/)');
    expect(parseMentionLinks(out)[0]!.attrs).toEqual({ kind: 'folder', name: '/', path: '/' });
    // Windows drive root: the label is the drive letter, the dest the root —
    // with the drive's ':' canonically percent-encoded (escapeLinkDest), and
    // it decodes back to the same folder mention.
    const driveAtt: AttachmentAttrs = { attId: 'drive000', name: 'C:/', kind: 'folder' };
    const outDrive = rewriteAttachmentLinksForSubmit(link(driveAtt), ['drive000'], {
      resolveFolder: () => 'C:/',
    });
    expect(outDrive).toBe('[C:](C%3A/)');
    expect(parseMentionLinks(outDrive)[0]!.attrs).toEqual({ kind: 'folder', name: 'C:', path: 'C:/' });
  });

  it('degrades an unknown attId to the bare name (no scheme, no link syntax)', () => {
    const text = `看 ${link(A)} 吧`;
    expect(rewriteAttachmentLinksForSubmit(text, ['bbbbbbbb'])).toBe('看 a.pdf 吧');
    expect(rewriteAttachmentLinksForSubmit(text, [])).toBe('看 a.pdf 吧');
    // A dead folder pill keeps its trailing slash as the kind marker.
    expect(rewriteAttachmentLinksForSubmit(link(FOLDER), [])).toBe('src/');
  });

  it('never lets a dangling NUMERIC attId alias a rewritten index', () => {
    // A stale `[x.pdf](…/2)` (e.g. from an old history entry) next to a live
    // pill: the live one becomes index 1, and the stale link must NOT stay
    // behind to point at payload position 2 — it degrades to its bare name.
    const text = `${link(A)} 对比 [x.pdf](${ATTACHMENT_LINK_BASE}2)`;
    const out = rewriteAttachmentLinksForSubmit(text, ['aaaaaaaa']);
    expect(out).toBe(`[a.pdf](${ATTACHMENT_LINK_BASE}1) 对比 x.pdf`);
    expect(out).not.toContain('attachments/2');
  });

  it('never touches mention links or plain text', () => {
    const text = '[a.ts](src/a.ts) [deploy](kimi-code://skill/deploy) 普通 (文本)';
    expect(rewriteAttachmentLinksForSubmit(text, ['aaaaaaaa'])).toBe(text);
  });

  it('returns the input unchanged when there are no attachment links', () => {
    expect(rewriteAttachmentLinksForSubmit('hello world', ['aaaaaaaa'])).toBe('hello world');
  });
});

describe('stripAttachmentLinks', () => {
  it('degrades file and folder links to their bare names', () => {
    expect(stripAttachmentLinks(`看 ${link(FILE)} 加 ${link(FOLDER)} 吧`)).toBe('看 a.ts 加 src/ 吧');
  });

  it('strips the submit-time 1..N index links too (the history-recall case)', () => {
    // What history.push stores must not revive dead pills on recall.
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
    // A filename can itself carry Markdown syntax — the export must not let
    // it re-parse as a heading / thematic break / link. (The escaper is the
    // caller's; this only proves the hook runs per degraded link.)
    const escapeHash = (name: string) => name.replace(/#/g, '\\#');
    expect(stripAttachmentLinks(`看 [# notes](${ATTACHMENT_LINK_BASE}aaaaaaaa) 吧`, escapeHash)).toBe('看 \\# notes 吧');
    // Without an escaper the bare name degrades verbatim (existing callers).
    expect(stripAttachmentLinks(`看 [# notes](${ATTACHMENT_LINK_BASE}aaaaaaaa) 吧`)).toBe('看 # notes 吧');
  });
});

describe('removeAttachmentLinks (the bare work-mode command match)', () => {
  it('drops attachment links wholesale, so a command plus only pills still matches bare', () => {
    // `/plan` + a file pill is the bare command (the pill stays pending),
    // not a `/plan file.pdf` args command — degrading to a bare name would
    // leave "args", which is why stripAttachmentLinks can't do this.
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
    // Submit-bound texts are all index-form, but a stray private id must not
    // become an index it never was.
    const text = `看 ${link(FILE)} 吧`;
    expect(offsetAttachmentLinkIndices(text, 5)).toBe(text);
  });

  it('never touches mention links or other text', () => {
    const text = '[a.ts](src/a.ts) [deploy](kimi-code://skill/deploy) 普通 (文本)';
    expect(offsetAttachmentLinkIndices(text, 3)).toBe(text);
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
