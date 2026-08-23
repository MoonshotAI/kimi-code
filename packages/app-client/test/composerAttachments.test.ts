// packages/app-client/test/composerAttachments.test.ts
// Pure helpers behind the composer's attachment-pill flow (both apps):
// same-key reuse planning (files/folders), the submit payload assembly, and
// the registry seeding for queue/edit refills.
import { describe, expect, it } from 'vitest';
import type { AttachmentEntry } from '@moonshot-ai/app-composer';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import {
  applyEntryPatch,
  buildFileSubmitPayload,
  editRefillAttachments,
  interleaveSubmitAttachments,
  pillSubmitBlockers,
  planFileAttachment,
  planFolderAttachment,
  restampRefillByOrderHint,
  seedEntriesForTurnAttachments,
  unreferencedSeedFiles,
} from '../src/lib/composerAttachments';

function entry(overrides?: Partial<AttachmentEntry>): AttachmentEntry {
  return {
    attId: 'existing1',
    key: 'file:///docs/a.pdf',
    kind: 'file',
    name: 'a.pdf',
    size: 10,
    path: '/docs/a.pdf',
    refCount: 1,
    uploading: false,
    fileId: 'f_ready',
    ...overrides,
  };
}

describe('planFileAttachment', () => {
  it('mints a fresh uploading entry keyed by the normalized file:// path', () => {
    const plan = planFileAttachment([], { name: 'a.pdf', size: 10, path: '/docs//a.pdf', mediaType: 'application/pdf', lastModified: 111 });
    expect(plan.entry).not.toBeNull();
    expect(plan.startUpload).toBe(true);
    expect(plan.entry).toMatchObject({
      attId: plan.attId,
      key: 'file:///docs/a.pdf',
      kind: 'file',
      name: 'a.pdf',
      size: 10,
      mediaType: 'application/pdf',
      lastModified: 111,
      path: '/docs/a.pdf',
      uploading: true,
    });
  });

  it('uses a batch pre-assigned seq when given (routeFiles forwards it), else stamps fresh', () => {
    const assigned = planFileAttachment([], { name: 'a.pdf', size: 10, path: '/docs/a.pdf', seq: 4242 });
    expect(assigned.entry?.seq).toBe(4242);
    const fresh = planFileAttachment([], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(fresh.entry?.seq).toEqual(expect.any(Number));
    expect(fresh.entry?.seq).not.toBe(4242);
  });

  it('keys pathless bytes (clipboard paste) on the fresh attId — never deduped', () => {
    const first = planFileAttachment([], { name: 'paste-1.png', size: 5, path: null });
    expect(first.entry?.key).toBe(`blob:${first.attId}`);
    // A second paste of the same-named bytes must NOT reuse the first entry.
    const second = planFileAttachment([first.entry!], { name: 'paste-1.png', size: 5, path: null });
    expect(second.attId).not.toBe(first.attId);
    expect(second.entry).not.toBeNull();
  });

  it('re-dropping the same pathless file after a failed upload revives THAT entry (the tooltip’s retry)', () => {
    // No path to key on (web, pasted bytes): the errored entry matches by
    // name+size and takes the same error-restart branch as a path-backed key
    // reuse — otherwise the old pill keeps blocking the send gate forever.
    const failed = entry({
      attId: 'blob0001',
      key: 'blob:blob0001',
      path: undefined,
      name: 'paste-1.png',
      size: 5,
      error: 'upload-failed',
      fileId: undefined,
    });
    const plan = planFileAttachment([failed], { name: 'paste-1.png', size: 5, path: null });
    expect(plan.attId).toBe('blob0001');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
  });

  it('mints a fresh entry for pathless bytes that differ in name or size — and for a non-errored match', () => {
    const failed = entry({
      attId: 'blob0001',
      key: 'blob:blob0001',
      path: undefined,
      name: 'paste-1.png',
      size: 5,
      error: 'upload-failed',
      fileId: undefined,
    });
    // Different name → new entry (no dedup, chip-era semantics).
    expect(planFileAttachment([failed], { name: 'other.png', size: 5, path: null }).entry).not.toBeNull();
    // Different size → new entry.
    expect(planFileAttachment([failed], { name: 'paste-1.png', size: 6, path: null }).entry).not.toBeNull();
    // Same name+size but READY (no error) → new entry (a live blob never dedups).
    const ready = entry({ attId: 'blob0002', key: 'blob:blob0002', path: undefined, name: 'paste-1.png', size: 5 });
    expect(planFileAttachment([ready], { name: 'paste-1.png', size: 5, path: null }).entry).not.toBeNull();
    // Same name+size but still UPLOADING → new entry (never joins an in-flight one).
    const uploading = entry({ attId: 'blob0003', key: 'blob:blob0003', path: undefined, name: 'paste-1.png', size: 5, uploading: true, fileId: undefined });
    expect(planFileAttachment([uploading], { name: 'paste-1.png', size: 5, path: null }).entry).not.toBeNull();
  });

  it('mints a fresh entry when TWO errored pathless entries share name+size (an ambiguous retry never swaps bytes)', () => {
    // Two same-named, same-sized failures from different sources are
    // indistinguishable — reusing either would silently send the other
    // file's bytes under each pill.
    const first = entry({ attId: 'blob0001', key: 'blob:blob0001', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined });
    const second = entry({ attId: 'blob0002', key: 'blob:blob0002', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined });
    const plan = planFileAttachment([first, second], { name: 'paste-1.png', size: 5, path: null });
    expect(plan.entry).not.toBeNull();
    expect(plan.attId).not.toBe('blob0001');
    expect(plan.attId).not.toBe('blob0002');
    expect(plan.startUpload).toBe(true);
  });

  it('breaks an ambiguous pathless retry by lastModified when exactly one candidate matches', () => {
    const first = entry({ attId: 'blob0001', key: 'blob:blob0001', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined, lastModified: 111 });
    const second = entry({ attId: 'blob0002', key: 'blob:blob0002', path: undefined, name: 'paste-1.png', size: 5, error: 'upload-failed', fileId: undefined, lastModified: 222 });
    const plan = planFileAttachment([first, second], { name: 'paste-1.png', size: 5, path: null, lastModified: 222 });
    expect(plan.attId).toBe('blob0002');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
    // A lastModified that matches NEITHER stays ambiguous → fresh entry.
    expect(planFileAttachment([first, second], { name: 'paste-1.png', size: 5, path: null, lastModified: 333 }).entry).not.toBeNull();
  });

  it('reuses the existing entry on a file:// key hit (one upload, many pills)', () => {
    const existing = entry();
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.attId).toBe('existing1');
    expect(plan.entry).toBeNull();
    // Ready entry → no re-upload.
    expect(plan.startUpload).toBe(false);
  });

  it('does not restart an upload that is still in flight on key reuse', () => {
    const existing = entry({ uploading: true, fileId: undefined });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(false);
  });

  it('re-dropping a file whose upload failed restarts the upload on the same entry', () => {
    const existing = entry({ error: 'upload-failed', fileId: undefined });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.attId).toBe('existing1');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(true);
  });

  it('restarts the upload for a reused entry that never got a fileId (interrupted)', () => {
    const existing = entry({ error: 'upload-interrupted', fileId: undefined });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf' });
    expect(plan.startUpload).toBe(true);
  });

  it('reuses a ready entry while the on-disk version still matches (size + lastModified)', () => {
    const existing = entry({ size: 10, lastModified: 111 });
    const plan = planFileAttachment([existing], { name: 'a.pdf', size: 10, path: '/docs/a.pdf', lastModified: 111 });
    expect(plan.attId).toBe('existing1');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(false);
  });

  it('re-uploads on the same entry when the file on disk CHANGED (size or lastModified mismatch)', () => {
    // A ready entry silently re-sending its old fileId under a fresh drop
    // would be invisible — a recorded version mismatch restarts the upload.
    const bySize = entry({ size: 10, lastModified: 111 });
    expect(planFileAttachment([bySize], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 111 }).startUpload).toBe(true);
    const byMtime = entry({ size: 10, lastModified: 111 });
    expect(planFileAttachment([byMtime], { name: 'a.pdf', size: 10, path: '/docs/a.pdf', lastModified: 222 }).startUpload).toBe(true);
    // …but a mismatch arriving MID-UPLOAD mints an independent entry
    // instead of reusing the in-flight one (see the next test).
    const inFlight = entry({ attId: 'inflt001', key: 'file:///docs/a.pdf', size: 10, lastModified: 111, uploading: true, fileId: undefined });
    const midUpload = planFileAttachment([inFlight], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 });
    expect(midUpload.entry).not.toBeNull();
    expect(midUpload.attId).not.toBe('inflt001');
  });

  it('cannot prove a change without recorded markers — a pre-versioning entry keeps the old reuse behavior', () => {
    // No lastModified on the entry (restored from an old sidecar): only a
    // size mismatch can flag the change.
    const legacy = entry({ size: 10, lastModified: undefined });
    expect(planFileAttachment([legacy], { name: 'a.pdf', size: 10, path: '/docs/a.pdf', lastModified: 222 }).startUpload).toBe(false);
    expect(planFileAttachment([legacy], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 }).startUpload).toBe(true);
  });

  it('mints an independent entry when the file changed MID-UPLOAD (each pill keeps its own version)', () => {
    // Reusing the attId would let the in-flight upload's OLD fileId serve
    // the new pill too. The new entry uploads the new bytes under a new
    // attId; the old upload's completion patches only the old entry — the
    // callbacks address sid+attId, so the two uploads never cross.
    const inFlight = entry({ attId: 'upload01', key: 'file:///docs/a.pdf', path: '/docs/a.pdf', size: 10, lastModified: 111, uploading: true, fileId: undefined });
    const plan = planFileAttachment([inFlight], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 });
    expect(plan.attId).not.toBe('upload01');
    expect(plan.startUpload).toBe(true);
    expect(plan.entry).toMatchObject({
      key: 'file:///docs/a.pdf', // same path identity, independent entry
      kind: 'file',
      size: 12,
      lastModified: 222,
      uploading: true,
    });
  });

  it('prefers the newest same-key entry on later re-drops (version compares against the latest upload)', () => {
    // After a mid-upload mint, two entries share the file:// key — a later
    // re-drop of the CURRENT bytes must reuse the latest entry, never
    // restart against the stale first one.
    const first = entry({ attId: 'upload01', key: 'file:///docs/a.pdf', path: '/docs/a.pdf', size: 10, lastModified: 111, uploading: true, fileId: undefined });
    const second = entry({ attId: 'upload02', key: 'file:///docs/a.pdf', path: '/docs/a.pdf', size: 12, lastModified: 222, fileId: 'f_v2' });
    const plan = planFileAttachment([first, second], { name: 'a.pdf', size: 12, path: '/docs/a.pdf', lastModified: 222 });
    expect(plan.attId).toBe('upload02');
    expect(plan.entry).toBeNull();
    expect(plan.startUpload).toBe(false);
  });
});

describe('planFolderAttachment', () => {
  it('names the pill from the path basename with a trailing slash, never uploading', () => {
    const plan = planFolderAttachment([], '/work/my dir/');
    expect(plan.name).toBe('my dir/');
    expect(plan.entry).toMatchObject({
      key: 'file:///work/my dir/',
      kind: 'folder',
      path: '/work/my dir',
      uploading: false,
    });
  });

  it('reuses the existing folder entry on a key hit', () => {
    const existing = entry({ attId: 'fold9999', key: 'file:///work/', kind: 'folder', name: 'work/', path: '/work', fileId: undefined });
    const plan = planFolderAttachment([existing], '/work');
    expect(plan.attId).toBe('fold9999');
    expect(plan.entry).toBeNull();
  });

  it('names root folders after the root itself (no basename to take)', () => {
    // POSIX root: the basename is empty — the pill shows '/' (its trailing
    // slash doubles as the wire's folder kind marker).
    const posix = planFolderAttachment([], '/');
    expect(posix.name).toBe('/');
    expect(posix.entry).toMatchObject({ name: '/', path: '/', key: 'file:////', kind: 'folder' });
    // Windows drive root (backslash input normalizes): the pill shows 'C:/'.
    const drive = planFolderAttachment([], 'C:\\');
    expect(drive.name).toBe('C:/');
    expect(drive.entry).toMatchObject({ name: 'C:/', path: 'C:/', key: 'file://C://', kind: 'folder' });
  });
});

describe('buildFileSubmitPayload', () => {
  const ready = entry({ attId: 'aa', key: 'file:///a', path: '/a', name: 'a.txt', fileId: 'f_a', mediaType: 'text/plain' });
  const ready2 = entry({ attId: 'bb', key: 'file:///b', path: '/b', name: 'b.txt', fileId: 'f_b' });

  it('emits ready file entries in doc order, with rewrite ids mirroring the payload', () => {
    const { promptAttachments, rewriteAttIds } = buildFileSubmitPayload(['bb', 'aa'], [ready, ready2]);
    expect(rewriteAttIds).toEqual(['bb', 'aa']);
    expect(promptAttachments).toEqual([
      { fileId: 'f_b', kind: 'file', sessionId: undefined, name: 'b.txt', mediaType: undefined, size: 10 },
      { fileId: 'f_a', kind: 'file', sessionId: undefined, name: 'a.txt', mediaType: 'text/plain', size: 10 },
    ]);
  });

  it('skips folders, uploading, errored, and dead pills (their links stay raw)', () => {
    const folder = entry({ attId: 'fo', key: 'file:///f/', kind: 'folder', name: 'f/', fileId: undefined });
    const uploading = entry({ attId: 'up', key: 'file:///u', uploading: true, fileId: undefined });
    const errored = entry({ attId: 'er', key: 'file:///e', error: 'upload-failed', fileId: undefined });
    const { promptAttachments, rewriteAttIds } = buildFileSubmitPayload(
      ['fo', 'up', 'er', 'ghost', 'aa'],
      [ready, folder, uploading, errored],
    );
    expect(rewriteAttIds).toEqual(['aa']);
    expect(promptAttachments).toHaveLength(1);
    expect(promptAttachments[0]!.fileId).toBe('f_a');
  });

  it('returns an empty payload when the doc references nothing', () => {
    expect(buildFileSubmitPayload([], [ready])).toEqual({ promptAttachments: [], rewriteAttIds: [] });
  });
});

describe('seedEntriesForTurnAttachments', () => {
  it('keys the i-th file attachment to its 1-based file ordinal, carrying the fileId', () => {
    const atts: TurnAttachment[] = [
      { kind: 'image', url: 'https://x/img', fileId: 'f_img', name: 'shot.png' },
      { kind: 'file', url: 'https://x/a', fileId: 'f_a', name: 'a.pdf', size: 10, mediaType: 'application/pdf' },
      { kind: 'video', url: 'https://x/v', fileId: 'f_v', name: 'clip.mp4' },
      { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
    ];
    const entries = seedEntriesForTurnAttachments(atts);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      attId: '1',
      key: 'blob:1',
      kind: 'file',
      name: 'a.pdf',
      size: 10,
      mediaType: 'application/pdf',
      uploading: false,
      fileId: 'f_a',
    });
    expect(entries[1]).toMatchObject({ attId: '2', key: 'blob:2', fileId: 'f_b' });
  });

  it('skips file attachments without a fileId (nothing resendable to seed) but keeps their ordinal', () => {
    // The wire's 1..N index counts EVERY file attachment (fileId or not —
    // see attachmentTargetFor): the base64 file occupies ordinal 1, so f_b
    // must key attId '2' — keying it '1' would re-key the second pill onto
    // the first pill's link.
    const entries = seedEntriesForTurnAttachments([
      { kind: 'file', url: '', name: 'a.pdf' },
      { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.attId).toBe('2');
    expect(entries[0]!.fileId).toBe('f_b');
  });

  it('seeds nothing for media-only or legacy chip-era (link-less) messages', () => {
    expect(
      seedEntriesForTurnAttachments([{ kind: 'image', url: 'https://x/img', fileId: 'f_img' }]),
    ).toEqual([]);
  });
});

describe('unreferencedSeedFiles', () => {
  const files: TurnAttachment[] = [
    { kind: 'image', url: 'https://x/img', fileId: 'f_img', name: 'shot.png' },
    { kind: 'file', url: 'https://x/a', fileId: 'f_a', name: 'a.pdf', size: 10 },
    { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
    { kind: 'file', url: '', name: 'no-id.pdf' }, // no fileId — nothing resendable
  ];

  it('returns every file attachment with a fileId when the revived doc references nothing (chip-era message)', () => {
    const unreferenced = unreferencedSeedFiles(files, new Set());
    expect(unreferenced).toEqual([
      { att: files[1], ordinal: 1 },
      { att: files[2], ordinal: 2 },
    ]);
  });

  it('skips the ordinals the doc references (link-era message), keeping the rest', () => {
    // The text revived attachments/1 (a.pdf) but not attachments/2 (b.pdf).
    expect(unreferencedSeedFiles(files, new Set(['1']))).toEqual([{ att: files[2], ordinal: 2 }]);
    expect(unreferencedSeedFiles(files, new Set(['1', '2']))).toEqual([]);
  });

  it('counts fileId-less files toward the ordinal (a base64 file occupies its index)', () => {
    // [base64 (ordinal 1), f_b (ordinal 2)] — same contract as the wire
    // index: referencing attachments/2 keeps f_b, and nothing can adopt the
    // id-less first file.
    const mixed: TurnAttachment[] = [
      { kind: 'file', url: '', name: 'raw.pdf' },
      { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf' },
    ];
    expect(unreferencedSeedFiles(mixed, new Set(['2']))).toEqual([]);
    expect(unreferencedSeedFiles(mixed, new Set(['1']))).toEqual([{ att: mixed[1], ordinal: 2 }]);
    expect(unreferencedSeedFiles(mixed, new Set())).toEqual([{ att: mixed[1], ordinal: 2 }]);
  });
});

describe('pillSubmitBlockers (the send gate’s pill verdict)', () => {
  it('is clear for ready entries', () => {
    expect(pillSubmitBlockers([entry()])).toEqual({ uploading: false, errored: false, missing: false });
    expect(pillSubmitBlockers([])).toEqual({ uploading: false, errored: false, missing: false });
  });

  it('flags an in-flight upload', () => {
    const uploading = entry({ uploading: true, fileId: undefined });
    expect(pillSubmitBlockers([entry(), uploading])).toEqual({ uploading: true, errored: false, missing: false });
  });

  it('flags an errored entry — a HARD block (the submit payload would silently drop it)', () => {
    const failed = entry({ error: 'upload-failed', fileId: undefined });
    const interrupted = entry({ error: 'upload-interrupted', fileId: undefined });
    expect(pillSubmitBlockers([entry(), failed])).toEqual({ uploading: false, errored: true, missing: false });
    expect(pillSubmitBlockers([interrupted])).toEqual({ uploading: false, errored: true, missing: false });
  });

  it('flags both when an upload is in flight next to a failed one', () => {
    const uploading = entry({ attId: 'up000001', uploading: true, fileId: undefined });
    const failed = entry({ error: 'upload-failed', fileId: undefined });
    expect(pillSubmitBlockers([uploading, failed])).toEqual({ uploading: true, errored: true, missing: false });
  });

  it('flags a doc attId with NO registry entry — the undo-resurrected dead pill', () => {
    // The pill renders struck-through and the payload would silently drop
    // its link; the gate must block like it does for an errored entry. The
    // uploading/errored flags stay driven by the entries alone.
    const ready = entry({ attId: 'live0001' });
    expect(pillSubmitBlockers([ready], ['live0001', 'ghost001'])).toEqual({
      uploading: false,
      errored: false,
      missing: true,
    });
    const uploading = entry({ attId: 'up000001', uploading: true, fileId: undefined });
    expect(pillSubmitBlockers([uploading], ['up000001', 'ghost001'])).toEqual({
      uploading: true,
      errored: false,
      missing: true,
    });
  });

  it('stays clear when every doc attId has a registry entry', () => {
    const ready = entry({ attId: 'live0001' });
    expect(pillSubmitBlockers([ready], ['live0001'])).toEqual({ uploading: false, errored: false, missing: false });
    expect(pillSubmitBlockers([ready], [])).toEqual({ uploading: false, errored: false, missing: false });
  });

  it('never flags missing without the doc attIds (back-compat: the registry mirror alone can’t see dead pills)', () => {
    expect(pillSubmitBlockers([entry()]).missing).toBe(false);
  });
});

describe('editRefillAttachments (the edit&resend positional rebuild)', () => {
  const f1: TurnAttachment = { kind: 'file', url: 'https://x/a', fileId: 'f_a', name: 'a.pdf', size: 1 };
  const f2: TurnAttachment = { kind: 'file', url: 'https://x/b', fileId: 'f_b', name: 'b.pdf', size: 2 };
  const img: TurnAttachment = { kind: 'image', url: 'https://x/img', fileId: 'f_img', name: 'shot.png' };

  it('rebuilds a partially-referenced turn without duplicates, files in ordinal order, media kept', () => {
    // The text references only file 2: file 1 stayed in the chip row while
    // inlineAttachments keeps the complete positional list. Concatenating
    // the two lists would give [f1, f1, f2] — duplicated AND mis-ordered
    // (seedEntriesForTurnAttachments would re-key attachments/2 onto f1).
    const refill = editRefillAttachments({ attachments: [f1, img], inlineAttachments: [f1, f2] });
    expect(refill).toEqual([img, f1, f2]);
    // …and the downstream ordinal seeding stays aligned with the links.
    expect(seedEntriesForTurnAttachments(refill).map((e) => [e.attId, e.fileId])).toEqual([
      ['1', 'f_a'],
      ['2', 'f_b'],
    ]);
  });

  it('is just media + files for a dense pill-flow turn (no chip-row files left)', () => {
    expect(editRefillAttachments({ attachments: [img], inlineAttachments: [f1, f2] })).toEqual([img, f1, f2]);
  });

  it('falls back to the chip row’s files for a legacy (link-less) turn', () => {
    expect(editRefillAttachments({ attachments: [f1, img, f2] })).toEqual([img, f1, f2]);
    expect(editRefillAttachments({})).toEqual([]);
  });
});

describe('interleaveSubmitAttachments (the payload’s add-order interleave)', () => {
  const f = (name: string, seq?: number) => ({ item: `file:${name}`, seq });
  const m = (name: string, seq?: number) => ({ item: `media:${name}`, seq });

  it('interleaves by the shared stamp without ever reordering within a family', () => {
    // add order: image(1) → fileA(2) → video(3) → fileB(4)
    expect(
      interleaveSubmitAttachments(
        [f('a', 2), f('b', 4)],
        [m('img', 1), m('vid', 3)],
      ),
    ).toEqual(['media:img', 'file:a', 'media:vid', 'file:b']);
  });

  it('keeps the file family’s doc order even when it disagrees with the stamps (the index contract)', () => {
    // The user added a(1) then b(2), then moved b's pill before a's in the
    // text: the payload's file order must stay the DOC order [b, a] or the
    // 1..N link indices would point at the wrong files.
    expect(interleaveSubmitAttachments([f('b', 2), f('a', 1)], [])).toEqual(['file:b', 'file:a']);
  });

  it('keeps the media family’s add order among themselves', () => {
    expect(
      interleaveSubmitAttachments(
        [f('x', 2)],
        [m('first', 1), m('second', 3), m('third', 4)],
      ),
    ).toEqual(['media:first', 'file:x', 'media:second', 'media:third']);
  });

  it('sorts unstamped leftovers first in group order (pre-seq drafts predate any stamp)', () => {
    expect(
      interleaveSubmitAttachments(
        [f('old1'), f('new', 5)],
        [m('old2'), m('new', 6)],
      ),
    ).toEqual(['file:old1', 'media:old2', 'file:new', 'media:new']);
  });

  it('degenerates gracefully with one or both families empty', () => {
    expect(interleaveSubmitAttachments([], [m('a', 1)])).toEqual(['media:a']);
    expect(interleaveSubmitAttachments([f('a', 1)], [])).toEqual(['file:a']);
    expect(interleaveSubmitAttachments([], [])).toEqual([]);
  });
});

describe('restampRefillByOrderHint (the edit&resend interleave restore)', () => {
  it('stamps both families from the message’s appearance order, not media-first', () => {
    // Original message: file, image, file — the refill must keep that
    // interleave (an unstamped pass would produce image, file, file).
    const media: TurnAttachment[] = [{ kind: 'image', url: 'https://x/img', fileId: 'f_img', orderHint: 1 }];
    const fileSeeds = [
      entry({ attId: '1', key: 'blob:1', fileId: 'f_a' }),
      entry({ attId: '2', key: 'blob:2', fileId: 'f_b' }),
    ];
    const fileSources: TurnAttachment[] = [
      { kind: 'file', url: 'https://x/a', fileId: 'f_a', orderHint: 0 },
      { kind: 'file', url: 'https://x/b', fileId: 'f_b', orderHint: 2 },
    ];
    const stamped = restampRefillByOrderHint(media, fileSeeds, fileSources);
    expect(stamped).toHaveLength(1);
    expect(fileSeeds[0]!.seq).toBeLessThan(stamped[0]!.seq!);
    expect(stamped[0]!.seq).toBeLessThan(fileSeeds[1]!.seq!);
  });

  it('keeps an image-first payload image-first (the part-order regression)', () => {
    // Payload order [image, file]: the refill must NOT flip to file-first —
    // the text part always leads the persisted message and holds the file's
    // link, so any text-offset scheme would invert this.
    const media: TurnAttachment[] = [{ kind: 'image', url: 'https://x/img', fileId: 'f_img', orderHint: 0 }];
    const fileSeeds = [entry({ attId: '1', key: 'blob:1', fileId: 'f_a' })];
    const fileSources: TurnAttachment[] = [{ kind: 'file', url: 'https://x/a', fileId: 'f_a', orderHint: 1 }];
    const stamped = restampRefillByOrderHint(media, fileSeeds, fileSources);
    expect(stamped[0]!.seq).toBeLessThan(fileSeeds[0]!.seq!);
  });

  it('keeps the group order for hint-less (legacy) refills — media first, then files', () => {
    const media: TurnAttachment[] = [
      { kind: 'image', url: 'https://x/i1', fileId: 'f_i1' },
      { kind: 'video', url: 'https://x/v1', fileId: 'f_v1' },
    ];
    const fileSeeds = [entry({ attId: '1', key: 'blob:1', fileId: 'f_a' })];
    const stamped = restampRefillByOrderHint(media, fileSeeds, []);
    // Media stamped before files, and in their original relative order.
    expect(stamped[0]!.seq).toBeLessThan(stamped[1]!.seq!);
    expect(stamped[1]!.seq).toBeLessThan(fileSeeds[0]!.seq!);
  });
});


describe('applyEntryPatch (the history-browse snapshot updater)', () => {
  it('patches the matching entry and leaves others untouched', () => {
    const entries = [entry({ attId: 'a1', uploading: true }), entry({ attId: 'b2', uploading: true })];
    const next = applyEntryPatch(entries, 'b2', { fileId: 'f_done', uploading: false, error: undefined });
    expect(next[0]).toEqual(entries[0]);
    expect(next[1]).toMatchObject({ attId: 'b2', fileId: 'f_done', uploading: false });
    expect(next[1]!.error).toBeUndefined();
  });

  it('is a no-op for an unknown attId (a patch for an entry the snapshot never held)', () => {
    const entries = [entry({ attId: 'a1', uploading: true })];
    expect(applyEntryPatch(entries, 'zz', { uploading: false })).toEqual(entries);
  });
});
