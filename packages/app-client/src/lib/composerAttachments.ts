// packages/app-client/src/lib/composerAttachments.ts
// Pure helpers for the composer's attachment-pill flow (both apps wire them
// to the live editor in their Composer.vue): same-key reuse planning for
// dropped/picked/pasted files and folders, the submit payload assembly
// (doc-ordered file entries → PromptAttachment[] plus the link-rewrite attId
// list), and registry seeding for queue/edit refills.
// DOM-free so node tests can drive it.

import { attachmentKeyFor, newAttId, nextAttachmentSeq, normalizeAttachmentPath } from '@moonshot-ai/app-composer';
import type { AttachmentEntry } from '@moonshot-ai/app-composer';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import type { PromptAttachment } from '../client/types';

/** The plan for one incoming file: which attId its pill gets, the registry
 *  entry to upsert (null when an existing entry is reused by key), and
 *  whether the caller must (re)start the upload. The insert contract the
 *  caller (both composers) follows: `entry` non-null → insert the pill THEN
 *  upsert (the registry is doc-reconciled); `entry` null + `startUpload`
 *  true → a restart on an entry the doc ALREADY references (error/version
 *  retry) — do NOT insert another pill, the existing one IS the attachment;
 *  `entry` null + `startUpload` false → a same-version reuse, where a
 *  second pill is a deliberate multi-reference. */
export interface FileAttachmentPlan {
  attId: string;
  /** Fresh entry to upsert AFTER the pill insert (the registry is
   *  doc-reconciled — an entry whose pill isn't in the doc yet is dropped).
   *  Null on key reuse. */
  entry: AttachmentEntry | null;
  /** True when the upload should (re)start: a fresh entry always uploads; a
   *  reused entry re-uploads only when its previous upload failed or was
   *  interrupted — re-dropping a file whose pill went dead must not stay
   *  dead. A ready or in-flight entry is left alone. */
  startUpload: boolean;
}

/** Plan a file pill for a dropped/picked/pasted file. A path-backed file
 *  dedups on its normalized file:// key (one upload, many pills share the
 *  entry) — but only while the bytes on disk are STILL the recorded ones:
 *  a size or lastModified mismatch means the file changed since the entry's
 *  upload, and the plan re-uploads on the same entry (silently sending the
 *  old fileId under a fresh drop would be invisible); if the mismatch
 *  arrives while the old upload is STILL IN FLIGHT, the plan mints an
 *  independent entry instead (new attId + upload — the old upload's
 *  completion patches only the old entry, and each pill carries the version
 *  it was dropped with). Pathless bytes (a clipboard paste, or any web file
 *  — no bridge to resolve a path) key on their own attId and never dedup —
 *  same as the chip era, with ONE exception: a pathless entry whose upload
 *  failed/interrupted matches a re-drop of the same file, so the retry
 *  revives THAT entry (the same error-restart branch as the path-backed key
 *  reuse) instead of minting a second one — otherwise the old pill would
 *  keep its error and block the send gate even after the new upload
 *  succeeded, making the error tooltip's "drop the file in again" remedy a
 *  lie. The retry match must be UNAMBIGUOUS though: exactly one errored
 *  pathless entry by name+size (a lastModified tiebreak when several share
 *  both) — two same-named, same-sized failures from different sources are
 *  indistinguishable, and reusing the wrong one would silently swap the
 *  bytes each pill sends, so an ambiguous re-drop mints a fresh entry
 *  instead. */
export function planFileAttachment(
  entries: readonly AttachmentEntry[],
  args: { name: string; size: number; path: string | null; mediaType?: string; lastModified?: number; seq?: number },
): FileAttachmentPlan {
  const path = args.path === null ? undefined : normalizeAttachmentPath(args.path);
  if (path !== undefined) {
    const key = attachmentKeyFor({ kind: 'file', path, attId: '' });
    // A mid-upload version change mints a SECOND entry on the same key (see
    // below) — prefer the newest same-key entry so a later re-drop compares
    // versions against the latest upload, not the stale first one.
    const existing = entries.findLast((entry) => entry.key === key);
    if (existing) {
      // Version check (see the header note). A missing marker can't prove a
      // change — only a RECORDED mismatch counts (an entry restored from a
      // pre-versioning sidecar keeps the old reuse behavior).
      const versionChanged =
        (existing.size !== undefined && existing.size !== args.size) ||
        (existing.lastModified !== undefined &&
          args.lastModified !== undefined &&
          existing.lastModified !== args.lastModified);
      // A changed file re-dropped MID-UPLOAD falls through to mint an
      // INDEPENDENT entry (new attId, new upload): reusing the attId would
      // let the in-flight upload's OLD fileId serve the new pill too — each
      // pill must carry the version it was dropped with. The old upload's
      // completion still patches only the old entry (the callback addresses
      // sid+attId), whose pill keeps the old version; the new entry uploads
      // the new bytes with no cross-talk. The non-uploading branches are
      // untouched (a ready entry still restarts on a version change).
      if (!(existing.uploading && versionChanged)) {
        return {
          attId: existing.attId,
          entry: null,
          startUpload:
            !existing.uploading &&
            (versionChanged || existing.error !== undefined || existing.fileId === undefined),
        };
      }
    }
  } else {
    let candidates = entries.filter(
      (entry) =>
        entry.kind === 'file' &&
        entry.path === undefined &&
        entry.error !== undefined &&
        !entry.uploading &&
        entry.name === args.name &&
        entry.size === args.size,
    );
    if (candidates.length > 1 && args.lastModified !== undefined) {
      const byMtime = candidates.filter((entry) => entry.lastModified === args.lastModified);
      if (byMtime.length === 1) candidates = byMtime;
    }
    if (candidates.length === 1) return { attId: candidates[0]!.attId, entry: null, startUpload: true };
  }
  const attId = newAttId();
  return {
    attId,
    entry: {
      attId,
      key: attachmentKeyFor({ kind: 'file', path, attId }),
      kind: 'file',
      name: args.name,
      size: args.size,
      mediaType: args.mediaType,
      lastModified: args.lastModified,
      // A batch-pre-assigned stamp (routeFiles) wins so one batch's files
      // and media interleave by selection order; otherwise stamp now.
      seq: args.seq ?? nextAttachmentSeq(),
      path,
      refCount: 1,
      uploading: true,
    },
    startUpload: true,
  };
}

/** The plan for one dropped/pasted folder (folders are never uploaded). */
export interface FolderAttachmentPlan {
  attId: string;
  /** Display name: the path's basename with the folder's trailing '/'; a
   *  root path ('/', 'C:/') has no basename and shows the root itself. */
  name: string;
  /** Fresh entry to upsert after the pill insert — null on key reuse. */
  entry: AttachmentEntry | null;
}

/** Plan a folder pill. Same key-reuse rule as files: re-dropping a folder
 *  the doc already references just adds another pill on the same entry. */
export function planFolderAttachment(
  entries: readonly AttachmentEntry[],
  rawPath: string,
): FolderAttachmentPlan {
  const path = normalizeAttachmentPath(rawPath);
  const base = path.split('/').pop() ?? rawPath;
  // A ROOT path ('/', 'C:/', '//') has no basename — the pill shows the root
  // itself. Either way the name keeps its trailing '/': it doubles as the
  // folder kind marker on the wire (revive infers the kind from it).
  const name = base === '' ? path : `${base}/`;
  const key = attachmentKeyFor({ kind: 'folder', path, attId: '' });
  const existing = entries.find((entry) => entry.key === key);
  if (existing) return { attId: existing.attId, name, entry: null };
  const attId = newAttId();
  return {
    attId,
    name,
    entry: { attId, key, kind: 'folder', name, path, refCount: 1, uploading: false },
  };
}

/** Submit assembly: walk the doc's attachment attIds (first-mention order),
 *  keep the READY file entries (uploaded, not uploading, no error), and emit
 *  them as PromptAttachments in that order. rewriteAttIds mirrors the
 *  payload's order — it is the index-normalization list for
 *  rewriteAttachmentLinksForSubmit, so the text's rewritten 1..N link
 *  indices line up with the payload positions (and with the server's
 *  trailing attachments notice). Folder entries never enter the payload
 *  (their links become path mentions instead), and dead/errored pills are
 *  skipped here so their links keep the raw attId form (accepted semantics). */
export function buildFileSubmitPayload(
  orderedAttIds: readonly string[],
  entries: readonly AttachmentEntry[],
): { promptAttachments: PromptAttachment[]; rewriteAttIds: string[] } {
  const byAttId = new Map(entries.map((entry) => [entry.attId, entry]));
  const promptAttachments: PromptAttachment[] = [];
  const rewriteAttIds: string[] = [];
  for (const attId of orderedAttIds) {
    const entry = byAttId.get(attId);
    if (!entry) continue; // dead pill (undo-resurrected, sidecar gone)
    if (entry.kind !== 'file') continue; // folders are never uploaded
    if (entry.uploading || entry.error !== undefined || entry.fileId === undefined) continue;
    rewriteAttIds.push(attId);
    promptAttachments.push({
      fileId: entry.fileId,
      kind: 'file',
      sessionId: undefined,
      name: entry.name,
      mediaType: entry.mediaType,
      size: entry.size,
    });
  }
  return { promptAttachments, rewriteAttIds };
}

/** The send gate's pill verdict over the doc-referenced entries (the
 *  registry is doc-reconciled, so every entry IS referenced). All three
 *  flags block submission:
 *  - uploading: an upload still in flight — submitting would send the
 *    message WITHOUT the file; the user simply submits again in a moment.
 *  - errored: a failed/interrupted upload — a HARD block, because the
 *    submit payload would silently drop the entry (buildFileSubmitPayload
 *    skips errored entries) and its pill would degrade to a bare name,
 *    sending a message that's missing its attachment without any sign. The
 *    pill shows the error state; the user deletes it or re-drops the file
 *    (planFileAttachment restarts a failed/interrupted upload on key reuse).
 *  - missing: a doc attId with NO registry entry — the dead pill of an
 *    undo-resurrected deletion (the reconcile dropped the entry for good
 *    and never invents metadata; it renders struck-through via
 *    .attachment-missing). Same silent-drop failure as errored: the payload
 *    skips it and the link degrades to a bare name, so the user must delete
 *    the pill or re-drop the file. Pass the doc's attIds (the caller's
 *    editor) for this flag — the registry mirror alone can't see them;
 *    without it the flag stays false (back-compat). */
export function pillSubmitBlockers(
  entries: readonly AttachmentEntry[],
  docAttIds?: readonly string[],
): { uploading: boolean; errored: boolean; missing: boolean } {
  let uploading = false;
  let errored = false;
  for (const entry of entries) {
    if (entry.uploading) uploading = true;
    if (entry.error !== undefined) errored = true;
  }
  let missing = false;
  if (docAttIds !== undefined) {
    const known = new Set(entries.map((entry) => entry.attId));
    missing = docAttIds.some((attId) => !known.has(attId));
  }
  return { uploading, errored, missing };
}

/** Apply an upload-outcome patch to a registry entry LIST (returns a new
 *  array — entries are never mutated in place). Used by patchPillEntry to
 *  keep the history-browse snapshot current: an upload completing
 *  mid-browse must reach the snapshot the walk-back restores from, or the
 *  draft comes back stuck on the pre-completion state (uploading forever).
 *  Unknown attIds are a no-op (a patch for an entry the snapshot never
 *  held). */
export function applyEntryPatch(
  entries: readonly AttachmentEntry[],
  attId: string,
  patch: Partial<Omit<AttachmentEntry, 'attId' | 'key' | 'refCount'>>,
): AttachmentEntry[] {
  return entries.map((entry) => (entry.attId === attId ? { ...entry, ...patch } : entry));
}

/** The submit payload's interleave: the ready FILE pills (in doc
 *  first-mention order — the wire's 1..N link index contract, which counts
 *  only files and doesn't care where media sits) merged with the ready
 *  MEDIA chips (add order) by the shared add-order stamp
 *  (AttachmentEntry.seq / the chip's seq — one clock, see
 *  nextAttachmentSeq). A stable two-family merge: seq order wins across
 *  families, but NO family is ever reordered internally (file-file order
 *  is the index contract). Unstamped items (a pre-seq draft's leftovers)
 *  sort FIRST in group order — they predate anything stamped, and
 *  payload order is only an ordering nicety, never a correctness input. */
export function interleaveSubmitAttachments<T>(
  files: ReadonlyArray<{ item: T; seq?: number }>,
  media: ReadonlyArray<{ item: T; seq?: number }>,
): T[] {
  const out: T[] = [];
  let fi = 0;
  let mi = 0;
  while (fi < files.length || mi < media.length) {
    const file = files[fi];
    const medium = media[mi];
    if (file !== undefined && (medium === undefined || (file.seq ?? Number.NEGATIVE_INFINITY) <= (medium.seq ?? Number.NEGATIVE_INFINITY))) {
      out.push(file.item);
      fi += 1;
    } else if (medium !== undefined) {
      out.push(medium.item);
      mi += 1;
    }
  }
  return out;
}

/** The edit&resend refill's attachment list: the turn's MEDIA attachments
 *  (they refill the chip strip) plus its FILE attachments in their original
 *  positional order (they seed the revived pills — see
 *  seedEntriesForTurnAttachments' ordinal contract). A pill-flow turn keeps
 *  the COMPLETE positional file list in inlineAttachments — only files a
 *  valid inline link targets leave its chip row, so the two lists OVERLAP
 *  and concatenating them would duplicate the unreferenced files and shift
 *  every later file's seeding ordinal (`attachments/2` would re-key the
 *  wrong file). Files therefore come from inlineAttachments whenever it
 *  exists; a legacy (link-less) turn has none, and its files all live in
 *  the chip row list. */
export function editRefillAttachments(turn: {
  attachments?: readonly TurnAttachment[];
  inlineAttachments?: readonly TurnAttachment[];
}): TurnAttachment[] {
  const media = (turn.attachments ?? []).filter((att) => att.kind !== 'file');
  const files = turn.inlineAttachments ?? (turn.attachments ?? []).filter((att) => att.kind === 'file');
  return [...media, ...files];
}

/** Re-stamp a message refill's add-order stamps from the message's own
 *  payload order (TurnAttachment.orderHint — the persisted content-part
 *  sequence, NOT the link offsets inside the always-first text part): the
 *  media list comes back hint-sorted with fresh stamps, and the file seed
 *  entries are stamped in place through the SAME hint walk — so the resent
 *  payload's interleaveSubmitAttachments reproduces the original
 *  media/file interleave instead of collapsing to media-first (a "file,
 *  image" message would otherwise resend as "image, file"). Hint-less
 *  items (a legacy message) keep the current group order — media first,
 *  then files, exactly the pre-stamp behavior. `fileSources` is the seed
 *  entries' source list (the fileId-bearing file attachments in the same
 *  ordinal order — see seedEntriesForTurnAttachments). */
export function restampRefillByOrderHint(
  media: readonly TurnAttachment[],
  fileSeeds: AttachmentEntry[],
  fileSources: readonly TurnAttachment[],
): TurnAttachment[] {
  const stampedMedia = media.map((att) => ({ ...att }));
  const items = [
    ...stampedMedia.map((att, index) => ({
      hint: att.orderHint,
      apply: (seq: number) => {
        stampedMedia[index] = { ...stampedMedia[index]!, seq };
      },
    })),
    ...fileSeeds.map((entry, index) => ({
      hint: fileSources[index]?.orderHint,
      apply: (seq: number) => {
        entry.seq = seq;
      },
    })),
  ];
  // Hint order wins; ties keep the WALK order (media group first, then
  // files — the pre-stamp behavior for hint-less legacy refills).
  items
    .map((item, walkIndex) => ({ ...item, walkIndex }))
    .sort(
      (a, b) =>
        (a.hint ?? Number.POSITIVE_INFINITY) - (b.hint ?? Number.POSITIVE_INFINITY) ||
        a.walkIndex - b.walkIndex,
    )
    .forEach((item) => item.apply(nextAttachmentSeq()));
  return stampedMedia;
}

/** Registry seed entries for a queue/edit refill: the message's file
 *  attachments (payload order) correspond 1:1 to the submitted text's
 *  rewritten `attachments/1..N` links, so the i-th FILE attachment re-keys
 *  the revived pill whose attId is its 1-based file ordinal. The ordinal
 *  counts EVERY file attachment — the wire's index does (see
 *  attachmentTargetFor, which never looks at fileId) — so a fileId-less
 *  inline-base64 file occupies its ordinal but seeds nothing (nothing
 *  resendable); skipping it in the count would shift every later file's
 *  entry onto the wrong revived pill. The fileId rides along — nothing
 *  re-uploads. The path is unknown, so the key is `blob:<attId>` (no dedup
 *  against path-backed entries). Media attachments are NOT here — they
 *  refill the chip strip through the old loadAttachments path. Callers
 *  upsert only the entries the revived doc actually references. */
export function seedEntriesForTurnAttachments(atts: readonly TurnAttachment[]): AttachmentEntry[] {
  const entries: AttachmentEntry[] = [];
  let ordinal = 0;
  for (const att of atts) {
    if (att.kind !== 'file') continue;
    ordinal += 1;
    if (att.fileId === undefined) continue;
    const attId = String(ordinal);
    entries.push({
      attId,
      key: attachmentKeyFor({ kind: 'file', attId }),
      kind: 'file',
      name: att.name ?? att.kind,
      size: att.size,
      mediaType: att.mediaType,
      // A refill IS an add: the interleave stamp keeps the payload's
      // media/file order honest (see interleaveSubmitAttachments).
      seq: nextAttachmentSeq(),
      refCount: 1,
      uploading: false,
      fileId: att.fileId,
    });
  }
  return entries;
}

/** The message's file attachments the revived doc does NOT reference — the
 *  same ordinal walk as seedEntriesForTurnAttachments (the i-th file
 *  attachment with a fileId would key attId `${i}`), keeping the ones whose
 *  attId never appears as an attachment link in the refilled text. Chip-era
 *  messages (pre-pill, link-less text) land here ENTIRELY: their files would
 *  otherwise fall between the pill seeding (nothing references them) and the
 *  media-only strip refill, silently vanishing on edit&resend. The caller
 *  adopts them as appended in-document pills (fileId reused). */
export function unreferencedSeedFiles(
  atts: readonly TurnAttachment[],
  referencedAttIds: ReadonlySet<string>,
): { att: TurnAttachment; ordinal: number }[] {
  const unreferenced: { att: TurnAttachment; ordinal: number }[] = [];
  let ordinal = 0;
  for (const att of atts) {
    if (att.kind !== 'file') continue;
    ordinal += 1;
    // Same ordinal contract as the wire index (EVERY file attachment counts,
    // fileId or not — see seedEntriesForTurnAttachments): a fileId-less
    // inline-base64 file occupies its ordinal but has nothing to adopt.
    if (att.fileId === undefined) continue;
    if (!referencedAttIds.has(String(ordinal))) unreferenced.push({ att, ordinal });
  }
  return unreferenced;
}
