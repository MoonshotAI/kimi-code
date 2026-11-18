import { sessionListStore } from '../stores/sessionList';
import { nextTick, ref, watch, type Ref } from 'vue';
import { draftAttachmentsStorageKey, draftSnapshotStorageKey, draftStorageKey, safeGetJson, safeGetString, safeRemove, safeSetJson, safeSetString } from '@moonshot-ai/app-core/lib';
import { isDraftEntryRecoverable, parseDraftAttachmentEntry, serializableAttachmentEntry, type AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { degradeForeignAttachmentLinks } from '@moonshot-ai/app-composer/model';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';
import { composerSnapshotDocument, docToText, parseComposerSnapshot, withoutComposerSnapshotAttachments, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';

export interface ComposerDraftDeps {
  sessionId: () => string | undefined;
  onBeforeSessionSave?: (oldSid: string | undefined) => void;
}

export function useComposerDraft(deps: ComposerDraftDeps) {
  const { sessionId } = deps;

  function loadDraft(sid: string | undefined): string {
    const snapshot = loadDraftSnapshot(sid);
    if (snapshot !== null) return docToText(composerSnapshotDocument(snapshot));
    return safeGetString(draftStorageKey(sid)) ?? '';
  }
  function saveDraft(sid: string | undefined, value: string): void {
    const key = draftStorageKey(sid);
    if (sid && sessionListStore().hasDeletedTombstone(sid)) {
      value = '';
      safeRemove(draftSnapshotStorageKey(sid));
    }
    const snapshot = loadDraftSnapshot(sid);
    if (snapshot !== null && docToText(composerSnapshotDocument(snapshot)) !== value) safeRemove(draftSnapshotStorageKey(sid));
    if (value) safeSetString(key, value);
    else safeRemove(key);
  }

  function loadDraftSnapshot(sid: string | undefined): ComposerDocumentSnapshot | null {
    return parseComposerSnapshot(safeGetJson<unknown>(draftSnapshotStorageKey(sid)));
  }

  function loadRestorableDraftSnapshot(sid: string | undefined): ComposerDocumentSnapshot | null {
    const snapshot = loadDraftSnapshot(sid);
    if (snapshot === null) return null;
    const lost = new Set(snapshot.attachments
      .filter((entry) => entry.purpose !== 'browser-screenshot' && !isDraftEntryRecoverable(entry, sid))
      .map((entry) => entry.attId));
    return withoutComposerSnapshotAttachments(snapshot, lost);
  }

  function saveDraftSnapshot(sid: string | undefined, snapshot: ComposerDocumentSnapshot): void {
    if (sid && sessionListStore().hasDeletedTombstone(sid)) {
      safeRemove(draftSnapshotStorageKey(sid));
      safeRemove(draftStorageKey(sid));
      return;
    }
    const wire = docToText(composerSnapshotDocument(snapshot));
    if (wire.length === 0 && snapshot.attachmentOrder.length === 0) {
      safeRemove(draftSnapshotStorageKey(sid));
    } else {
      safeSetJson(draftSnapshotStorageKey(sid), snapshot);
    }
    if (wire) safeSetString(draftStorageKey(sid), wire);
    else safeRemove(draftStorageKey(sid));
  }

  function loadDraftText(sid: string | undefined): string {
    const raw = loadDraft(sid);
    if (raw === '') return raw;
    const recoverable = new Set(loadDraftAttachments(sid).map((entry) => entry.attId));
    return degradeForeignAttachmentLinks(raw, recoverable);
  }

  function loadDraftAttachments(sid: string | undefined): AttachmentEntry[] {
    const parsed = safeGetJson<unknown>(draftAttachmentsStorageKey(sid));
    if (!Array.isArray(parsed)) return [];
    const entries: AttachmentEntry[] = [];
    for (const raw of parsed) {
      const entry = parseDraftAttachmentEntry(raw);
      if (entry !== null && isDraftEntryRecoverable(entry, sid)) entries.push(entry);
    }
    return entries;
  }

  let lastAttachmentsWrite: { key: string; json: string } | null = null;
  function saveDraftAttachments(sid: string | undefined, entries: readonly AttachmentEntry[]): void {
    const key = draftAttachmentsStorageKey(sid);
    if (entries.length === 0 || (sid && sessionListStore().hasDeletedTombstone(sid))) {
      lastAttachmentsWrite = null;
      safeRemove(key);
      return;
    }
    const serializable = entries
      .filter((entry) => isDraftEntryRecoverable(entry, sid))
      .map(serializableAttachmentEntry);
    if (serializable.length === 0) {
      lastAttachmentsWrite = null;
      safeRemove(key);
      return;
    }
    const snapshot = loadDraftSnapshot(sid);
    if (snapshot !== null && serializable.length > 0) {
      const updated = new Map(snapshot.attachments.map((entry) => [entry.attId, entry]));
      for (const entry of serializable) updated.set(entry.attId, entry);
      safeSetJson(draftSnapshotStorageKey(sid), { ...snapshot, attachments: [...updated.values()] });
    }
    const json = JSON.stringify(serializable);
    if (lastAttachmentsWrite?.key === key && lastAttachmentsWrite.json === json) return;
    lastAttachmentsWrite = { key, json };
    safeSetJson(key, serializable);
  }

  let textSessionId = sessionId();
  const text = ref(loadDraftText(textSessionId));
  const editorRef: Ref<TextFieldLike | null> = ref(null);

  watch(text, (value) => {
    saveDraft(textSessionId, value);
  });

  watch(sessionId, (newSid, oldSid) => {
    if (newSid === oldSid) return;
    deps.onBeforeSessionSave?.(oldSid);
    saveDraft(oldSid, text.value);
    textSessionId = newSid;
    text.value = loadDraftText(newSid);
  });

  function loadForEdit(value: string): void {
    setTextAndFocus(value);
  }

  function setTextAndFocus(value: string): void {
    text.value = value;
    void nextTick(() => {
      const el = editorRef.value;
      if (!el) return;
      el.focus();
      const pos = value.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function clearDraft(): void {
    safeRemove(draftSnapshotStorageKey(sessionId()));
    saveDraft(sessionId(), '');
  }

  return { text, editorRef, loadForEdit, clearDraft, loadDraftAttachments, saveDraftAttachments, saveDraft, loadDraftSnapshot, loadRestorableDraftSnapshot, saveDraftSnapshot };
}
