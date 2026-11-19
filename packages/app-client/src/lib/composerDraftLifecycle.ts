import {
  composerSessionScope,
  draftAttachmentsStorageKey,
  draftStorageKey,
  draftSnapshotStorageKey,
  safeRemove,
  safeSetJson,
  safeSetString,
} from '@moonshot-ai/app-core/lib';
import { sessionListStore } from '../stores/sessionList';
import { composerAttachmentStore } from './composerAttachmentStore';
import {
  isDraftEntryRecoverable,
  serializableAttachmentEntry,
  type AttachmentEntry,
} from '@moonshot-ai/app-composer/features/attachment';
import { composerSnapshotDocument, docToText, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { discardStashedEditorState } from '@moonshot-ai/app-composer/runtime';

export interface ComposerDispatchResetEffects {
  setText(value: string): void;
  clearDraft(): void;
  clearDraftAttachments(): void;
  closeSlashMenu(): void;
  closeMentionMenu(): void;
  collapse(): void;
}

export interface ComposerDispatchResetPolicy {
  attachments: 'clear' | 'preserve';
  mentionMenu: 'close' | 'preserve';
}

export function resetComposerAfterDispatch(
  effects: ComposerDispatchResetEffects,
  policy: ComposerDispatchResetPolicy,
): void {
  effects.setText('');
  effects.clearDraft();
  if (policy.attachments === 'clear') effects.clearDraftAttachments();
  effects.closeSlashMenu();
  if (policy.mentionMenu === 'close') effects.closeMentionMenu();
  effects.collapse();
}

export function persistComposerDraftSnapshot(
  sid: string | undefined,
  value: string,
  entries: readonly AttachmentEntry[] = [],
  snapshot?: ComposerDocumentSnapshot,
): void {
  if (sid && sessionListStore().hasDeletedTombstone(sid)) {
    value = '';
    entries = [];
    snapshot = undefined;
  }
  if (snapshot !== undefined) {
    entries = snapshot.attachments;
    value = docToText(composerSnapshotDocument(snapshot));
    safeSetJson(draftSnapshotStorageKey(sid), snapshot);
  } else {
    safeRemove(draftSnapshotStorageKey(sid));
  }
  composerAttachmentStore.load(composerSessionScope(sid), entries);
  if (value) safeSetString(draftStorageKey(sid), value);
  else safeRemove(draftStorageKey(sid));
  const serializable = entries
    .filter((entry) => isDraftEntryRecoverable(entry, sid))
    .map(serializableAttachmentEntry);
  if (serializable.length > 0) {
    safeSetJson(draftAttachmentsStorageKey(sid), serializable);
  } else {
    safeRemove(draftAttachmentsStorageKey(sid));
  }
  discardStashedEditorState(composerSessionScope(sid));
}
