import { afterEach, describe, expect, it } from 'vitest';
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import {
  ATTACHMENT_LINK_BASE,
  attachmentNode,
  composerSchema,
  degradeForeignAttachmentLinks,
  docToText,
  parseClipboardText,
  serializeAttachment,
  serializeClipboardSlice,
  serializeQuote,
  splitInlineSegments,
  textToDoc,
  type AttachmentAttrs,
} from '../src/composerTextDoc';
import {
  attachmentRegistryKey,
  buildAttachmentClipboardPaste,
  buildComposerClipboardCopy,
  buildMessageCopyFlavor,
  clearComposerFlavorVault,
  createAttachmentRegistryPlugin,
  messageCopyEntryFor,
  parseComposerClipboardPayload,
  remapSliceAttachments,
  resolveComposerClipboardMime,
  sliceAttachmentAttIds,
  stashComposerFlavor,
  type AttachmentEntry,
  type AttachmentRegistryCommand,
} from '../src/attachmentRegistry';

const FILE: AttachmentAttrs = { attId: 'abc12345', name: 'a.ts', kind: 'file' };
const FOLDER: AttachmentAttrs = { attId: 'def67890', name: 'src/', kind: 'folder' };
const link = (attrs: AttachmentAttrs): string => serializeAttachment(attrs);
const quoteLink = (text: string): string => serializeQuote({ text });

function entry(partial: Partial<AttachmentEntry> & { attId: string }): AttachmentEntry {
  return {
    key: `blob:${partial.attId}`,
    kind: 'file',
    name: `${partial.attId}.ts`,
    refCount: 0,
    uploading: false,
    ...partial,
  };
}

function createState(text: string, opts?: { entries?: AttachmentEntry[] }): EditorState {
  return EditorState.create({
    schema: composerSchema,
    doc: textToDoc(text, { reviveMentions: true }),
    plugins: [createAttachmentRegistryPlugin({ initialEntries: opts?.entries })],
  });
}

function registry(state: EditorState): Map<string, AttachmentEntry> {
  return attachmentRegistryKey.getState(state)!;
}

/** The copy-side flavor product for a full-content selection, going through
 *  the same buildComposerClipboardCopy the editor's copy handler uses (kept
 *  DOM-free here). The selection sits INSIDE the first paragraph (like a
 *  real in-editor drag selection), so the slice carries open sides and the
 *  paste merges inline. */
function flavorJson(state: EditorState, entries?: AttachmentEntry[]): string {
  const selected = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)),
  );
  const byAttId = new Map((entries ?? []).map((e) => [e.attId, e] as const));
  const copy = buildComposerClipboardCopy(selected.selection.content(), (attId) => byAttId.get(attId));
  if (!copy) throw new Error('the fixture selection must cover an attachment pill');
  return copy.flavor;
}

describe('serializeClipboardSlice — attachment branch', () => {
  it('degrades a top-level attachment (NodeSelection copy) to its bare name', () => {
    const state = createState(`x ${link(FILE)}`);
    // The pill sits right after the 'x ' text run, at position 3.
    const slice = NodeSelection.create(state.doc, 3).content();
    expect(serializeClipboardSlice(slice)).toBe('a.ts');
  });

  it('keeps the folder name’s trailing slash as the kind marker', () => {
    const state = createState(`x ${link(FOLDER)}`);
    const slice = NodeSelection.create(state.doc, 3).content();
    expect(serializeClipboardSlice(slice)).toBe('src/');
  });

  it('degrades an attachment to its bare name INSIDE a paragraph too (no scheme leak)', () => {
    // textBetween would consult leafText and emit the composer-private
    // attId link — the per-child walk must not (§6.5: plaintext never
    // carries the scheme).
    const doc = textToDoc(`x ${link(FILE)} 加 ${link(FOLDER)}`, { reviveMentions: true });
    expect(serializeClipboardSlice(doc.slice(0, doc.content.size))).toBe('x a.ts 加 src/');
  });

  it('mixes top-level mentions (link) and attachments (name)', () => {
    const slice = new Slice(
      Fragment.fromArray([
        composerSchema.nodes.mention.create({ kind: 'file', name: 'm.ts', path: 'src/m.ts' }),
        attachmentNode(FOLDER),
      ]),
      0,
      0,
    );
    expect(serializeClipboardSlice(slice)).toBe('[m.ts](src/m.ts)\nsrc/');
  });
});

describe('buildComposerClipboardCopy — the copy handler’s DOM-free products', () => {
  const byAttId = (...entries: AttachmentEntry[]) => {
    const map = new Map(entries.map((e) => [e.attId, e] as const));
    return (attId: string) => map.get(attId);
  };

  it('returns null when the slice holds no attachment (PM’s built-in copy keeps ownership)', () => {
    expect(buildComposerClipboardCopy(parseClipboardText('plain text'), byAttId())).toBeNull();
    expect(
      buildComposerClipboardCopy(parseClipboardText('[m.ts](src/m.ts)', { reviveMentions: true }), byAttId()),
    ).toBeNull();
  });

  it('builds all three flavors’ DOM-free parts for an attachment selection', () => {
    const state = createState(`看 ${link(FILE)} 吧`, {
      entries: [entry({ attId: FILE.attId, path: '/w/a.ts', key: 'file:///w/a.ts', name: 'a.ts' })],
    });
    const selected = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)),
    );
    const copy = buildComposerClipboardCopy(
      selected.selection.content(),
      (attId) => attachmentRegistryKey.getState(selected)?.get(attId),
    )!;
    expect(copy).not.toBeNull();
    // text/plain: the pill degrades to its bare name even mid-paragraph.
    expect(copy.plain).toBe('看 a.ts 吧');
    // The custom flavor parses back and carries the referenced entry.
    const parsed = parseComposerClipboardPayload(copy.flavor)!;
    expect(parsed).not.toBeNull();
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ attId: FILE.attId, path: '/w/a.ts' });
  });

  it('carries entries in first-mention order, deduped, and skips pills the registry doesn’t know', () => {
    const text = `${link(FILE)} ${link(FOLDER)} ${link(FILE)}`;
    const slice = parseClipboardText(text, { reviveMentions: true });
    const copy = buildComposerClipboardCopy(
      slice,
      byAttId(entry({ attId: FOLDER.attId, kind: 'folder', name: 'src/' })), // FILE has no entry
    )!;
    const parsed = parseComposerClipboardPayload(copy.flavor)!;
    expect(parsed.attachments.map((e) => e.attId)).toEqual([FOLDER.attId]);
    expect(copy.plain).toBe('a.ts src/ a.ts');
  });

  it('builds the flavor for a QUOTE-ONLY selection (self-contained, no entries)', () => {
    const state = createState(`看 ${quoteLink('多行\n引用')} 吧`);
    const selected = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)),
    );
    const copy = buildComposerClipboardCopy(selected.selection.content(), byAttId())!;
    expect(copy).not.toBeNull();
    // text/plain degrades the quote to its canonical `> ` blockquote lines
    // (the quote branch of serializeClipboardSlice — block-bounded inside the
    // paragraph, no scheme leaks).
    expect(copy.plain).toBe('看\n\n> 多行\n> 引用\n\n吧');
    // Quotes are self-contained: the flavor carries NO registry entries.
    const parsed = parseComposerClipboardPayload(copy.flavor)!;
    expect(parsed).not.toBeNull();
    expect(parsed.attachments).toEqual([]);
  });

  it('quote-only copy → paste round-trips the pill (a re-send still rewrites to a `> ` block)', () => {
    const source = createState(quoteLink('引用'));
    const flavor = flavorJson(source);
    const target = createState('');
    const tr = buildAttachmentClipboardPaste(target, flavor)!;
    expect(tr).not.toBeNull();
    const next = target.apply(tr);
    // The pasted doc re-serializes to the same quote link — the atom survived
    // instead of degrading to plain text.
    expect(docToText(next.doc)).toBe(quoteLink('引用'));
  });
});

describe('parseComposerClipboardPayload', () => {
  it('round-trips a real slice and its entries', () => {
    const slice = parseClipboardText(`看 ${link(FILE)} 吧`, { reviveMentions: true });
    const json = JSON.stringify({ v: 1, slice: slice.toJSON(), attachments: [entry({ attId: FILE.attId, refCount: 7 })] });
    const parsed = parseComposerClipboardPayload(json)!;
    expect(parsed).not.toBeNull();
    // The slice itself survives intact (serializeClipboardSlice degrades the
    // pill to its bare name — the wire form round-trips via docToText).
    expect(docToText(composerSchema.nodes.doc.create(null, parsed.slice.content))).toBe(`看 ${link(FILE)} 吧`);
    expect(parsed.slice.openStart).toBe(slice.openStart);
    // The entry payload’s refCount is normalized to 0 (the reconcile owns it),
    // and the pasted pill is stamped as a new add (see the seq rule below).
    expect(parsed.attachments).toEqual([{ ...entry({ attId: FILE.attId }), seq: expect.any(Number) }]);
  });

  it('adopts a numeric seq from the flavor and stamps a fresh one when absent', () => {
    // A same-doc copy keeps its original add-order stamp; a foreign entry
    // without one joins the add-order clock at paste time.
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [
          entry({ attId: 'aaaaaaaa', seq: 42 }),
          entry({ attId: 'bbbbbbbb' }),
        ],
      }),
    )!;
    expect(parsed.attachments[0]!.seq).toBe(42);
    expect(parsed.attachments[1]!.seq).toEqual(expect.any(Number));
    expect(parsed.attachments[1]!.seq).not.toBe(42);
  });

  it('defaults a missing attachments array to []', () => {
    const slice = parseClipboardText('plain', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(JSON.stringify({ v: 1, slice: slice.toJSON() }))!;
    expect(parsed.attachments).toEqual([]);
  });

  it('rejects non-JSON, wrong version, and a missing slice', () => {
    expect(parseComposerClipboardPayload('not json')).toBeNull();
    expect(parseComposerClipboardPayload(JSON.stringify({ v: 2, slice: {} }))).toBeNull();
    expect(parseComposerClipboardPayload(JSON.stringify({ v: 1 }))).toBeNull();
    expect(parseComposerClipboardPayload(JSON.stringify(null))).toBeNull();
  });

  it('rejects a slice that does not deserialize against the composer schema', () => {
    expect(
      parseComposerClipboardPayload(JSON.stringify({ v: 1, slice: { content: [{ type: 'nope' }] } })),
    ).toBeNull();
  });

  it('drops malformed entries but keeps the well-formed ones', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [
          entry({ attId: 'aaaaaaaa' }),
          { attId: 'bbbbbbbb' }, // missing key/name/kind
          'garbage',
          null,
        ],
      }),
    )!;
    expect(parsed.attachments).toEqual([{ ...entry({ attId: 'aaaaaaaa' }), seq: expect.any(Number) }]);
  });

  it('narrows optional fields by type — injected non-string/non-number values don’t pass through', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [
          {
            attId: 'aaaaaaaa',
            key: 'blob:aaaaaaaa',
            kind: 'file',
            name: 'a.ts',
            size: '1024', // not a number → undefined
            mediaType: ['text/plain'], // not a string → undefined
            path: { evil: true }, // not a string → undefined
            fileId: 42, // not a string → undefined
            error: ['x'], // not a string → undefined
            refCount: 99, // always normalized to 0
            uploading: 'yes', // not === true → false
          },
        ],
      }),
    )!;
    expect(parsed.attachments).toEqual([
      {
        attId: 'aaaaaaaa',
        key: 'blob:aaaaaaaa',
        kind: 'file',
        name: 'a.ts',
        size: undefined,
        mediaType: undefined,
        seq: expect.any(Number),
        path: undefined,
        refCount: 0,
        uploading: false,
        fileId: undefined,
        error: undefined,
      },
    ]);
  });

  it('rejects entries whose attId is outside the wire-safe alphabet', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [
          entry({ attId: 'abc)1234' }), // ')' would break the bare link dest
          entry({ attId: 'ABC12345' }), // uppercase is not base36
          entry({ attId: '' }), // empty
          entry({ attId: 'a'.repeat(65) }), // over the 64-char cap
          entry({ attId: 'ok123ok' }),
        ],
      }),
    )!;
    expect(parsed.attachments.map((e) => e.attId)).toEqual(['ok123ok']);
  });

  it('rejects an oversized flavor before parsing', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const json = JSON.stringify({ v: 1, slice: slice.toJSON(), pad: 'x'.repeat(1024 * 1024) });
    expect(json.length).toBeGreaterThan(1024 * 1024);
    expect(parseComposerClipboardPayload(json)).toBeNull();
  });

  it('normalizes an entry pasted mid-upload to upload-interrupted (the send gate can’t jam)', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [entry({ attId: 'aaaaaaaa', uploading: true })],
      }),
    )!;
    expect(parsed.attachments[0]).toMatchObject({
      uploading: false,
      fileId: undefined,
      error: 'upload-interrupted',
    });
  });

  it('keeps a completed upload’s fileId without flagging an error', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [entry({ attId: 'aaaaaaaa', uploading: true, fileId: 'fid-1' })],
      }),
    )!;
    expect(parsed.attachments[0]).toMatchObject({ uploading: false, fileId: 'fid-1', error: undefined });
  });

  it('keeps an explicit error string as-is', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [entry({ attId: 'aaaaaaaa', uploading: true, error: 'upload-failed' })],
      }),
    )!;
    expect(parsed.attachments[0]).toMatchObject({ uploading: false, error: 'upload-failed' });
  });
});

describe('remapSliceAttachments', () => {
  it('returns the same slice when the remap is empty', () => {
    const slice = parseClipboardText(link(FILE), { reviveMentions: true });
    expect(remapSliceAttachments(slice, {})).toBe(slice);
  });

  it('rewrites attachment attIds and preserves open sides', () => {
    const slice = parseClipboardText(`x ${link(FILE)}\n${link(FOLDER)}`, { reviveMentions: true });
    const remapped = remapSliceAttachments(slice, { abc12345: 'newid000' });
    expect(remapped.openStart).toBe(slice.openStart);
    expect(remapped.openEnd).toBe(slice.openEnd);
    expect(remapped.toJSON()).toEqual(
      parseClipboardText(`x [a.ts](${ATTACHMENT_LINK_BASE}newid000)\n${link(FOLDER)}`, { reviveMentions: true }).toJSON(),
    );
  });
});

describe('buildAttachmentClipboardPaste', () => {
  /** Paste target state with the caret at the document end. */
  function pasteState(text: string, opts?: { entries?: AttachmentEntry[] }): EditorState {
    const state = createState(text, opts);
    return state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  }

  it('inserts the slice and upserts the entries in ONE transaction (reconcile counts them)', () => {
    const copy = createState(link(FILE));
    const json = flavorJson(copy, [entry({ attId: FILE.attId, path: '/w/a.ts', key: 'file:///w/a.ts', name: 'a.ts' })]);
    const paste = pasteState('ab');
    const tr = buildAttachmentClipboardPaste(paste, json)!;
    expect(tr).not.toBeNull();
    const next = paste.apply(tr);
    expect(docToText(next.doc)).toBe(`ab${link(FILE)}`);
    const e = registry(next).get(FILE.attId)!;
    expect(e.path).toBe('/w/a.ts');
    expect(e.refCount).toBe(1);
  });

  it('falls back (null) on an unparseable flavor', () => {
    expect(buildAttachmentClipboardPaste(createState(''), 'junk')).toBeNull();
    expect(buildAttachmentClipboardPaste(createState(''), JSON.stringify({ v: 2 }))).toBeNull();
  });

  it('same key + different attId: the pasted pill adopts the existing entry’s id', () => {
    const existing = entry({ attId: 'existing', path: '/w/a.ts', key: 'file:///w/a.ts', name: 'a.ts' });
    const copy = createState(link({ attId: 'other000', name: 'a.ts', kind: 'file' }));
    const json = flavorJson(copy, [entry({ attId: 'other000', path: '/w/a.ts', key: 'file:///w/a.ts', name: 'a.ts' })]);
    // The paste target already references the entry (unreferenced entries
    // are dropped on init — see the registry's reconcile contract).
    const paste = pasteState(link({ attId: 'existing', name: 'a.ts', kind: 'file' }), { entries: [existing] });
    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);
    expect(docToText(next.doc)).toBe(`[a.ts](${ATTACHMENT_LINK_BASE}existing)[a.ts](${ATTACHMENT_LINK_BASE}existing)`);
    // No second entry — the existing one is reused and now referenced twice.
    expect(registry(next).size).toBe(1);
    expect(registry(next).get('existing')!.refCount).toBe(2);
  });

  it('attId collision on a new key: mints a fresh id and rewrites the slice', () => {
    const existing = entry({ attId: FILE.attId, path: '/w/other.ts', key: 'file:///w/other.ts', name: 'other.ts' });
    const copy = createState(link(FILE));
    const json = flavorJson(copy, [entry({ attId: FILE.attId, path: '/w/a.ts', key: 'file:///w/a.ts', name: 'a.ts' })]);
    const paste = pasteState(link({ attId: FILE.attId, name: 'other.ts', kind: 'file' }), { entries: [existing] });
    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);
    // The pasted pill carries a minted id — the existing entry keeps its own.
    const text = docToText(next.doc);
    const minted = [...registry(next).keys()].find((id) => id !== FILE.attId)!;
    expect(minted).toMatch(/^[0-9a-z]{8}$/);
    expect(text).toBe(`[other.ts](${ATTACHMENT_LINK_BASE}${FILE.attId})[a.ts](${ATTACHMENT_LINK_BASE}${minted})`);
    expect(registry(next).get(minted)!.path).toBe('/w/a.ts');
    expect(registry(next).get(minted)!.refCount).toBe(1);
    expect(registry(next).get(FILE.attId)!.name).toBe('other.ts');
  });

  it('pastes a dead slice (no entries) as dead pills without inventing metadata', () => {
    const copy = createState(link(FILE));
    const json = flavorJson(copy); // no entries at all
    const paste = pasteState('');
    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);
    expect(docToText(next.doc)).toBe(link(FILE));
    expect(registry(next).size).toBe(0);
  });

  it('closes the mid-upload cut+paste loop: the late success backfill clears the interrupted marker', () => {
    // Cut mid-upload, paste back: the entry returns normalized to
    // 'upload-interrupted' — but the ORIGINAL upload still completes against
    // the same sid+attId, and its backfill patch (fileId + uploading:false +
    // error:undefined) must retire the marker too, or the revived pill would
    // block the send gate forever.
    const copy = createState(link(FILE));
    const json = flavorJson(copy, [entry({ attId: FILE.attId, uploading: true })]);
    const paste = pasteState('');
    const pasted = paste.apply(buildAttachmentClipboardPaste(paste, json)!);
    expect(registry(pasted).get(FILE.attId)).toMatchObject({
      uploading: false,
      error: 'upload-interrupted',
    });

    const backfilled = pasted.apply(
      pasted.tr.setMeta(attachmentRegistryKey, {
        type: 'patch',
        attId: FILE.attId,
        patch: { fileId: 'f-late', mediaType: 'text/plain', uploading: false, error: undefined },
      } satisfies AttachmentRegistryCommand),
    );
    expect(registry(backfilled).get(FILE.attId)).toMatchObject({
      uploading: false,
      fileId: 'f-late',
      mediaType: 'text/plain',
      error: undefined,
    });
  });
});

describe('stashComposerFlavor + resolveComposerClipboardMime — the OS-clipboard vault ref', () => {
  afterEach(() => clearComposerFlavorVault());

  it('the clipboard carries only a { v: 2, ref } envelope — no path, fileId, or pill name leaks', () => {
    const copy = createState(link(FILE));
    const flavor = flavorJson(copy, [
      entry({ attId: FILE.attId, path: '/secret/dir/a.ts', key: 'file:///secret/dir/a.ts', name: 'a.ts', fileId: 'f_secret' }),
    ]);
    // Sanity: the flavor itself does carry the metadata (the paste needs it).
    expect(flavor).toContain('/secret/dir/a.ts');
    expect(flavor).toContain('f_secret');
    const onClipboard = stashComposerFlavor(flavor);
    expect(onClipboard).not.toContain('/secret/dir/a.ts');
    expect(onClipboard).not.toContain('f_secret');
    expect(onClipboard).not.toContain('a.ts');
    const envelope = JSON.parse(onClipboard) as { v?: unknown; ref?: unknown };
    expect(envelope.v).toBe(2);
    expect(envelope.ref).toMatch(/^[0-9a-z]{16}$/);
  });

  it('round-trips: the ref resolves to the flavor and the paste still merges pills', () => {
    const copy = createState(link(FILE));
    const flavor = flavorJson(copy, [entry({ attId: FILE.attId, path: '/w/a.ts', key: 'file:///w/a.ts', name: 'a.ts' })]);
    const resolved = resolveComposerClipboardMime(stashComposerFlavor(flavor));
    expect(resolved).toBe(flavor);
    const base = createState('ab');
    const paste = base.apply(base.tr.setSelection(TextSelection.atEnd(base.doc)));
    const next = paste.apply(buildAttachmentClipboardPaste(paste, resolved!)!);
    expect(docToText(next.doc)).toBe(`ab${link(FILE)}`);
    expect(registry(next).get(FILE.attId)!.path).toBe('/w/a.ts');
  });

  it('resolves NON-destructively — one copy stays pasteable any number of times', () => {
    // The system clipboard keeps the nonce; consuming on first read would
    // regress the old full-flavor semantics (paste into several composers).
    const onClipboard = stashComposerFlavor('flavor-x');
    expect(resolveComposerClipboardMime(onClipboard)).toBe('flavor-x');
    expect(resolveComposerClipboardMime(onClipboard)).toBe('flavor-x');
  });

  it('a vault miss (a foreign, evicted, or pre-restart ref) returns undefined — the caller degrades to plain text', () => {
    expect(resolveComposerClipboardMime(JSON.stringify({ v: 2, ref: 'nosuchref0000000' }))).toBeUndefined();
  });

  it('passes a v1 full flavor (and anything that isn’t a v2 envelope) through unchanged', () => {
    const copy = createState(link(FILE));
    const flavor = flavorJson(copy, [entry({ attId: FILE.attId })]);
    expect(resolveComposerClipboardMime(flavor)).toBe(flavor);
    expect(resolveComposerClipboardMime('not json at all')).toBe('not json at all');
    // A v:2-looking object without a STRING ref is not an envelope.
    expect(resolveComposerClipboardMime(JSON.stringify({ v: 2 }))).toBe(JSON.stringify({ v: 2 }));
  });

  it('evicts the oldest flavor past the 50-entry bound', () => {
    const first = stashComposerFlavor('flavor-0');
    let latest = first;
    for (let i = 1; i <= 51; i++) latest = stashComposerFlavor(`flavor-${i}`);
    expect(resolveComposerClipboardMime(first)).toBeUndefined();
    expect(resolveComposerClipboardMime(latest)).toBe('flavor-51');
  });
});

describe('attachmentRegistry — batched meta commands', () => {
  it('applies an array of commands in order within one transaction', () => {
    const state = createState('');
    const commands: AttachmentRegistryCommand[] = [
      { type: 'upsert', entry: entry({ attId: 'aaaaaaaa', uploading: true }) },
      { type: 'upsert', entry: entry({ attId: 'bbbbbbbb' }) },
      { type: 'patch', attId: 'aaaaaaaa', patch: { uploading: false, fileId: 'fid-1' } },
    ];
    const next = state.apply(state.tr.setMeta(attachmentRegistryKey, commands));
    // No doc change → no reconcile: upserted entries sit at refCount 0.
    expect(registry(next).get('aaaaaaaa')).toEqual({ ...entry({ attId: 'aaaaaaaa' }), fileId: 'fid-1' });
    expect(registry(next).get('bbbbbbbb')).toEqual(entry({ attId: 'bbbbbbbb' }));
  });
});

describe('splitInlineSegments — message-side attachment snapshot', () => {
  it('segments a bubble text with mention, file and folder attachments', () => {
    const text = `对比 [m.ts](src/m.ts) 和 ${link(FILE)} 加 ${link(FOLDER)} 完`;
    expect(splitInlineSegments(text)).toEqual([
      { type: 'text', value: '对比 ' },
      { type: 'mention', attrs: { kind: 'file', name: 'm.ts', path: 'src/m.ts' }, rawDest: 'src/m.ts' },
      { type: 'text', value: ' 和 ' },
      { type: 'attachment', attrs: FILE, rawDest: `${ATTACHMENT_LINK_BASE}abc12345` },
      { type: 'text', value: ' 加 ' },
      { type: 'attachment', attrs: FOLDER, rawDest: `${ATTACHMENT_LINK_BASE}def67890` },
      { type: 'text', value: ' 完' },
    ]);
  });
});

describe('buildMessageCopyFlavor — sent-message copy button', () => {
  const wire = `[a.ts](${ATTACHMENT_LINK_BASE}1) and [b.ts](${ATTACHMENT_LINK_BASE}2)`;
  const turnAttachments = [
    { kind: 'image', fileId: 'f_img', url: '/files/f_img' },
    { kind: 'file', fileId: 'f_a', size: 10, mediaType: 'text/plain' },
    { kind: 'file', fileId: 'f_b', size: 20 },
  ] as const;

  it('carries the revived slice and fileId-inheriting entries keyed blob:<fileId>', () => {
    const flavor = buildMessageCopyFlavor(wire, turnAttachments);
    expect(flavor).toBeDefined();
    const parsed = parseComposerClipboardPayload(flavor!);
    expect(parsed).not.toBeNull();
    // The slice revives BOTH links as attachment nodes.
    expect(sliceAttachmentAttIds(parsed!.slice)).toEqual(['1', '2']);
    // Entries map the 1..N indexes back to FILE attachments only (media is
    // skipped), inheriting fileId + size + mediaType and deduping on
    // blob:<fileId>.
    expect(parsed!.attachments).toEqual([
      { attId: '1', key: 'blob:f_a', kind: 'file', name: 'a.ts', size: 10, mediaType: 'text/plain', seq: expect.any(Number), refCount: 0, uploading: false, fileId: 'f_a' },
      { attId: '2', key: 'blob:f_b', kind: 'file', name: 'b.ts', size: 20, mediaType: undefined, seq: expect.any(Number), refCount: 0, uploading: false, fileId: 'f_b' },
    ]);
  });

  it('returns undefined when the text has no attachment links', () => {
    expect(buildMessageCopyFlavor('plain text [m.ts](src/m.ts)', turnAttachments)).toBeUndefined();
  });

  it('a quote-only message still earns the flavor — quote blocks revive as quote NODES in the slice', () => {
    // No attachment links at all: the quote block alone opens the flavor, and
    // the slice carries the quote atom (reviveQuoteBlockLinks) — a paste
    // restores the chip instead of plain blockquote paragraphs.
    const flavor = buildMessageCopyFlavor('from: src/a.ts:L1\n> 代码\n\n看这段', undefined);
    expect(flavor).toBeDefined();
    const parsed = parseComposerClipboardPayload(flavor!)!;
    expect(parsed.attachments).toEqual([]);
    const sliceJson = JSON.stringify(parsed.slice);
    expect(sliceJson).toContain('"type":"quote"');
    expect(sliceJson).toContain('看这段');
    expect(sliceJson).toContain('src/a.ts:L1');
  });

  it('marks the entry interrupted when the index has no attachment (foreign text)', () => {
    // No target → no bytes → never resendable: the pasted pill must show the
    // error state and block the send gate, not degrade to a bare name on
    // submit (the user would silently resend a message missing the file).
    const flavor = buildMessageCopyFlavor(wire, undefined)!;
    const parsed = parseComposerClipboardPayload(flavor)!;
    expect(parsed.attachments[0]).toMatchObject({ attId: '1', key: 'blob:1', fileId: undefined, error: 'upload-interrupted' });
  });

  it('marks an inline-base64 attachment (target resolves but has no fileId) as interrupted, not healthy', () => {
    // The pasted pill must not look sendable: the submit payload skips
    // fileId-less entries, so an unmarked pill would resend a message
    // silently missing the file. The marker survives the flavor's own
    // validation on paste, and healthy entries are untouched.
    const flavor = buildMessageCopyFlavor(wire, [
      { kind: 'file', size: 10 }, // inline-base64: no fileId
      { kind: 'file', fileId: 'f_b', size: 20 },
    ]);
    const parsed = parseComposerClipboardPayload(flavor!);
    expect(parsed).not.toBeNull();
    expect(parsed!.attachments[0]).toMatchObject({
      attId: '1',
      key: 'blob:1',
      fileId: undefined,
      uploading: false,
      error: 'upload-interrupted',
    });
    expect(parsed!.attachments[1]).toMatchObject({ attId: '2', fileId: 'f_b', error: undefined });
  });
});

describe('degradeForeignAttachmentLinks — plain-text paste filter', () => {
  const wire = `keep [a.ts](${ATTACHMENT_LINK_BASE}abc12345) drop [b.ts](${ATTACHMENT_LINK_BASE}deadbeef) and [m.ts](src/m.ts)`;

  it('keeps registry-known links, degrades foreign ones to bare names, mentions untouched', () => {
    expect(degradeForeignAttachmentLinks(wire, new Set(['abc12345']))).toBe(
      `keep [a.ts](${ATTACHMENT_LINK_BASE}abc12345) drop b.ts and [m.ts](src/m.ts)`,
    );
  });

  it('degrades every link when the registry is empty', () => {
    expect(degradeForeignAttachmentLinks(wire, new Set())).toBe('keep a.ts drop b.ts and [m.ts](src/m.ts)');
  });
});

describe('messageCopyEntryFor (the shared copy-flavor entry constructor)', () => {
  // BOTH message-side copy paths build their flavor entries through this:
  // the bubble copy button (buildMessageCopyFlavor) and the DOM-selection
  // copy in ComposerText — the inline-base64 marker must not diverge.
  const attrs: AttachmentAttrs = { attId: '1', name: 'raw.bin', kind: 'file' };

  it('marks an inline-base64 target (no fileId) as interrupted, not healthy', () => {
    expect(messageCopyEntryFor(attrs, { kind: 'file', size: 10 })).toMatchObject({
      attId: '1',
      key: 'blob:1',
      uploading: false,
      fileId: undefined,
      error: 'upload-interrupted',
    });
  });

  it('builds a healthy entry for an uploaded target (dedup key blob:<fileId>)', () => {
    expect(messageCopyEntryFor(attrs, { kind: 'file', fileId: 'f_a', size: 10, mediaType: 'text/plain' })).toEqual({
      attId: '1',
      key: 'blob:f_a',
      kind: 'file',
      name: 'raw.bin',
      size: 10,
      mediaType: 'text/plain',
      refCount: 0,
      uploading: false,
      fileId: 'f_a',
      error: undefined,
    });
  });

  it('marks a blob stub without a target (foreign index) as interrupted, not healthy', () => {
    expect(messageCopyEntryFor(attrs, undefined)).toMatchObject({
      attId: '1',
      key: 'blob:1',
      fileId: undefined,
      error: 'upload-interrupted',
    });
  });
});
