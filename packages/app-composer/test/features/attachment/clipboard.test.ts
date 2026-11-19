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
  setSelectionQuoteEnabledForTests,
  splitInlineSegments,
  textToDoc,
  type AttachmentAttrs,
} from '../../../src/model';
import {
  buildAttachmentClipboardPaste,
  buildComposerClipboardCopy,
  buildMessageCopyFlavor,
  clearComposerFlavorVault,
  mergePastedEntries,
  messageCopyEntryFor,
  parseComposerClipboardPayload,
  remapSliceAttachments,
  resolveComposerClipboardMime,
  sliceAttachmentAttIds,
  stashComposerFlavor,
} from '../../../src/features/attachment/clipboard';
import {
  attachmentRegistryKey,
  createAttachmentRegistryPlugin,
  type AttachmentRegistryCommand,
} from '../../../src/features/attachment/registry';
import type { AttachmentEntry } from '../../../src/features/attachment/entry';

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
    const slice = NodeSelection.create(state.doc, 3).content();
    expect(serializeClipboardSlice(slice)).toBe('a.ts');
  });

  it('keeps the folder name’s trailing slash as the kind marker', () => {
    const state = createState(`x ${link(FOLDER)}`);
    const slice = NodeSelection.create(state.doc, 3).content();
    expect(serializeClipboardSlice(slice)).toBe('src/');
  });

  it('degrades an attachment to its bare name INSIDE a paragraph too (no scheme leak)', () => {
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

  it('preserves plain text and mention node identity in the structured flavor', () => {
    for (const slice of [parseClipboardText('[m.ts](src/m.ts)'), parseClipboardText('[m.ts](src/m.ts)', { reviveMentions: true })]) {
      const copy = buildComposerClipboardCopy(slice, byAttId());
      expect(copy).not.toBeNull();
      expect(parseComposerClipboardPayload(copy!.flavor)?.slice.toJSON()).toEqual(slice.toJSON());
    }
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
    expect(copy.plain).toBe('看 a.ts 吧');
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
      byAttId(entry({ attId: FOLDER.attId, kind: 'folder', name: 'src/' })),
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
    expect(copy.plain).toBe('看\n\n> 多行\n> 引用\n\n吧');
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
    expect(docToText(next.doc)).toBe(quoteLink('引用'));
  });
});

describe('parseComposerClipboardPayload', () => {
  it('round-trips a real slice and its entries', () => {
    const slice = parseClipboardText(`看 ${link(FILE)} 吧`, { reviveMentions: true });
    const json = JSON.stringify({ v: 1, slice: slice.toJSON(), attachments: [entry({ attId: FILE.attId, refCount: 7 })] });
    const parsed = parseComposerClipboardPayload(json)!;
    expect(parsed).not.toBeNull();
    expect(docToText(composerSchema.nodes.doc.create(null, parsed.slice.content))).toBe(`看 ${link(FILE)} 吧`);
    expect(parsed.slice.openStart).toBe(slice.openStart);
    expect(parsed.attachments).toEqual([entry({ attId: FILE.attId })]);
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
          { attId: 'bbbbbbbb' },
          'garbage',
          null,
        ],
      }),
    )!;
    expect(parsed.attachments).toEqual([entry({ attId: 'aaaaaaaa' })]);
  });

  it('accepts image/video kinds and never takes a previewUrl across the boundary', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [
          entry({ attId: 'aaaaaaaa', kind: 'image', previewUrl: 'blob:smuggled' }),
          entry({ attId: 'bbbbbbbb', kind: 'video' }),
          entry({ attId: 'cccccccc', kind: 'widget' }),
        ],
      }),
    )!;
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]!.kind).toBe('image');
    expect(parsed.attachments[1]!.kind).toBe('video');
    expect(parsed.attachments[0]!.previewUrl).toBeUndefined();
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
            size: '1024',
            mediaType: ['text/plain'],
            path: { evil: true },
            fileId: 42,
            error: ['x'],
            refCount: 99,
            uploading: 'yes',
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
          entry({ attId: 'abc)1234' }),
          entry({ attId: 'ABC12345' }),
          entry({ attId: '' }),
          entry({ attId: 'a'.repeat(65) }),
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
        attachments: [entry({ attId: 'aaaaaaaa', uploading: false, fileId: 'fid-1' })],
      }),
    )!;
    expect(parsed.attachments[0]).toMatchObject({ uploading: false, fileId: 'fid-1', error: undefined });
  });

  it('normalizes an in-flight REUPLOAD with a stale fileId to upload-interrupted (a version-change retry pastes back as dead, never ready)', () => {
    const slice = parseClipboardText('x', { reviveMentions: true });
    const parsed = parseComposerClipboardPayload(
      JSON.stringify({
        v: 1,
        slice: slice.toJSON(),
        attachments: [entry({ attId: 'aaaaaaaa', uploading: true, fileId: 'fid-old' })],
      }),
    )!;
    expect(parsed.attachments[0]).toMatchObject({ uploading: false, fileId: 'fid-old', error: 'upload-interrupted' });
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
    const paste = pasteState(link({ attId: 'existing', name: 'a.ts', kind: 'file' }), { entries: [existing] });
    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);
    expect(docToText(next.doc)).toBe(`[a.ts](${ATTACHMENT_LINK_BASE}existing)[a.ts](${ATTACHMENT_LINK_BASE}existing)`);
    expect(registry(next).size).toBe(1);
    expect(registry(next).get('existing')!.refCount).toBe(2);
  });

  it('attId collision on a new key: mints a fresh id and rewrites the slice', () => {
    const existing = entry({ attId: FILE.attId, path: '/w/other.ts', key: 'file:///w/other.ts', name: 'other.ts' });
    const copy = createState(link(FILE));
    const json = flavorJson(copy, [entry({ attId: FILE.attId, path: '/w/a.ts', key: 'file:///w/a.ts', name: 'a.ts' })]);
    const paste = pasteState(link({ attId: FILE.attId, name: 'other.ts', kind: 'file' }), { entries: [existing] });
    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);
    const text = docToText(next.doc);
    const minted = [...registry(next).keys()].find((id) => id !== FILE.attId)!;
    expect(minted).toMatch(/^[0-9a-z]{8}$/);
    expect(text).toBe(`[other.ts](${ATTACHMENT_LINK_BASE}${FILE.attId})[a.ts](${ATTACHMENT_LINK_BASE}${minted})`);
    expect(registry(next).get(minted)!.path).toBe('/w/a.ts');
    expect(registry(next).get(minted)!.refCount).toBe(1);
    expect(registry(next).get(FILE.attId)!.name).toBe('other.ts');
  });

  it('renumbers a pasted media mention when its generated name is already occupied', () => {
    const existingAttrs: AttachmentAttrs = { attId: 'existing', name: 'Image 1', kind: 'image' };
    const pastedAttrs: AttachmentAttrs = { attId: 'other000', name: 'Image 1', kind: 'image' };
    const existing = entry({
      attId: existingAttrs.attId,
      key: 'blob:file-existing',
      kind: 'image',
      name: 'first.png',
      mediaOrdinal: 1,
      fileId: 'file-existing',
    });
    const copy = createState(link(pastedAttrs));
    const json = flavorJson(copy, [entry({
      attId: pastedAttrs.attId,
      key: 'blob:file-other',
      kind: 'image',
      name: 'second.png',
      mediaOrdinal: 1,
      fileId: 'file-other',
    })]);
    const paste = pasteState(link(existingAttrs), { entries: [existing] });

    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);

    expect(docToText(next.doc)).toBe(
      `${link(existingAttrs)}${link({ ...pastedAttrs, name: 'Image 2' })}`,
    );
    expect(registry(next).get(pastedAttrs.attId)).toMatchObject({
      mediaOrdinal: 2,
      name: 'second.png',
    });
  });

  it('renumbers a media mention against an empty destination inventory', () => {
    const pastedAttrs: AttachmentAttrs = { attId: 'other000', name: 'Image 2', kind: 'image' };
    const copy = createState(link(pastedAttrs));
    const json = flavorJson(copy, [entry({
      attId: pastedAttrs.attId,
      key: 'blob:file-other',
      kind: 'image',
      name: 'second.png',
      mediaOrdinal: 2,
      fileId: 'file-other',
    })]);
    const paste = pasteState('');

    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);

    expect(docToText(next.doc)).toBe(link({ ...pastedAttrs, name: 'Image 1' }));
    expect(registry(next).get(pastedAttrs.attId)).toMatchObject({
      mediaOrdinal: 1,
      name: 'second.png',
    });
  });

  it('renders a cross-composer media paste with the destination locale label', () => {
    const pastedAttrs: AttachmentAttrs = { attId: 'other000', name: 'Image 4', kind: 'image' };
    const copy = createState(link(pastedAttrs));
    const json = flavorJson(copy, [entry({
      attId: pastedAttrs.attId,
      key: 'blob:file-other',
      kind: 'image',
      name: 'second.png',
      mediaOrdinal: 4,
      fileId: 'file-other',
    })]);
    const paste = pasteState('');
    const adopted: AttachmentEntry[] = [];

    const next = paste.apply(buildAttachmentClipboardPaste(paste, json, {
      entries: [],
      upsert: (entry) => adopted.push(entry),
      referenceName: (entry) => `图片 ${entry.mediaOrdinal}`,
    })!);

    expect(docToText(next.doc)).toBe(link({ ...pastedAttrs, name: '图片 1' }));
    expect(adopted[0]?.mediaOrdinal).toBe(1);
  });

  it('keeps the ordinal when pasting another reference to media already in the destination', () => {
    const attrs: AttachmentAttrs = { attId: 'existing', name: 'Image 2', kind: 'image' };
    const existing = entry({
      attId: attrs.attId,
      key: 'blob:file-existing',
      kind: 'image',
      name: 'second.png',
      mediaOrdinal: 2,
      fileId: 'file-existing',
    });
    const copy = createState(link(attrs));
    const json = flavorJson(copy, [existing]);
    const paste = pasteState(link(attrs), { entries: [existing] });

    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);

    expect(docToText(next.doc)).toBe(`${link(attrs)}${link(attrs)}`);
    expect(registry(next).size).toBe(1);
    expect(registry(next).get(attrs.attId)).toMatchObject({
      mediaOrdinal: 2,
    });
  });

  it('pastes a dead slice (no entries) as dead pills without inventing metadata', () => {
    const copy = createState(link(FILE));
    const json = flavorJson(copy);
    const paste = pasteState('');
    const next = paste.apply(buildAttachmentClipboardPaste(paste, json)!);
    expect(docToText(next.doc)).toBe(link(FILE));
    expect(registry(next).size).toBe(0);
  });

  it('closes the mid-upload cut+paste loop: the late success backfill clears the interrupted marker', () => {
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
    expect(sliceAttachmentAttIds(parsed!.slice)).toEqual(['1', '2']);
    expect(parsed!.attachments).toEqual([
      { attId: '1', key: 'blob:f_a', kind: 'file', name: 'a.ts', size: 10, mediaType: 'text/plain', refCount: 0, uploading: false, fileId: 'f_a' },
      { attId: '2', key: 'blob:f_b', kind: 'file', name: 'b.ts', size: 20, mediaType: undefined, refCount: 0, uploading: false, fileId: 'f_b' },
    ]);
  });

  it('returns undefined when the text has no attachment links', () => {
    expect(buildMessageCopyFlavor('plain text [m.ts](src/m.ts)', turnAttachments)).toBeUndefined();
  });

  it('a quote-only message still earns the flavor — quote blocks revive as quote NODES in the slice', () => {
    setSelectionQuoteEnabledForTests(true);
    const flavor = buildMessageCopyFlavor('from: src/a.ts:L1\n> 代码\n\n看这段', undefined);
    expect(flavor).toBeDefined();
    const parsed = parseComposerClipboardPayload(flavor!)!;
    expect(parsed.attachments).toEqual([]);
    const sliceJson = JSON.stringify(parsed.slice);
    expect(sliceJson).toContain('"type":"quote"');
    expect(sliceJson).toContain('看这段');
    expect(sliceJson).toContain('src/a.ts:L1');
    setSelectionQuoteEnabledForTests(false);
  });

  it('marks the entry interrupted when the index has no attachment (foreign text)', () => {
    const flavor = buildMessageCopyFlavor(wire, undefined)!;
    const parsed = parseComposerClipboardPayload(flavor)!;
    expect(parsed.attachments[0]).toMatchObject({ attId: '1', key: 'blob:1', fileId: undefined, error: 'upload-interrupted' });
  });

  it('marks an inline-base64 attachment (target resolves but has no fileId) as interrupted, not healthy', () => {
    const flavor = buildMessageCopyFlavor(wire, [
      { kind: 'file', size: 10 },
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

  it('keys a session-media target blob:<sessionId>:<fileId> (session-scoped namespace)', () => {
    expect(messageCopyEntryFor(attrs, { kind: 'image', fileId: 'f_a', sessionId: 's_1', size: 10 })).toMatchObject({
      attId: '1',
      key: 'blob:s_1:f_a',
      fileId: 'f_a',
      sessionId: 's_1',
      error: undefined,
    });
  });

  it('keeps the original target filename when a sent media pill uses a generated label', () => {
    expect(messageCopyEntryFor(
      { attId: 'm2', name: 'Image 2', kind: 'image' },
      { kind: 'image', name: 'kimi-with-icon.png', fileId: 'f_a', sessionId: 's_1', mediaOrdinal: 2 },
    )).toMatchObject({
      name: 'kimi-with-icon.png',
      mediaOrdinal: 2,
    });
  });

  it('does not fold same-fileId pills from two sessions into one entry on paste', () => {
    const fromA = messageCopyEntryFor(attrs, { kind: 'image', fileId: 'f_a', sessionId: 's_1' });
    const fromB = messageCopyEntryFor({ ...attrs, attId: '2' }, { kind: 'image', fileId: 'f_a', sessionId: 's_2' });
    const { entries, attIdRemap } = mergePastedEntries([fromA], [fromB]);
    expect(entries).toHaveLength(2);
    expect(attIdRemap).toEqual({});
    expect(entries.map((entry) => entry.key).sort()).toEqual(['blob:s_1:f_a', 'blob:s_2:f_a']);
  });
});


it('reuses a copied media source after its target-session upload changes the file id', () => {
  const source = entry({ attId: 'source', key: 'blob:session-a:file-a', kind: 'video', sessionId: 'session-a', fileId: 'file-a' });
  const uploaded = { ...source, attId: 'target', sessionId: undefined, fileId: 'file-b', uploading: false };
  const merged = mergePastedEntries([uploaded], [source]);
  expect(merged.entries).toEqual([uploaded]);
  expect(merged.attIdRemap).toEqual({ source: 'target' });
});
