// packages/app-client/src/composables/useAttachmentUpload.ts
// Attachment handling for the composer: file picker, paste, drag & drop, the
// upload machinery, the chip strip, and the preview lightbox. Images and
// videos get media chips with thumbnails; any other file type attaches as a
// generic file chip (an icon + name, no thumbnail) and is sent as a file part
// — UNLESS the caller injects the `insertFileAttachment` seam (both apps'
// composers do), which routes non-media files to in-document attachment pills
// instead (see routeFiles). Dropped or pasted folders are the exception: they
// are never uploaded (the endpoint rejects them) — the desktop bridge resolves
// their absolute paths and they are inserted as in-document folder pills
// instead (see nativeWorkspaceDrop.ts).
//
// Pending attachments are scoped per session (keyed by session id) so switching
// sessions can't leak one session's unsent attachments into another session's
// next submit. Ready attachments (upload completed, daemon file id known) also
// persist to localStorage per session scope, so they survive the composer
// unmounting — switching away from the New Session page and back, or a page
// refresh — exactly like the text draft (see "Draft persistence" below). The
// upload bookkeeping lives at module level (see "Module-level upload
// bookkeeping"), so an upload that finishes AFTER the composer unmounted still
// lands its file id in the stored draft — an unmount never aborts an upload.
// The composer keeps `handleSubmit`/`handleSteer` (which read the
// attachments to build the payload) and the `hasUpload` toolbar flag; this
// composable owns the attachment state, all the file-input UI handlers, and the
// paste listener + object-URL cleanup lifecycle.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import { track } from '../contracts';
import {
  attachmentDraftStorageKey,
  partitionDroppedItems,
  partitionPastedItems,
  resolveFilePath,
  safeGetJson,
  safeRemove,
  safeSetJson,
  type DroppedItem,
} from '@moonshot-ai/app-core/lib';
import { promptAttachmentToTurnAttachment } from '../client/attachmentsToContent';
import { nextAttachmentSeq, noteAttachmentSeq } from '@moonshot-ai/app-composer';
import type { PromptAttachment } from '../client/types';

export interface Attachment {
  /** Unique local id (used as :key) */
  localId: string;
  /** File name */
  name: string;
  /** image, video, or any other file — drives the chip preview and the content-block type. */
  kind: 'image' | 'video' | 'file';
  /** Object URL for the thumbnail preview (unset for file attachments — those render an icon chip). */
  previewUrl?: string;
  /** Local MIME of the picked file — echoed into the wire file part. */
  mediaType?: string;
  /** Local byte size of the picked file — echoed into the wire file part. */
  size?: number;
  /** Add-order stamp from the shared clock (app-composer's
   *  nextAttachmentSeq) — the submit payload's media/file interleave key
   *  (see interleaveSubmitAttachments in app-client's composerAttachments). */
  seq?: number;
  /** True while uploading */
  uploading: boolean;
  /** Resolved daemon file id (set after upload completes) */
  fileId?: string;
  /** Set when `fileId` belongs to the session media store rather than the
      global upload store. */
  sessionId?: string;
  /** True if upload failed */
  error?: boolean;
}

type UploadImage = (
  file: Blob,
  name?: string,
) => Promise<{ fileId: string; name: string; mediaType: string } | null>;

export interface AttachmentUploadDeps {
  /** Authenticated file-byte fetch — a bare getFileUrl src 401s under daemon
      auth, so protected thumbnails load through the API client. The URL
      builders rebuild a restored draft's preview/lightbox target. */
  api: Pick<KimiWebApi, 'getFileBlob' | 'getSessionMediaBlob' | 'getFileUrl' | 'getSessionMediaUrl'>;
  /** Upload a blob; resolves to the daemon file id, or null on failure.
      Getter so a prop change is picked up. Undefined disables attaching. */
  uploadImage: () => UploadImage | undefined;
  /** Active session id — scopes pending attachments (getter for reactivity). */
  sessionId: () => string | undefined;
  /** Dropped or pasted folders are never uploaded (the endpoint rejects
      them) — the desktop bridge resolves their absolute paths and the
      composer inserts them as in-document folder pills. Without the bridge
      a folder resolves to no path and is simply ignored. */
  insertFolderPaths?: (paths: string[]) => void;
  /** Attachment-pill seam (a caller without it keeps exactly the old chip
      flow): a NON-MEDIA file (kind 'file') is offered to the composer's
      in-document attachment pills BEFORE the chip/upload-strip path. Return
      true = handled as a pill (skip addFiles for it). Media (image/video)
      never routes here. `path` is the file's absolute path resolved through
      the desktop bridge (null when the bridge is absent or can't resolve it
      — the pill then keys on its own id). `at` carries drop coordinates so
      the pill can land at the drop point; picker/paste leave it undefined
      (insert at the caret). `seq` is the batch's pre-assigned add-order
      stamp (routeFiles assigns in batch order) — the pill's registry entry
      takes it so files and media of one batch interleave correctly. */
  insertFileAttachment?: (
    file: File,
    path: string | null,
    at?: { clientX: number; clientY: number },
    seq?: number,
  ) => boolean;
  /** LEGACY (transitional, safe to delete later): adoption of CHIP-ERA file
      attachment drafts as in-document pills. Only needed while (a) chip-era
      persisted drafts (written by pre-pill clients) can still be rehydrated,
      and (b) pre-pill history messages can still be edit&resent. Once stale
      chip drafts / chip-era history no longer matter, delete this dep, the
      hydrateDraft partition below, and the composer implementations
      (Composer.vue's adoptFileAttachment + pendingFileAdoptions). A caller
      without it rehydrates file drafts as chips as before. Media always
      rehydrates as chips. Two drives exist: setup/mount adopts immediately
      (the composer's pendingFileAdoptions buffer covers the not-yet-mounted
      editor); the SESSION-SWITCH hydrate leaves files stored, and the
      composer drives the returned adoptStoredFileDrafts at the end of its
      own session watcher, after the editor holds the new session again. */
  adoptFileAttachment?: (att: TurnAttachment) => void;
}

// -------------------------------------------------------------------------
// Draft persistence. Pending attachments survive the composer unmounting
// (switching between the New Session page and a session view, or a page
// refresh) the same way the text draft does: metadata is written to
// localStorage per session scope and rehydrated on next mount. Only READY
// attachments persist — the entry's daemon file id is the restore handle.
// In-flight uploads (no fileId yet) are not written here — rehydrating them
// would need the local bytes, and base64-inlining file data into localStorage
// is off the table (5 MB quota) — but they are NOT dropped either: the
// module-level upload bookkeeping below merges their file id into the stored
// draft when the upload settles, even if the composer has unmounted by then.
// Failed uploads drop. Thumbnails are NOT stored — restore re-fetches them
// with auth via loadAttachments.
// -------------------------------------------------------------------------

/** localStorage shape of one persisted attachment — mirrors PromptAttachment. */
type PersistedAttachmentDraft = Pick<PromptAttachment, 'fileId' | 'kind' | 'name' | 'mediaType' | 'size' | 'sessionId'> & {
  /** The chip's local id — the merge key the module-level settle folds a
   *  late completion in by. Older drafts without it still validate (the
   *  reader stays lenient); they just can't absorb a late settle, which they
   *  never need to (their uploads settled before they were written). */
  localId?: string;
  /** The chip's add-order stamp — round-tripped so a remount keeps the
   *  payload's media/file interleave instead of re-stamping (a restored
   *  stamp is adopted as-is; only a missing one gets re-stamped at load). */
  seq?: number;
};

function persistForSession(sid: string, atts: readonly Attachment[]): void {
  const key = attachmentDraftStorageKey(sid);
  const ready: PersistedAttachmentDraft[] = [];
  for (const att of atts) {
    if (att.uploading || att.error || !att.fileId) continue;
    ready.push({
      localId: att.localId,
      fileId: att.fileId,
      kind: att.kind,
      name: att.name,
      mediaType: att.mediaType,
      size: att.size,
      sessionId: att.sessionId,
      seq: att.seq,
    });
  }
  if (ready.length === 0) safeRemove(key);
  else safeSetJson(key, ready);
}

/** The validated persisted draft (original order in `valid`, plus the
    kind partitions), or null when nothing usable is stored. Validation
    stays lenient: unknown/missing optional fields (localId included) never
    disqualify an entry. */
function readStoredDraft(sid: string): { valid: PersistedAttachmentDraft[]; media: PersistedAttachmentDraft[]; files: PersistedAttachmentDraft[] } | null {
  const stored = safeGetJson<unknown>(attachmentDraftStorageKey(sid));
  if (!Array.isArray(stored) || stored.length === 0) return null;
  const valid: PersistedAttachmentDraft[] = [];
  for (const entry of stored as Array<Partial<PersistedAttachmentDraft> | null>) {
    if (!entry || typeof entry.fileId !== 'string' || entry.fileId === '') continue;
    if (entry.kind !== 'image' && entry.kind !== 'video' && entry.kind !== 'file') continue;
    valid.push({
      localId: typeof entry.localId === 'string' && entry.localId !== '' ? entry.localId : undefined,
      fileId: entry.fileId,
      kind: entry.kind,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.kind,
      mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : undefined,
      size: typeof entry.size === 'number' ? entry.size : undefined,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
      seq: typeof entry.seq === 'number' ? entry.seq : undefined,
    });
  }
  if (valid.length === 0) return null;
  return {
    valid,
    media: valid.filter((att) => att.kind !== 'file'),
    files: valid.filter((att) => att.kind === 'file'),
  };
}

/** Stable sort by the add-order stamp — unstamped entries (legacy drafts)
 *  sort FIRST, the same ordering nicety as interleaveSubmitAttachments (the
 *  index tiebreak keeps the input order of equal/unstamped entries). Late
 *  settles merge in COMPLETION order, so the storage merge re-sorts to keep
 *  the restored strip and the submit payload in add order. */
function byAddOrder<T extends { seq?: number }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (a.item.seq ?? Number.NEGATIVE_INFINITY) - (b.item.seq ?? Number.NEGATIVE_INFINITY) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}

// -------------------------------------------------------------------------
// Module-level upload bookkeeping. Uploads are NOT aborted when the composer
// unmounts (aborting would lose the file), so a completion can land on a dead
// instance — the bookkeeping that turns it into a persisted draft therefore
// can't live on the instance. Every upload registers HERE, keyed by session
// id + local id; its settle runs at module level:
//  - entry still registered → the outcome merges into the session's stored
//    draft with a storage-layer read-merge-write keyed by localId (NEVER by
//    rewriting an instance's attachment array — a dead instance's stale array
//    would clobber a newer instance's draft);
//  - entry consumed meanwhile (submit's clearAfterSubmit, a manual chip
//    removal, or loadAttachments replacing the strip) → the late outcome is
//    dropped, so an already-sent or deleted attachment can never resurrect.
// Entries leave the table on settle and on every consume path, keeping it
// bounded. A live composer instance keeps updating its own reactive state on
// completion exactly as before — that is all the `disposed` guard still owns.
//
// Storage alone leaves one gap: a composer that REMOUNTED (hydrating an
// empty/partial storage draft) while the upload was still in flight never
// learns about the settle until its NEXT mount — a submit before that would
// send a payload without the attachment. So a mounted instance also
// registers itself in liveAttachmentInstances under its session id, and a
// settle delivers the entry to a live same-session receiver, which inserts
// the chip into its own strip. Single realm only — no cross-tab machinery.
// -------------------------------------------------------------------------

let localIdCounter = 0;
function nextLocalId(): string {
  // Module-level, not per instance: instance-scoped counters all start at
  // att_1, so two composers' chips could share a localId — and localId is
  // the registry/merge key, which must be unique across instances.
  return `att_${++localIdCounter}`;
}

/** Bookkeeping for one in-flight upload — the metadata the storage merge
    needs to write the settled draft entry without the (possibly dead)
    instance's chip. */
interface PendingUpload {
  /** Entries are registered `uploading` and leave the table the moment they
      settle (ready/error), so `uploading` is the only status ever at rest. */
  status: 'uploading' | 'ready' | 'error';
  fileId?: string;
  name: string;
  kind: Attachment['kind'];
  mediaType?: string;
  size?: number;
  /** Mirrors Attachment.sessionId — set when the file id belongs to the
      session media store rather than the global upload store. */
  sessionId?: string;
  seq?: number;
}

const pendingUploads = new Map<string, PendingUpload>();

function pendingUploadKey(sid: string, localId: string): string {
  return `${sid}\n${localId}`;
}

function registerPendingUpload(sid: string, localId: string, meta: Omit<PendingUpload, 'status' | 'fileId'>): void {
  pendingUploads.set(pendingUploadKey(sid, localId), { status: 'uploading', ...meta });
}

/** Drop one entry WITHOUT settling it — the chip was removed by hand. */
function dropPendingUpload(sid: string, localId: string): void {
  pendingUploads.delete(pendingUploadKey(sid, localId));
}

/** Consume every in-flight entry of one session: submit (clearAfterSubmit)
    sends the chips and loadAttachments' replace discards them — either way
    their late settles must find nothing left to merge. */
function consumePendingUploads(sid: string): void {
  const prefix = `${sid}\n`;
  for (const key of pendingUploads.keys()) {
    if (key.startsWith(prefix)) pendingUploads.delete(key);
  }
}

/** A delivery target for settles: a live composer's strip, or a mounted
    instance's in-memory cache of a session it is not live for. */
interface AttachmentSink {
  /** Settled drafts: append new ones, swap restored in-flight chips for the
      ready entry (dedup by localId, so the ORIGINATING instance's own chip —
      which its completion handler patches — is left alone). */
  merge(sid: string, drafts: PersistedAttachmentDraft[]): void;
  /** Failed settles: remove chips that were restored from the registry while
      the upload was in flight — nothing else. */
  drop(sid: string, localIds: string[]): void;
}

/** Live composer instances by session id — the delivery target for a settle
    that lands AFTER a same-session remount already hydrated (too early) from
    storage. An instance registers at setup, follows its session id when the
    composer switches sessions, and unregisters on unmount. Storage stays the
    cross-mount channel; this map only closes the gap between the storage
    write and the next mount for the instance already on screen. */
const liveAttachmentInstances = new Map<string, AttachmentSink>();

/** One per mounted instance: merges a settle into the instance's in-memory
    cache of a session it is NOT the live composer of (the user switched away
    after that session already hydrated once). Without it the entry would sit
    in storage while the cache — which hydrate prefers over storage — keeps
    that session's strip stale for the rest of the page's life. */
const attachmentCacheSinks = new Set<AttachmentSink>();

/** Settle an in-flight upload at module level (see the block comment above).
    Returns without touching storage when the entry was already consumed, or
    when the upload failed — a failure was never persisted while in flight,
    so there is nothing to merge out. */
function settlePendingUpload(
  sid: string,
  localId: string,
  result: { fileId: string; name: string; mediaType: string } | null,
): void {
  const entry = pendingUploads.get(pendingUploadKey(sid, localId));
  if (entry === undefined) return;
  pendingUploads.delete(pendingUploadKey(sid, localId));
  entry.status = result === null ? 'error' : 'ready';
  if (result === null) {
    // A remount may have restored the in-flight chip from this registry (see
    // hydrateDraft): the failure must take that chip down too. The chip of the
    // ORIGINATING instance is untouched — its own completion handler marks it.
    liveAttachmentInstances.get(sid)?.drop(sid, [localId]);
    for (const sink of attachmentCacheSinks) sink.drop(sid, [localId]);
    return;
  }
  entry.fileId = result.fileId;
  const draft: PersistedAttachmentDraft = {
    localId,
    fileId: result.fileId,
    kind: entry.kind,
    name: entry.name,
    // Adopt the server-recorded MIME when available — the server's file meta
    // is what the prompt route reads (same preference as the live patch).
    mediaType: result.mediaType ?? entry.mediaType,
    size: entry.size,
    sessionId: entry.sessionId,
    seq: entry.seq,
  };
  mergeSettledDraft(sid, localId, draft);
  // A live composer of the SAME session may have remounted while this upload
  // was in flight — its hydrate read storage before the fileId landed. Hand
  // the settled entry to its strip too, or a submit before the next remount
  // would send a payload without the attachment. No live instance → fall back
  // to any mounted instance holding an in-memory cache of this session (its
  // hydrate prefers the cache over storage), or storage alone carries the
  // entry to the next mount.
  const live = liveAttachmentInstances.get(sid);
  if (live !== undefined) {
    live.merge(sid, [draft]);
  } else {
    for (const sink of attachmentCacheSinks) sink.merge(sid, [draft]);
  }
}

/** Storage-layer read-merge-write: replace the draft entry carrying this
    localId when one is stored, append otherwise (the usual case — an upload
    that was in flight when its instance last persisted was never written).
    The write is re-sorted by the add-order stamp: settles land in completion
    order, which must not scramble the restored strip. */
function mergeSettledDraft(sid: string, localId: string, draft: PersistedAttachmentDraft): void {
  const drafts = readStoredDraft(sid)?.valid ?? [];
  const index = drafts.findIndex((entry) => entry.localId === localId);
  if (index >= 0) drafts[index] = draft;
  else drafts.push(draft);
  safeSetJson(attachmentDraftStorageKey(sid), byAddOrder(drafts));
}

export function useAttachmentUpload(deps: AttachmentUploadDeps) {
  const { api, uploadImage, sessionId, insertFolderPaths, insertFileAttachment, adoptFileAttachment } = deps;

  const attachmentsBySession = ref<Record<string, Attachment[]>>({});
  const attachments = computed(() => attachmentsBySession.value[sessionId() ?? ''] ?? []);
  const previewAttachment = ref<Attachment | null>(null);
  const fileInputRef = ref<HTMLInputElement | null>(null);
  const isDragOver = ref(false);

  // Set by onUnmounted. Async callbacks that outlive the composer (an
  // in-flight upload, a thumbnail blob fetch) must not touch this instance's
  // reactive state afterwards — the strip belongs to the next mount — and a
  // late-created object URL would never be revoked (the unmount hook can only
  // revoke URLs that already exist). PERSISTENCE is deliberately NOT behind
  // this guard: it lives in the module-level upload bookkeeping above, which
  // merges a late completion straight into the session's stored draft.
  let disposed = false;

  /** localIds of the in-flight chips THIS instance restored from the module
      registry at hydrate (see hydrateDraft). The settle/drop delivery paths
      only swap or remove chips in this set — the ORIGINATING instance's own
      uploading chip is its completion handler's business (it patches the chip
      on success and marks it on failure), never the delivery's. */
  const restoredInFlightLocalIds = new Set<string>();

  function setForSession(sid: string, next: Attachment[]): void {
    // Drop post-unmount writes — see `disposed` above.
    if (disposed) return;
    attachmentsBySession.value = { ...attachmentsBySession.value, [sid]: next };
    // Persist synchronously: a submit/steer clears the strip right before the
    // composer unmounts (optimistic first message), so a watcher would flush
    // too late and the remount would resurrect already-sent attachments — the
    // same race useComposerDraft's clearDraft guards against.
    persistForSession(sid, next);
  }

  /** Rehydrate a session's persisted attachment draft into the strip. Skipped
      when the in-memory map already holds the session — live state (with its
      object-URL thumbnails) always wins over storage. Invalid entries are
      dropped; a malformed payload hydrates nothing. With `deferFiles` (and
      the adopt seam injected) file-kind drafts are NOT adopted here — they
      move to the in-memory deferredFileDrafts slot for the caller's
      adoptStoredFileDrafts drive (see the session watcher below). */
  function hydrateDraft(sid: string, opts?: { deferFiles?: boolean }): void {
    if (attachmentsBySession.value[sid] !== undefined) return;
    // In-flight uploads live in the module registry, not in storage — a
    // remount BEFORE completion (e.g. the dock swapping the composer for a
    // question/approval card, or switching sessions back early) would
    // otherwise show an empty strip until the settle lands. Restore them as
    // uploading chips; they never persist (persistForSession skips uploading
    // entries) and the settle/drop paths above finish or remove them.
    const inFlight: Attachment[] = [];
    for (const [key, entry] of pendingUploads) {
      if (!key.startsWith(`${sid}\n`)) continue;
      const localId = key.slice(sid.length + 1);
      inFlight.push({
        localId,
        name: entry.name,
        kind: entry.kind,
        previewUrl: undefined,
        mediaType: entry.mediaType,
        size: entry.size,
        sessionId: entry.sessionId,
        seq: entry.seq,
        uploading: true,
      });
      restoredInFlightLocalIds.add(localId);
    }
    const stored = readStoredDraft(sid);
    if (!stored) {
      if (inFlight.length > 0) setForSession(sid, byAddOrder(inFlight));
      return;
    }
    const { media, files } = stored;
    // LEGACY (see the note on AttachmentUploadDeps.adoptFileAttachment):
    // file-kind drafts are adopted as in-document pills when the seam is
    // injected (both composers inject it — their strips render media only).
    // Media always rehydrates as chips; without the seam files keep the chip
    // path too.
    const deferFiles = opts?.deferFiles === true && adoptFileAttachment !== undefined;
    if (deferFiles && files.length > 0) deferredFileDrafts = { sid, files };
    const chipBound = adoptFileAttachment ? media : stored.valid;
    // loadAttachments rebuilds the chips without re-uploading (fileIds are
    // reused), restores the protected preview URL, and re-fetches authed
    // thumbnails for images — exactly the edit/queue refill path. Append is
    // moot (the slot is empty) but keeps it from touching live state.
    if (chipBound.length > 0) {
      loadAttachments(
        chipBound.map((att) => promptAttachmentToTurnAttachment(api, att)),
        sid,
        { append: true },
      );
    }
    if (adoptFileAttachment && files.length > 0 && !deferFiles) {
      for (const att of files) adoptFileAttachment(promptAttachmentToTurnAttachment(api, att));
      // Adopted into pills, so drop them from the persisted chip draft — the
      // pill sidecar carries them now, and leaving them here would adopt them
      // AGAIN on the next mount (a duplicate pill).
      if (media.length === 0) safeRemove(attachmentDraftStorageKey(sid));
      else safeSetJson(attachmentDraftStorageKey(sid), media);
    }
    // In-flight chips ride on top of the hydrated ready ones, in add order.
    if (inFlight.length > 0) {
      setForSession(sid, byAddOrder([...(attachmentsBySession.value[sid] ?? []), ...inFlight]));
    }
  }

  /** The file drafts the session watcher deferred (sid-tagged, one
      outstanding at a time). Memory, not storage, because hydrating the
      media half rewrites the persisted draft from the live chips — the files
      can't ride storage across the same interval. */
  let deferredFileDrafts: { sid: string; files: PersistedAttachmentDraft[] } | null = null;

  /** Consume the current session's DEFERRED chip-era file drafts as
      in-document pills — the deferred half of hydrateDraft. The composable's
      session watcher (registered in setup, so it fires BEFORE the caller
      composer's own stash/restore watcher) hydrates media but defers files,
      because at that point the editor still shows the PREVIOUS session:
      adopting there would insert the pills into that session's document —
      and then drop the draft anyway, losing the files for the new session
      while polluting the old one. The caller (both composers) drives this at
      the end of its own session watcher, once the editor holds the new
      session again; the adopted files drop out of the persisted draft
      (rewritten from the live chips — media only, or nothing). No-op without
      the adopt seam or when nothing is deferred for the current session. */
  function adoptStoredFileDrafts(): void {
    const deferred = deferredFileDrafts;
    deferredFileDrafts = null;
    if (!adoptFileAttachment || !deferred || deferred.sid !== (sessionId() ?? '')) return;
    for (const att of deferred.files) adoptFileAttachment(promptAttachmentToTurnAttachment(api, att));
    // The files live as pills now (their sidecar carries them) — rewrite the
    // persisted chip draft from the live chips so a later mount can't adopt
    // them again. With a media half this is what the media hydrate already
    // wrote; with a files-only draft (nothing rehydrated) the key drops.
    persistForSession(deferred.sid, attachmentsBySession.value[deferred.sid] ?? []);
  }

  function revokeAttachment(att: Attachment): void {
    if (att.previewUrl === undefined) return;
    try { URL.revokeObjectURL(att.previewUrl); } catch { /* ignore */ }
  }

  function attachmentKind(mime: string): 'image' | 'video' | 'file' {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    // Everything else — including an empty/unknown MIME — attaches as a file.
    return 'file';
  }

  function attachmentSizeBucket(size: number): '<1mb' | '1-10mb' | '10-50mb' | '50mb+' {
    if (size < 1024 * 1024) return '<1mb';
    if (size < 10 * 1024 * 1024) return '1-10mb';
    if (size < 50 * 1024 * 1024) return '10-50mb';
    return '50mb+';
  }

  async function addFiles(files: File[], via: 'drop' | 'click' | 'paste', seqs?: readonly number[]): Promise<void> {
    const upload = uploadImage();
    if (!upload) return;
    // Capture the session at upload time; async completion must update the same
    // session even if the user has since switched away.
    const sid = sessionId() ?? '';
    if (files.length === 0) return;

    for (const [index, file] of files.entries()) {
      const kind = attachmentKind(file.type);
      track('attachment_added', {
        via,
        kind,
        size_bucket: attachmentSizeBucket(file.size),
        // The contract caps count at 100 — an over-cap batch would fail
        // validation and drop every event in it.
        count: Math.min(files.length, 100),
      });
      const localId = nextLocalId();
      // Only media gets a thumbnail object URL; files render an icon chip.
      const previewUrl = kind === 'file' ? undefined : URL.createObjectURL(file);
      const att: Attachment = {
        localId,
        name: file.name,
        kind,
        previewUrl,
        // Extensionless/unknown files report an empty MIME — normalize now so
        // the wire file part's required non-empty media_type never sees ''.
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        // A batch-assigned stamp (routeFiles pre-assigns in batch order) wins
        // over a fresh one, so files and media of one batch interleave by the
        // user's selection order.
        seq: seqs?.[index] ?? nextAttachmentSeq(),
        uploading: true,
      };
      setForSession(sid, [...(attachmentsBySession.value[sid] ?? []), att]);
      // The upload outlives this instance (an unmount never aborts it) — its
      // bookkeeping lives at module level so a late completion still persists.
      registerPendingUpload(sid, localId, {
        name: att.name,
        kind: att.kind,
        mediaType: att.mediaType,
        size: att.size,
        sessionId: att.sessionId,
        seq: att.seq,
      });

      // Upload in background; update the attachment when done.
      upload(file, file.name).then((result) => {
        // Module-level settle FIRST: the fileId reaches the stored draft even
        // when this instance is already unmounted (setForSession below would
        // no-op then). A consumed entry (submit/manual removal) drops here.
        settlePendingUpload(sid, localId, result);
        const current = attachmentsBySession.value[sid] ?? [];
        setForSession(
          sid,
          current.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  uploading: false,
                  fileId: result?.fileId,
                  // Adopt the server-recorded MIME when available — the
                  // server's file meta is what the prompt route reads.
                  mediaType: result?.mediaType ?? a.mediaType,
                  error: result === null,
                }
              : a,
          ),
        );
      }).catch(() => {
        settlePendingUpload(sid, localId, null);
        const current = attachmentsBySession.value[sid] ?? [];
        setForSession(
          sid,
          current.map((a) => (a.localId === localId ? { ...a, uploading: false, error: true } : a)),
        );
      });
    }
  }

  /** Route a batch of incoming files to the right attachment surface: with
   *  the pill seam, non-media files are offered to the composer's attachment
   *  pills first (the callback resolves each file's path through the bridge
   *  and returns true when it took the file); everything else — media always,
   *  all files when no seam is injected, and files the seam declined — goes
   *  down the old chip/upload path unchanged. Every item's add-order stamp
   *  is assigned HERE, in batch order, BEFORE any of them lands: a file's
   *  pill gets its stamp from the seam while the media chips' stamps wait
   *  for the addFiles call after the loop — stamping at the stamp site
   *  would put every file ahead of every medium in the same batch and
   *  invert the user's selection order in the submit payload. */
  function routeFiles(files: File[], via: 'drop' | 'click' | 'paste', at?: { clientX: number; clientY: number }): void {
    // No uploader means attaching is disabled entirely — same early-out as
    // addFiles, so the seam is never offered files it couldn't upload.
    if (!insertFileAttachment || !uploadImage() || files.length === 0) {
      void addFiles(files, via);
      return;
    }
    const rest: File[] = [];
    const restSeqs: number[] = [];
    // Only the FIRST seam-taken file lands at the drop point: its insert
    // already changed the document (and shifted the layout), so re-resolving
    // the same drop coordinates for the next file would land it BEFORE the
    // pill(s) just inserted — scrambling the batch's order. Later files get
    // no coordinates and append at the caret the previous insert left
    // behind, the same chain insertFolderPaths uses for dropped folders.
    let seamTaken = false;
    for (const file of files) {
      const seq = nextAttachmentSeq();
      if (attachmentKind(file.type) !== 'file') {
        rest.push(file);
        restSeqs.push(seq);
        continue;
      }
      if (insertFileAttachment(file, resolveFilePath(file), seamTaken ? undefined : at, seq)) {
        seamTaken = true;
        // Mirror addFiles' per-file event so the pill path stays visible in
        // the same metric (the chip path tracks inside addFiles).
        track('attachment_added', {
          via,
          kind: 'file',
          size_bucket: attachmentSizeBucket(file.size),
          count: Math.min(files.length, 100),
        });
        continue;
      }
      rest.push(file);
      restSeqs.push(seq);
    }
    void addFiles(rest, via, restSeqs);
  }

  function removeAttachment(localId: string): void {
    const sid = sessionId() ?? '';
    const current = attachmentsBySession.value[sid] ?? [];
    const att = current.find((a) => a.localId === localId);
    if (previewAttachment.value?.localId === localId) previewAttachment.value = null;
    if (att) revokeAttachment(att);
    // A chip the user deleted is consumed: its late upload completion must
    // find no registry entry, or the deleted attachment would be written back.
    dropPendingUpload(sid, localId);
    setForSession(sid, current.filter((a) => a.localId !== localId));
  }

  function openAttachmentPreview(att: Attachment): void {
    previewAttachment.value = att;
  }

  function closeAttachmentPreview(): void {
    previewAttachment.value = null;
  }

  function openFilePicker(): void {
    fileInputRef.value?.click();
  }

  function handleFileInputChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    routeFiles(files, 'click');
    // Reset so re-selecting the same file fires change again.
    input.value = '';
  }

  // Global document-level paste handler — captures Ctrl+V anywhere the composer is mounted.
  function handleDocumentPaste(e: ClipboardEvent): void {
    const cd = e.clipboardData;
    if (!cd) return;

    // Split first: pasted folders are never uploaded — a copied folder's
    // clipboard File is a directory stub, and uploading it fails the request
    // (surfacing as a daemon connection error). Their paths go into the draft
    // instead, exactly like dropped folders; on web (no bridge) the partition
    // has already skipped them. Files come back de-duplicated across the
    // clipboard's items/files lists.
    const { items, folderPaths, hasFolders } = partitionPastedItems(cd);
    const consumesFiles = items.some((item) => item.kind === 'file') && uploadImage();
    // Swallow the default paste when anything was consumed: a resolved
    // folder (its text/plain name must not land in the draft), an
    // unresolved folder (the same name-swallow), or files the upload path
    // takes. Without the upload path, files fall back to the default paste.
    if (folderPaths.length > 0 || hasFolders || consumesFiles) e.preventDefault();
    // Route in the clipboard's ORIGINAL item order — folders and files are
    // both in-document pills now, so handling the whole folder group first
    // would rewrite the user's visible reference order ("a.txt, src/, b.txt"
    // must not become "src/, a.txt, b.txt"). Consecutive files stay batched
    // per run so the upload batch semantics (and per-batch tracking) are
    // unchanged.
    let fileRun: File[] = [];
    const flushFileRun = (): void => {
      if (fileRun.length === 0) return;
      routeFiles(renamePastedBlobs(fileRun), 'paste');
      fileRun = [];
    };
    for (const item of items) {
      if (item.kind === 'folder') {
        flushFileRun();
        insertFolderPaths?.([item.path]);
      } else if (consumesFiles) {
        fileRun.push(item.file);
      }
    }
    flushFileRun();
  }

  /** A pasted blob with a dot-less name (e.g. a screenshot) gets a
   *  paste-<timestamp>.<ext> name so the chip and wire part stay readable.
   *  A REAL file with a dot-less name (README, LICENSE) keeps its original
   *  File object: wrapping it in a synthesized File would cost the desktop
   *  bridge its native path (webUtils.getPathForFile reads the original
   *  backing), breaking the path tooltip and same-path dedup — and the next
   *  paste of the same file would mint a NEW timestamped name that misses
   *  the name+size pathless retry, leaving the old error pill blocking the
   *  send gate. Only a genuine clipboard blob (no resolvable path) is
   *  renamed. */
  function renamePastedBlobs(files: readonly File[]): File[] {
    return files.map((file) => {
      if (file.name.includes('.')) return file;
      if (resolveFilePath(file) !== null) return file;
      const ext = file.type.split('/')[1] ?? 'png';
      return new File([file], `paste-${Date.now()}.${ext}`, { type: file.type });
    });
  }

  // Drag-drop handlers. WindowDragDepth tracks nested dragenter/dragleave pairs
  // for the document-level listeners below (declared here so the composer
  // handlers can reset it on their own drop).
  let windowDragDepth = 0;

  function handleDragOver(e: DragEvent): void {
    if (!uploadImage()) return;
    const hasFiles = Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === 'file');
    if (!hasFiles) return;
    // Stop the document-level handler from double-counting this as a new enter.
    e.preventDefault();
    e.stopPropagation();
    isDragOver.value = true;
  }

  function handleDragLeave(): void {
    isDragOver.value = false;
  }

  /** Route a drop in the DataTransfer's ORIGINAL item order — folders and
   *  files are both in-document pills now, so handling the whole folder
   *  group first would rewrite the user's visible reference order ("a.txt,
   *  src/, b.txt" must not become "src/, a.txt, b.txt"). Consecutive files
   *  stay batched per run (the upload batch semantics and per-batch
   *  tracking are unchanged); only the FIRST run gets the drop coordinates
   *  — re-resolving the same point for a later run would land it BEFORE
   *  the pills and folders just inserted. Files route only when
   *  `consumesFiles` (the upload path is available); folders go into the
   *  draft regardless. */
  function routeDroppedItems(
    items: readonly DroppedItem[],
    at: { clientX: number; clientY: number },
    consumesFiles: boolean,
  ): void {
    let fileRun: File[] = [];
    let coords: { clientX: number; clientY: number } | undefined = at;
    const flushFileRun = (): void => {
      if (fileRun.length === 0) return;
      routeFiles(fileRun, 'drop', coords);
      coords = undefined;
      fileRun = [];
    };
    for (const item of items) {
      if (item.kind === 'folder') {
        flushFileRun();
        insertFolderPaths?.([item.path]);
        // A folder insert can't take the drop point (it lands at the caret
        // chain) — consume the coordinates with it, or a folder-first batch
        // would let the next file run JUMP the folder and land at the drop
        // point before it, inverting the order again.
        coords = undefined;
      } else if (consumesFiles) {
        fileRun.push(item.file);
      }
    }
    flushFileRun();
  }

  function handleDrop(e: DragEvent): void {
    windowDragDepth = 0;
    isDragOver.value = false;
    const { items, folderPaths } = partitionDroppedItems(e);
    if (folderPaths.length > 0) {
      // Keep the document-level drop handler from re-inserting the same paths.
      e.preventDefault();
      e.stopPropagation();
    }
    const consumesFiles = uploadImage();
    if (consumesFiles) {
      // Stop the document-level drop handler from adding the same files twice.
      e.preventDefault();
      e.stopPropagation();
    }
    routeDroppedItems(items, { clientX: e.clientX, clientY: e.clientY }, !!consumesFiles);
  }

  // Window-level drag & drop. Without a document-wide handler, dropping a file
  // anywhere outside the small composer box makes the browser navigate away to
  // the file. Nested dragenter/dragleave pairs fire while moving across child
  // elements, so the overlay is driven by a counter, not by single events.
  function windowDragHasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === 'file');
  }

  function handleWindowDragEnter(e: DragEvent): void {
    if (!uploadImage() || !windowDragHasFiles(e)) return;
    e.preventDefault();
    windowDragDepth += 1;
    isDragOver.value = true;
  }

  function handleWindowDragOver(e: DragEvent): void {
    if (!uploadImage() || !windowDragHasFiles(e)) return;
    // Keep the browser from navigating away when the drop lands outside the composer.
    e.preventDefault();
  }

  function handleWindowDragLeave(e: DragEvent): void {
    if (!uploadImage() || !windowDragHasFiles(e)) return;
    windowDragDepth = Math.max(0, windowDragDepth - 1);
    if (windowDragDepth === 0) isDragOver.value = false;
  }

  function handleWindowDrop(e: DragEvent): void {
    windowDragDepth = 0;
    isDragOver.value = false;
    const { items, folderPaths } = partitionDroppedItems(e);
    if (folderPaths.length > 0) e.preventDefault();
    const consumesFiles = uploadImage();
    if (consumesFiles) e.preventDefault();
    routeDroppedItems(items, { clientX: e.clientX, clientY: e.clientY }, !!consumesFiles);
  }

  /** Revoke every object URL and drop all attachments for the current session
      (called after submit/steer). */
  function clearAfterSubmit(): void {
    const sid = sessionId() ?? '';
    for (const att of attachmentsBySession.value[sid] ?? []) {
      revokeAttachment(att);
    }
    // Consume the session's in-flight uploads: they were just sent (or are
    // being discarded with the strip), so a late settle must find no entry —
    // that is what keeps an already-submitted attachment from resurrecting.
    consumePendingUploads(sid);
    setForSession(sid, []);
  }

  /** The strip's "clear all" affordance — submit's teardown, plus any open
      preview goes away with its attachment. */
  function clearAttachments(): void {
    previewAttachment.value = null;
    clearAfterSubmit();
  }

  function patchAttachment(sid: string, localId: string, patch: Partial<Attachment>): void {
    const current = attachmentsBySession.value[sid] ?? [];
    if (!current.some((a) => a.localId === localId)) return;
    setForSession(
      sid,
      current.map((a) => (a.localId === localId ? { ...a, ...patch } : a)),
    );
  }

  function urlToBlob(url: string): Promise<Blob> {
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      return r.blob();
    });
  }

  /** Refill the attachment strip from already-uploaded files (used when a queued
   *  prompt or an undone message is loaded back into the composer). The fileIds
   *  are reused directly (no re-upload); for a protected getFileUrl preview we
   *  fetch an authenticated blob URL so the thumbnail doesn't 401. Replaces any
   *  unsent draft attachments (mirroring loadForEdit(text), which overwrites) so
   *  a later submit sends exactly the edited message's files, not a mix. */
  function loadAttachments(atts: readonly TurnAttachment[], targetSid?: string, opts?: { append?: boolean }): void {
    const sid = targetSid ?? sessionId() ?? '';
    if (opts?.append !== true) {
      for (const existing of attachmentsBySession.value[sid] ?? []) revokeAttachment(existing);
      // Replacing the strip discards its in-flight uploads along with the
      // chips — consume them like removeAttachment does, or a late settle
      // would write a discarded attachment back into the stored draft.
      consumePendingUploads(sid);
      setForSession(sid, []);
    }
    for (const att of atts) {
      const localId = nextLocalId();
      const isData = /^data:/i.test(att.url);
      const isBlob = /^blob:/i.test(att.url);
      const name = att.name ?? att.kind;
      // A carried stamp must also fast-forward the add-order clock — otherwise
      // the next fresh stamp could tie with the restored one and scramble the
      // submit payload's media/file interleave.
      if (att.seq !== undefined) noteAttachmentSeq(att.seq);

      if (att.fileId) {
        // Ready as-is; images fetch an authenticated thumbnail for protected
        // URLs. Videos render a static play tile (the lightbox fetches on
        // activation), files have no thumbnail — nothing to fetch or revoke.
        const entry: Attachment = {
          localId,
          name,
          kind: att.kind,
          previewUrl: att.kind === 'file' ? undefined : att.url,
          uploading: false,
          fileId: att.fileId,
          sessionId: att.sessionId,
          mediaType: att.mediaType,
          size: att.size,
          // Ready at load time — adopt a carried stamp (a restored draft
          // keeps its payload interleave), or join the add-order clock now.
          seq: att.seq ?? nextAttachmentSeq(),
        };
        setForSession(sid, [...(attachmentsBySession.value[sid] ?? []), entry]);
        if (att.kind === 'image' && !isData && !isBlob) {
          const blobRequest = att.sessionId
            ? api.getSessionMediaBlob(att.sessionId, att.fileId)
            : api.getFileBlob(att.fileId);
          void blobRequest.then((blob) => {
            // Unmounted while the fetch was in flight: drop the response
            // without creating an object URL — one created now would never
            // be revoked (the unmount hook already ran).
            if (disposed) return;
            const blobUrl = URL.createObjectURL(blob);
            const current = attachmentsBySession.value[sid] ?? [];
            if (!current.some((a) => a.localId === localId)) {
              URL.revokeObjectURL(blobUrl);
              return;
            }
            patchAttachment(sid, localId, { previewUrl: blobUrl });
          }).catch(() => {
            // Keep the fallback previewUrl (honest broken state if it 401s).
          });
        }
      } else {
        // No fileId (e.g. a server-base64-inlined image, or a URL-backed source
        // from the wire/REST prompt path): re-upload the URL so the chip is
        // actually resendable — otherwise handleSubmit silently drops it. If the
        // URL can't be fetched (CORS / non-2xx) or upload is unavailable, skip
        // the chip rather than show a misleading ready attachment.
        // No URL at all (the non-clickable chip rebuilt from an inline-base64
        // notice): skip too — fetch('') would resolve to the current page and
        // upload the web app's HTML as the attachment.
        if (!att.url) continue;
        const upload = uploadImage();
        if (!upload) continue;
        const entry: Attachment = {
          localId,
          name,
          kind: att.kind,
          previewUrl: att.url,
          seq: att.seq ?? nextAttachmentSeq(),
          uploading: true,
        };
        setForSession(sid, [...(attachmentsBySession.value[sid] ?? []), entry]);
        // Same module-level bookkeeping as addFiles — this re-upload outlives
        // the instance too.
        registerPendingUpload(sid, localId, {
          name,
          kind: att.kind,
          mediaType: att.mediaType,
          size: att.size,
          sessionId: att.sessionId,
          seq: entry.seq,
        });
        void urlToBlob(att.url)
          .then((blob) => {
            const fname = name.includes('.') ? name : `${name}.${blob.type.split('/')[1] ?? 'bin'}`;
            return upload(blob, fname);
          })
          .then((result) => {
            settlePendingUpload(sid, localId, result);
            if (result === null) {
              const current = attachmentsBySession.value[sid] ?? [];
              // Revoke before filtering — a dropped chip's object URL would
              // otherwise leak (the unmount hook can only revoke URLs of
              // chips still in the array), and its preview goes away with it
              // (same rule as the manual remove path).
              const dropped = current.find((a) => a.localId === localId);
              if (dropped) {
                revokeAttachment(dropped);
                if (previewAttachment.value?.localId === localId) previewAttachment.value = null;
              }
              setForSession(sid, current.filter((a) => a.localId !== localId));
              return;
            }
            patchAttachment(sid, localId, { uploading: false, fileId: result.fileId });
          })
          .catch(() => {
            settlePendingUpload(sid, localId, null);
            const current = attachmentsBySession.value[sid] ?? [];
            // Same revoke-before-filter as the null-result branch above.
            const dropped = current.find((a) => a.localId === localId);
            if (dropped) {
              revokeAttachment(dropped);
              if (previewAttachment.value?.localId === localId) previewAttachment.value = null;
            }
            setForSession(sid, current.filter((a) => a.localId !== localId));
          });
      }
    }
  }

  /** Receive uploads that settled at module level while THIS instance is the
      live composer of their session (see liveAttachmentInstances): the
      remount hydrated before the fileId reached storage, so the strip missed
      the chip. Dedup by localId — the instance that ORIGINATED the upload
      already carries the chip (its own completion handler patches it), so
      delivery is a no-op there, and a repeated delivery can never duplicate.
      A chip THIS instance restored from the registry at hydrate (still
      uploading) is swapped for the ready entry. The settled entries reuse the
      ready-chip refill path (fileId kept, no re-upload, authed thumbnail
      re-fetch); the strip is then re-sorted by the add-order stamp, so a late
      delivery can't scramble the strip or the submit payload's media/file
      interleave. */
  function receiveSettledUploads(drafts: PersistedAttachmentDraft[]): void {
    if (disposed) return;
    const strip = attachmentsBySession.value[liveSid] ?? [];
    const fresh: PersistedAttachmentDraft[] = [];
    const replaced = new Set<string>();
    for (const draft of byAddOrder(drafts)) {
      if (draft.localId === undefined) continue;
      const existing = strip.find((att) => att.localId === draft.localId);
      if (existing === undefined) {
        fresh.push(draft);
      } else if (existing.uploading && restoredInFlightLocalIds.has(draft.localId)) {
        replaced.add(draft.localId);
        fresh.push(draft);
      }
    }
    if (fresh.length === 0) return;
    if (replaced.size > 0) {
      for (const localId of replaced) restoredInFlightLocalIds.delete(localId);
      setForSession(liveSid, strip.filter((att) => !replaced.has(att.localId)));
    }
    for (const draft of fresh) {
      loadAttachments([promptAttachmentToTurnAttachment(api, draft)], liveSid, { append: true });
    }
    setForSession(liveSid, byAddOrder(attachmentsBySession.value[liveSid] ?? []));
  }

  /** A failed settle takes down the chips this instance restored from the
      registry while the upload was in flight (they would spin forever) —
      nothing else: an uploading chip outside the restored set belongs to a
      live upload whose own completion handler marks it. */
  function dropSettledUploads(localIds: string[]): void {
    if (disposed) return;
    const strip = attachmentsBySession.value[liveSid] ?? [];
    const doomed = strip.filter((att) => att.uploading && restoredInFlightLocalIds.has(att.localId) && localIds.includes(att.localId));
    if (doomed.length === 0) return;
    for (const att of doomed) {
      restoredInFlightLocalIds.delete(att.localId);
      revokeAttachment(att);
      if (previewAttachment.value?.localId === att.localId) previewAttachment.value = null;
    }
    setForSession(liveSid, strip.filter((att) => !doomed.includes(att)));
  }

  const liveSink: AttachmentSink = {
    merge: (_sid, drafts) => receiveSettledUploads(drafts),
    drop: (_sid, localIds) => dropSettledUploads(localIds),
  };

  /** Cache sink: a settle for a session this instance is NOT live for still
      reaches that session's in-memory cache here (hydrate prefers the cache
      over storage, so storage alone would leave the strip stale for the rest
      of the page's life). Same restored-set rules as the live sink. Memory
      only — the settle already wrote storage, so this path must NOT persist
      (the cache is a view, not a draft owner). */
  const cacheSink: AttachmentSink = {
    merge(sid, drafts) {
      if (disposed) return;
      const cache = attachmentsBySession.value[sid];
      if (cache === undefined) return;
      let next = cache;
      for (const draft of drafts) {
        if (draft.localId === undefined) continue;
        const existing = next.find((att) => att.localId === draft.localId);
        if (existing !== undefined && !(existing.uploading && restoredInFlightLocalIds.has(draft.localId))) continue;
        if (existing !== undefined) restoredInFlightLocalIds.delete(draft.localId);
        const turned = promptAttachmentToTurnAttachment(api, draft);
        const ready: Attachment = {
          // Keep the registry identity: a repeated delivery dedups by it.
          localId: draft.localId,
          name: turned.name ?? turned.kind,
          kind: turned.kind,
          previewUrl: turned.kind === 'file' ? undefined : turned.url,
          uploading: false,
          fileId: turned.fileId,
          sessionId: turned.sessionId,
          mediaType: turned.mediaType,
          size: turned.size,
          seq: turned.seq ?? nextAttachmentSeq(),
        };
        next = existing === undefined ? [...next, ready] : next.map((att) => (att.localId === draft.localId ? ready : att));
        // Authed thumbnail for images, mirroring the refill path (and its
        // late-fetch guards).
        if (turned.kind === 'image' && turned.fileId !== undefined && !/^(data|blob):/i.test(turned.url)) {
          const blobRequest = turned.sessionId
            ? api.getSessionMediaBlob(turned.sessionId, turned.fileId)
            : api.getFileBlob(turned.fileId);
          void blobRequest.then((blob) => {
            if (disposed) return;
            const blobUrl = URL.createObjectURL(blob);
            const current = attachmentsBySession.value[sid] ?? [];
            if (!current.some((a) => a.localId === ready.localId)) {
              URL.revokeObjectURL(blobUrl);
              return;
            }
            attachmentsBySession.value = {
              ...attachmentsBySession.value,
              [sid]: current.map((a) => (a.localId === ready.localId ? { ...a, previewUrl: blobUrl } : a)),
            };
          }).catch(() => {
            // Keep the fallback previewUrl (honest broken state if it 401s).
          });
        }
      }
      if (next !== cache) attachmentsBySession.value = { ...attachmentsBySession.value, [sid]: byAddOrder(next) };
    },
    drop(sid, localIds) {
      if (disposed) return;
      const cache = attachmentsBySession.value[sid];
      if (cache === undefined) return;
      const doomed = cache.filter((att) => att.uploading && restoredInFlightLocalIds.has(att.localId) && localIds.includes(att.localId));
      if (doomed.length === 0) return;
      for (const att of doomed) restoredInFlightLocalIds.delete(att.localId);
      attachmentsBySession.value = { ...attachmentsBySession.value, [sid]: cache.filter((att) => !doomed.includes(att)) };
    },
  };
  attachmentCacheSinks.add(cacheSink);

  // Register as the live instance of the current session so a settle landing
  // after a remount reaches this strip — see the module comment above.
  let liveSid = sessionId() ?? '';
  liveAttachmentInstances.set(liveSid, liveSink);

  // Close the preview lightbox when switching sessions — it may reference an
  // attachment that belongs to the previous session. Then rehydrate the new
  // session's persisted draft if it has no live state yet — MEDIA only: the
  // file-kind adoption is deferred (in memory) to the caller's
  // adoptStoredFileDrafts drive, because this watcher (registered in setup)
  // fires before the composer's own stash/restore watcher, while the editor
  // still shows the previous session (media chips are editor-independent and
  // hydrate immediately).
  watch(sessionId, (next, prev) => {
    previewAttachment.value = null;
    // Follow the session switch in the live-instance registry: settles for
    // the previous session no longer belong to this instance's strip.
    if (liveAttachmentInstances.get(prev ?? '') === liveSink) {
      liveAttachmentInstances.delete(prev ?? '');
    }
    liveSid = next ?? '';
    liveAttachmentInstances.set(liveSid, liveSink);
    hydrateDraft(liveSid, { deferFiles: true });
  });

  // First mount: restore the current session's persisted attachment draft.
  hydrateDraft(sessionId() ?? '');

  onMounted(() => {
    document.addEventListener('paste', handleDocumentPaste);
    document.addEventListener('dragenter', handleWindowDragEnter);
    document.addEventListener('dragover', handleWindowDragOver);
    document.addEventListener('dragleave', handleWindowDragLeave);
    document.addEventListener('drop', handleWindowDrop);
  });

  // Revoke all object URLs (every session) and remove the global listener on unmount.
  onUnmounted(() => {
    // First: late async callbacks must no-op from here on (see `disposed`).
    disposed = true;
    // Leave the live-instance registry — but only if the slot still points at
    // THIS instance: a newer mount of the same session owns it now.
    if (liveAttachmentInstances.get(liveSid) === liveSink) {
      liveAttachmentInstances.delete(liveSid);
    }
    attachmentCacheSinks.delete(cacheSink);
    document.removeEventListener('paste', handleDocumentPaste);
    document.removeEventListener('dragenter', handleWindowDragEnter);
    document.removeEventListener('dragover', handleWindowDragOver);
    document.removeEventListener('dragleave', handleWindowDragLeave);
    document.removeEventListener('drop', handleWindowDrop);
    for (const atts of Object.values(attachmentsBySession.value)) {
      for (const att of atts) revokeAttachment(att);
    }
    previewAttachment.value = null;
  });

  return {
    attachments,
    previewAttachment,
    fileInputRef,
    isDragOver,
    removeAttachment,
    openAttachmentPreview,
    closeAttachmentPreview,
    openFilePicker,
    handleFileInputChange,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearAfterSubmit,
    clearAttachments,
    loadAttachments,
    adoptStoredFileDrafts,
  };
}
