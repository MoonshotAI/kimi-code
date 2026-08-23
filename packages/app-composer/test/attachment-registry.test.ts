import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { history, redo, undo } from 'prosemirror-history';
import {
  ATTACHMENT_LINK_BASE,
  buildAttachmentInsertion,
  composerSchema,
  textToDoc,
  type AttachmentAttrs,
} from '../src/composerTextDoc';
import {
  attachmentKeyFor,
  attachmentRegistryKey,
  countDocAttachments,
  createAttachmentRegistryPlugin,
  mergePastedEntries,
  newAttId,
  nextAttachmentSeq,
  normalizeAttachmentPath,
  noteAttachmentSeq,
  orderedDocAttachments,
  remintAttachmentLinkIds,
  type AttachmentEntry,
  type AttachmentRegistryCommand,
} from '../src/attachmentRegistry';

const link = (name: string, attId: string): string => `[${name}](${ATTACHMENT_LINK_BASE}${attId})`;

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

function createState(
  text: string,
  opts?: { entries?: AttachmentEntry[]; withHistory?: boolean },
): EditorState {
  return EditorState.create({
    schema: composerSchema,
    doc: textToDoc(text, { reviveMentions: true }),
    plugins: [
      ...(opts?.withHistory ? [history()] : []),
      createAttachmentRegistryPlugin({ initialEntries: opts?.entries }),
    ],
  });
}

function registry(state: EditorState): Map<string, AttachmentEntry> {
  return attachmentRegistryKey.getState(state)!;
}

function command(state: EditorState, cmd: AttachmentRegistryCommand) {
  return state.tr.setMeta(attachmentRegistryKey, cmd);
}

const FILE: AttachmentAttrs = { attId: 'aaaaaaaa', name: 'a.ts', kind: 'file' };

describe('newAttId', () => {
  it('mints unique 8-char base36 ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAttId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe('normalizeAttachmentPath', () => {
  it('collapses duplicates and resolves dot segments lexically', () => {
    expect(normalizeAttachmentPath('/a/./b//c/')).toBe('/a/b/c');
    expect(normalizeAttachmentPath('/a/b/../c')).toBe('/a/c');
    expect(normalizeAttachmentPath('a/b/')).toBe('a/b');
    expect(normalizeAttachmentPath('../a/./b')).toBe('../a/b');
  });

  it('clamps .. at an absolute root but keeps it in a relative path', () => {
    expect(normalizeAttachmentPath('/a/../../b')).toBe('/b');
    expect(normalizeAttachmentPath('../../a')).toBe('../../a');
  });

  it('unifies separators and keeps drive / UNC / POSIX roots', () => {
    expect(normalizeAttachmentPath('C:\\a\\b\\')).toBe('C:/a/b');
    expect(normalizeAttachmentPath('//server/share/')).toBe('//server/share');
    expect(normalizeAttachmentPath('/')).toBe('/');
  });
});

describe('attachmentKeyFor', () => {
  it('keys path-backed entries on the normalized path (folders with a trailing slash)', () => {
    expect(attachmentKeyFor({ kind: 'file', path: '/a/b.ts', attId: 'x' })).toBe('file:///a/b.ts');
    expect(attachmentKeyFor({ kind: 'folder', path: '/a/b', attId: 'x' })).toBe('file:///a/b/');
    expect(attachmentKeyFor({ kind: 'folder', path: '/a/b/', attId: 'x' })).toBe('file:///a/b/');
    // A file and a folder at the same path never share a key.
    expect(attachmentKeyFor({ kind: 'file', path: '/a/b', attId: 'x' })).not.toBe(
      attachmentKeyFor({ kind: 'folder', path: '/a/b', attId: 'x' }),
    );
  });

  it('keys pathless entries on their own id (no byte dedup)', () => {
    expect(attachmentKeyFor({ kind: 'file', attId: 'x' })).toBe('blob:x');
    expect(attachmentKeyFor({ kind: 'file', attId: 'x' })).not.toBe(attachmentKeyFor({ kind: 'file', attId: 'y' }));
  });
});

describe('attachmentRegistry — init', () => {
  it('recomputes refCounts against the initial doc and drops unreferenced entries', () => {
    const text = `${link('a.ts', 'aaaaaaaa')} ${link('a.ts', 'aaaaaaaa')}\n${link('b.ts', 'bbbbbbbb')}`;
    const state = createState(text, {
      entries: [
        entry({ attId: 'aaaaaaaa', refCount: 99 }),
        entry({ attId: 'bbbbbbbb' }),
        entry({ attId: 'cccccccc' }), // nothing references it
      ],
    });
    const reg = registry(state);
    expect([...reg.keys()]).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(reg.get('aaaaaaaa')!.refCount).toBe(2);
    expect(reg.get('bbbbbbbb')!.refCount).toBe(1);
  });

  it('starts empty without initial entries', () => {
    expect(registry(createState(link('a.ts', 'aaaaaaaa'))).size).toBe(0);
  });
});

describe('attachmentRegistry — meta commands', () => {
  it('applies an upsert and lets the same transaction’s doc change set the count', () => {
    const state = createState('');
    const e = entry({ attId: 'aaaaaaaa', uploading: true, path: '/a.ts', key: 'file:///a.ts' });
    const tr = buildAttachmentInsertion(state, FILE).setMeta(attachmentRegistryKey, { type: 'upsert', entry: e });
    const reg = registry(state.apply(tr));
    expect(reg.get('aaaaaaaa')).toEqual({ ...e, refCount: 1 });
  });

  it('keeps an upserted entry at refCount 0 until a doc change references it — and drops it if none does', () => {
    const state = createState('');
    const e = entry({ attId: 'aaaaaaaa', uploading: true });
    const upserted = state.apply(command(state, { type: 'upsert', entry: e }));
    expect(registry(upserted).get('aaaaaaaa')).toEqual({ ...e, refCount: 0 });
    // An unrelated doc change reconciles: still unreferenced → gone.
    const typed = upserted.apply(upserted.tr.insertText('x'));
    expect(registry(typed).size).toBe(0);
  });

  it('patches metadata in place, never touching identity or refCount', () => {
    const state = createState(link('a.ts', 'aaaaaaaa'), {
      entries: [entry({ attId: 'aaaaaaaa', uploading: true, path: '/a.ts', key: 'file:///a.ts' })],
    });
    const patched = state.apply(
      command(state, { type: 'patch', attId: 'aaaaaaaa', patch: { fileId: 'fid-1', uploading: false } }),
    );
    expect(registry(patched).get('aaaaaaaa')).toEqual({
      attId: 'aaaaaaaa',
      key: 'file:///a.ts',
      kind: 'file',
      name: 'aaaaaaaa.ts',
      path: '/a.ts',
      refCount: 1,
      uploading: false,
      fileId: 'fid-1',
    });
  });

  it('ignores a patch for an unknown attId (no-op, same map identity)', () => {
    const state = createState('');
    const next = state.apply(command(state, { type: 'patch', attId: 'nope', patch: { fileId: 'x' } }));
    expect(registry(next)).toBe(registry(state));
  });
});

describe('attachmentRegistry — reconcile on doc change', () => {
  const e = () => entry({ attId: 'aaaaaaaa', path: '/a.ts', key: 'file:///a.ts' });

  it('counts repeated pills of the same attId', () => {
    const state = createState(link('a.ts', 'aaaaaaaa'), { entries: [e()] });
    const inserted = state.apply(buildAttachmentInsertion(state, FILE));
    const reg = registry(inserted);
    expect(reg.get('aaaaaaaa')!.refCount).toBe(2);
    // Metadata rides along — the entry is refCount-updated, never rebuilt.
    expect(reg.get('aaaaaaaa')!.path).toBe('/a.ts');
  });

  it('decrements on pill deletion and drops the entry at zero', () => {
    const text = `${link('a.ts', 'aaaaaaaa')} ${link('a.ts', 'aaaaaaaa')}`;
    const state = createState(text, { entries: [e()] });
    expect(registry(state).get('aaaaaaaa')!.refCount).toBe(2);
    // The second pill sits at position 3 (pill at 1, space text at 2).
    const oneLeft = state.apply(state.tr.delete(3, 4));
    expect(registry(oneLeft).get('aaaaaaaa')!.refCount).toBe(1);
    const noneLeft = oneLeft.apply(oneLeft.tr.delete(1, 3));
    expect(registry(noneLeft).size).toBe(0);
  });

  it('reuses the entry OBJECT when only other attIds move', () => {
    const text = `${link('a.ts', 'aaaaaaaa')} ${link('b.ts', 'bbbbbbbb')}`;
    const state = createState(text, { entries: [entry({ attId: 'aaaaaaaa' }), entry({ attId: 'bbbbbbbb' })] });
    const before = registry(state).get('aaaaaaaa')!;
    // Delete the b-pill (position 3: a-pill at 1, space at 2, b-pill at 3).
    const next = state.apply(state.tr.delete(3, 4));
    expect(registry(next).get('aaaaaaaa')).toBe(before);
    expect(registry(next).has('bbbbbbbb')).toBe(false);
  });

  it('keeps map identity when a doc change moves no counts', () => {
    const state = createState(link('a.ts', 'aaaaaaaa'), { entries: [e()] });
    const next = state.apply(state.tr.insertText(' more'));
    expect(registry(next)).toBe(registry(state));
  });
});

describe('attachmentRegistry — undo/redo', () => {
  it('reconciles any restored doc state (undo of an insert clears the entry)', () => {
    let state = createState('', { withHistory: true });
    const e = entry({ attId: 'aaaaaaaa', uploading: true });
    state = state.apply(
      buildAttachmentInsertion(state, FILE).setMeta(attachmentRegistryKey, { type: 'upsert', entry: e }),
    );
    expect(registry(state).get('aaaaaaaa')!.refCount).toBe(1);
    expect(undo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(registry(state).size).toBe(0);
    // Redo restores the pill; the reconcile counts it but never invents the
    // metadata — the entry is gone until the caller upserts it again (the
    // documented trade-off of doc-driven reconciliation).
    expect(redo(state, (tr) => (state = state.apply(tr)))).toBe(true);
    expect(orderedDocAttachments(state.doc)).toEqual(['aaaaaaaa']);
    expect(registry(state).size).toBe(0);
  });
});

describe('orderedDocAttachments', () => {
  it('collects attIds in document first-mention order, deduplicated', () => {
    const text = `x ${link('b.ts', 'bbbbbbbb')} ${link('a.ts', 'aaaaaaaa')}\n${link('b.ts', 'bbbbbbbb')}`;
    expect(orderedDocAttachments(textToDoc(text, { reviveMentions: true }))).toEqual(['bbbbbbbb', 'aaaaaaaa']);
  });

  it('returns [] for a doc without attachments', () => {
    expect(orderedDocAttachments(textToDoc('plain [a.ts](src/a.ts)', { reviveMentions: true }))).toEqual([]);
  });
});

describe('countDocAttachments', () => {
  it('counts every pill occurrence per attId, in first-mention order', () => {
    // Several pills can share one attId (the same file dropped twice, or a
    // pill copied within the composer) — the deduplicated id list alone
    // would lose the extra visible references.
    const text = `x ${link('b.ts', 'bbbbbbbb')} ${link('a.ts', 'aaaaaaaa')}\n${link('b.ts', 'bbbbbbbb')}`;
    const counts = countDocAttachments(textToDoc(text, { reviveMentions: true }));
    expect([...counts.entries()]).toEqual([
      ['bbbbbbbb', 2],
      ['aaaaaaaa', 1],
    ]);
  });

  it('returns an empty map for a doc without attachments', () => {
    expect(countDocAttachments(textToDoc('plain', { reviveMentions: true })).size).toBe(0);
  });
});

describe('noteAttachmentSeq', () => {
  it('fast-forwards the add-order clock past an adopted stamp', () => {
    const fresh = nextAttachmentSeq();
    noteAttachmentSeq(fresh + 1000);
    expect(nextAttachmentSeq()).toBeGreaterThan(fresh + 1000);
  });

  it('never rewinds the clock', () => {
    const fresh = nextAttachmentSeq();
    noteAttachmentSeq(fresh - 1000);
    expect(nextAttachmentSeq()).toBeGreaterThan(fresh);
  });
});

describe('mergePastedEntries', () => {
  const current = () => [entry({ attId: 'aaaaaaaa', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts' })];

  it('same key + same attId: nothing moves, no remap', () => {
    const cur = current();
    const pasted = [entry({ attId: 'aaaaaaaa', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts' })];
    const { entries, attIdRemap } = mergePastedEntries(cur, pasted);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(cur[0]);
    expect(attIdRemap).toEqual({});
  });

  it('same key + different attId: the existing entry wins, the pasted id remaps', () => {
    const cur = current();
    const pasted = [entry({ attId: 'zzzzzzzz', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts' })];
    const { entries, attIdRemap } = mergePastedEntries(cur, pasted);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBe(cur[0]);
    expect(attIdRemap).toEqual({ zzzzzzzz: 'aaaaaaaa' });
  });

  it('new key + free attId: adopted as-is', () => {
    const cur = current();
    const pasted = [entry({ attId: 'bbbbbbbb', key: 'file:///b.ts', path: '/b.ts', name: 'b.ts' })];
    const { entries, attIdRemap } = mergePastedEntries(cur, pasted);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toBe(pasted[0]);
    expect(attIdRemap).toEqual({});
  });

  it('new key + taken attId: mints a fresh id and remaps', () => {
    const cur = current();
    const pasted = [entry({ attId: 'aaaaaaaa', key: 'file:///b.ts', path: '/b.ts', name: 'b.ts' })];
    const { entries, attIdRemap } = mergePastedEntries(cur, pasted);
    expect(entries).toHaveLength(2);
    const minted = attIdRemap['aaaaaaaa']!;
    expect(minted).toMatch(/^[0-9a-z]{8}$/);
    expect(entries[1]).toEqual({ ...pasted[0], attId: minted });
    // The original entry is untouched.
    expect(entries[0]).toBe(cur[0]);
  });

  it('dedups pasted entries among themselves (second same-key remaps to the first)', () => {
    const pasted = [
      entry({ attId: 'bbbbbbbb', key: 'file:///b.ts', path: '/b.ts', name: 'b.ts' }),
      entry({ attId: 'cccccccc', key: 'file:///b.ts', path: '/b.ts', name: 'b.ts' }),
    ];
    const { entries, attIdRemap } = mergePastedEntries([], pasted);
    expect(entries).toHaveLength(1);
    expect(attIdRemap).toEqual({ cccccccc: 'bbbbbbbb' });
  });

  it('does not mutate the current array', () => {
    const cur = current();
    mergePastedEntries(cur, [entry({ attId: 'bbbbbbbb', key: 'file:///b.ts' })]);
    expect(cur).toHaveLength(1);
  });

  it('attId-first: a pasted pill re-anchors on its OWN version when the key holds several', () => {
    // Two VERSIONS of the same path coexist as same-key entries (a
    // mid-upload change mints the second). A blind key lookup folds to the
    // newest — the pasted v1 pill must re-anchor on v1 instead, or it would
    // silently send v2's bytes.
    const v1 = entry({ attId: 'aaaaaaaa', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 10, lastModified: 111, uploading: true, fileId: undefined });
    const v2 = entry({ attId: 'bbbbbbbb', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 12, lastModified: 222, fileId: 'f_v2' });
    const cur = [v1, v2];

    const pastedV1 = [entry({ attId: 'aaaaaaaa', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 10, lastModified: 111, uploading: true })];
    const mergedV1 = mergePastedEntries(cur, pastedV1);
    expect(mergedV1.entries).toHaveLength(2);
    expect(mergedV1.entries[0]).toBe(v1);
    expect(mergedV1.attIdRemap).toEqual({});

    const pastedV2 = [entry({ attId: 'bbbbbbbb', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 12, lastModified: 222, fileId: 'f_v2' })];
    const mergedV2 = mergePastedEntries(cur, pastedV2);
    expect(mergedV2.entries).toHaveLength(2);
    expect(mergedV2.entries[1]).toBe(v2);
    expect(mergedV2.attIdRemap).toEqual({});
  });

  it('keeps a cross-session paste of a DIFFERENT version as its own entry (no key collapse)', () => {
    // Session B holds v2 of the path; the pasted pill is v1 from session A.
    // A recorded size/mtime mismatch means other bytes — adopting by key
    // would re-anchor the pill onto v2 and silently send the wrong file.
    const v2 = entry({ attId: 'bbbbbbbb', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 12, lastModified: 222, fileId: 'f_v2' });
    const v1 = entry({ attId: 'aaaaaaaa', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 10, lastModified: 111, fileId: 'f_v1' });
    const merged = mergePastedEntries([v2], [v1]);
    expect(merged.entries).toHaveLength(2);
    expect(merged.entries[1]).toBe(v1);
    expect(merged.attIdRemap).toEqual({});
  });

  it('still dedups by key for the SAME version (different fileIds are one content, two uploads)', () => {
    const existing = entry({ attId: 'aaaaaaaa', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 10, lastModified: 111, fileId: 'f_first' });
    const reupload = entry({ attId: 'zzzzzzzz', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 10, lastModified: 111, fileId: 'f_second' });
    const merged = mergePastedEntries([existing], [reupload]);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]).toBe(existing);
    expect(merged.attIdRemap).toEqual({ zzzzzzzz: 'aaaaaaaa' });
  });

  it('keeps the key dedup when the version is unprovable (a marker missing on either side)', () => {
    // A pre-versioning entry (no lastModified) with an equal size can't be
    // told apart from the pasted file — the dedup semantics win.
    const legacy = entry({ attId: 'aaaaaaaa', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 10 });
    const pasted = entry({ attId: 'zzzzzzzz', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 10, lastModified: 222 });
    const merged = mergePastedEntries([legacy], [pasted]);
    expect(merged.entries).toHaveLength(1);
    expect(merged.attIdRemap).toEqual({ zzzzzzzz: 'aaaaaaaa' });
    // …but a recorded size mismatch alone already proves the difference.
    const differ = entry({ attId: 'zzzzzzzz', key: 'file:///a.ts', path: '/a.ts', name: 'a.ts', size: 12, lastModified: 222 });
    expect(mergePastedEntries([legacy], [differ]).entries).toHaveLength(2);
  });

  it('attId match with a DIFFERENT key is no anchor — the attId collision mints a fresh id', () => {
    // The pasted attId is taken by ANOTHER file: not our pill coming back,
    // so it must not re-anchor there.
    const cur = current();
    const pasted = [entry({ attId: 'aaaaaaaa', key: 'file:///other.ts', path: '/other.ts', name: 'other.ts' })];
    const { entries, attIdRemap } = mergePastedEntries(cur, pasted);
    expect(entries).toHaveLength(2);
    expect(attIdRemap['aaaaaaaa']).toMatch(/^[0-9a-z]{8}$/);
    expect(entries[0]).toBe(cur[0]);
  });
});

describe('remintAttachmentLinkIds — bubble-copy re-minting', () => {
  it('returns the input and an empty remap when there are no attachment links', () => {
    expect(remintAttachmentLinkIds('plain [a.ts](src/a.ts)')).toEqual({ text: 'plain [a.ts](src/a.ts)', attIdRemap: {} });
  });

  it('mints ONE fresh id per distinct attId and rewrites every occurrence', () => {
    const text = `[a.ts](${ATTACHMENT_LINK_BASE}1) 又 [a.ts](${ATTACHMENT_LINK_BASE}1) 加 [b/](${ATTACHMENT_LINK_BASE}2)`;
    const { text: out, attIdRemap } = remintAttachmentLinkIds(text);
    expect(Object.keys(attIdRemap).sort()).toEqual(['1', '2']);
    expect(attIdRemap['1']).toMatch(/^[0-9a-z]{8}$/);
    expect(attIdRemap['2']).toMatch(/^[0-9a-z]{8}$/);
    expect(attIdRemap['1']).not.toBe(attIdRemap['2']);
    expect(out).toBe(
      `[a.ts](${ATTACHMENT_LINK_BASE}${attIdRemap['1']}) 又 [a.ts](${ATTACHMENT_LINK_BASE}${attIdRemap['1']}) 加 [b/](${ATTACHMENT_LINK_BASE}${attIdRemap['2']})`,
    );
  });

  it('two bubbles with the same index attId but different files no longer collide', () => {
    // Two messages each carry attachments/1 — for DIFFERENT files. Their
    // copy flavors must not merge on the blob:<attId> key.
    const first = remintAttachmentLinkIds(`[a.pdf](${ATTACHMENT_LINK_BASE}1)`);
    const second = remintAttachmentLinkIds(`[b.pdf](${ATTACHMENT_LINK_BASE}1)`);
    const firstId = first.attIdRemap['1']!;
    const secondId = second.attIdRemap['1']!;
    expect(firstId).not.toBe(secondId);
    // And the entries built from each flavor (blob:<minted> keys) merge as
    // two distinct entries instead of collapsing into one.
    const entries = [
      entry({ attId: firstId, key: `blob:${firstId}`, name: 'a.pdf' }),
      entry({ attId: secondId, key: `blob:${secondId}`, name: 'b.pdf' }),
    ];
    const merged = mergePastedEntries([entries[0]!], [entries[1]!]);
    expect(merged.entries).toHaveLength(2);
    expect(merged.attIdRemap).toEqual({});
  });

  it('never touches mention links', () => {
    const text = `[a.ts](src/a.ts) [x](${ATTACHMENT_LINK_BASE}9)`;
    const { text: out, attIdRemap } = remintAttachmentLinkIds(text);
    expect(out).toBe(`[a.ts](src/a.ts) [x](${ATTACHMENT_LINK_BASE}${attIdRemap['9']})`);
  });
});
