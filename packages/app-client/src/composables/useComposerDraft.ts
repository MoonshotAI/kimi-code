// packages/app-client/src/composables/useComposerDraft.ts
import { nextTick, ref, watch, type Ref } from 'vue';
import { draftAttachmentsStorageKey, draftStorageKey, safeGetJson, safeGetString, safeRemove, safeSetJson, safeSetString } from '@moonshot-ai/app-core/lib';
import { noteAttachmentSeq, type AttachmentEntry, type TextFieldLike } from '@moonshot-ai/app-composer';

export interface ComposerDraftDeps {
  /** Active session id — scopes the persisted draft (getter for reactivity). */
  sessionId: () => string | undefined;
  /** Runs INSIDE the session watcher, after the newSid guard but BEFORE the
   *  outgoing session's draft is persisted — the caller's last chance to
   *  repair the outgoing session's state (e.g. walk a history browse home,
   *  so the recall text isn't persisted as its draft). */
  onBeforeSessionSave?: (oldSid: string | undefined) => void;
}

/**
 * The composer's text state plus its per-session unsent-draft persistence.
 *
 * The draft is kept in localStorage keyed by session, so switching away and back
 * (or a page refresh) restores whatever the user was typing for that session; it
 * is cleared when the draft is sent/steered. This composable owns the `text`
 * and `editor` refs, the draft load/save watchers, and the imperative
 * `loadForEdit` handle exposed to the parent.
 *
 * `editorRef` is the mounted editing surface (the ProseMirror adapter both
 * apps' composers mount) seen through the TextFieldLike char-offset contract.
 */
export function useComposerDraft(deps: ComposerDraftDeps) {
  const { sessionId } = deps;

  function loadDraft(sid: string | undefined): string {
    return safeGetString(draftStorageKey(sid)) ?? '';
  }
  function saveDraft(sid: string | undefined, value: string): void {
    const key = draftStorageKey(sid);
    if (value) safeSetString(key, value);
    else safeRemove(key);
  }

  // ---------------------------------------------------------------------
  // Attachment-entry sidecar. The composer's attachment pills carry only
  // { attId, name, kind } in the draft text; the registry metadata (path,
  // size, upload state, fileId) persists HERE, keyed per session next to the
  // text draft, so a restart/remount can re-seed the registry for the pills
  // the revived draft text brings back.
  // ---------------------------------------------------------------------

  /** The session's persisted attachment entries ([] when none/invalid). An
   *  entry whose upload was in flight when it was persisted comes back with
   *  `uploading: false` + an 'upload-interrupted' error marker: the upload
   *  will never complete after a reload, and a stuck `uploading` entry would
   *  block the composer's send gate forever — the marker keeps the pill
   *  honest (excluded from the submit payload) until the user re-adds it. */
  function loadDraftAttachments(sid: string | undefined): AttachmentEntry[] {
    const parsed = safeGetJson<unknown>(draftAttachmentsStorageKey(sid));
    if (!Array.isArray(parsed)) return [];
    const entries: AttachmentEntry[] = [];
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Partial<AttachmentEntry>;
      if (
        typeof entry.attId !== 'string' ||
        typeof entry.key !== 'string' ||
        typeof entry.name !== 'string' ||
        (entry.kind !== 'file' && entry.kind !== 'folder')
      ) {
        continue;
      }
      const uploading = entry.uploading === true;
      const seq = typeof entry.seq === 'number' ? entry.seq : undefined;
      if (seq !== undefined) noteAttachmentSeq(seq);
      entries.push({
        attId: entry.attId,
        key: entry.key,
        kind: entry.kind,
        name: entry.name,
        size: typeof entry.size === 'number' ? entry.size : undefined,
        mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : undefined,
        lastModified: typeof entry.lastModified === 'number' ? entry.lastModified : undefined,
        seq,
        path: typeof entry.path === 'string' ? entry.path : undefined,
        refCount: typeof entry.refCount === 'number' ? entry.refCount : 0,
        uploading: false,
        fileId: typeof entry.fileId === 'string' ? entry.fileId : undefined,
        error: typeof entry.error === 'string' ? entry.error : uploading ? 'upload-interrupted' : undefined,
      });
    }
    return entries;
  }

  /** Persist the session's attachment entries (an empty list removes the
   *  key — same contract as saveDraft). Callers mirror the registry's
   *  onRegistryChange cadence, so entries land at every registry movement. */
  function saveDraftAttachments(sid: string | undefined, entries: readonly AttachmentEntry[]): void {
    const key = draftAttachmentsStorageKey(sid);
    if (entries.length === 0) safeRemove(key);
    else safeSetJson(key, entries);
  }

  const text = ref(loadDraft(sessionId()));
  const editorRef: Ref<TextFieldLike | null> = ref(null);

  watch(text, (value) => {
    // Persist the live draft for the current session (empty clears the entry).
    saveDraft(sessionId(), value);
  });

  // Switching sessions: stash the draft under the OLD session, then load the new
  // session's draft into the box.
  watch(sessionId, (newSid, oldSid) => {
    if (newSid === oldSid) return;
    deps.onBeforeSessionSave?.(oldSid);
    saveDraft(oldSid, text.value);
    text.value = loadDraft(newSid);
  });

  /** Imperatively load text into the box for editing (used by "edit & resend the
      last message" after an undo, or by the dock queue panel when the user edits
      a queued prompt). Focuses with the caret at the end. */
  function loadForEdit(value: string): void {
    text.value = value;
    void nextTick(() => {
      const el = editorRef.value;
      if (!el) return;
      el.focus();
      const pos = value.length;
      el.setSelectionRange(pos, pos);
    });
  }

  /**
   * Synchronously clear the persisted draft for the current session.
   * Call this right after clearing `text.value` on send/steer; relying on the
   * text watcher is unsafe because the Composer may unmount before the watcher
   * flushes (e.g. when the optimistic user message replaces the empty-session
   * composer), causing the next mount to reload the stale draft.
   */
  function clearDraft(): void {
    saveDraft(sessionId(), '');
  }

  return { text, editorRef, loadForEdit, clearDraft, loadDraftAttachments, saveDraftAttachments, saveDraft };
}
