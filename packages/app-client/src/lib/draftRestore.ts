import type { ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { draftAttachmentsStorageKey, draftSnapshotStorageKey, draftStorageKey, safeGetJson, safeGetString } from '@moonshot-ai/app-core/lib';
import { persistComposerDraftSnapshot } from './composerDraftLifecycle';
import type { PromptAttachment } from '../client/types';

export interface RecoveredSendDraft {
  text: string;
  attachments?: PromptAttachment[];
  restoreEntries?: AttachmentEntry[];
  snapshot?: ComposerDocumentSnapshot;
}

export interface DraftRestoreComposer {
  isComposerEmpty(): boolean;
  loadRecoveredDraft(draft: RecoveredSendDraft): boolean;
}

export interface DraftRestoreDeps {
  activeSessionId(): string | undefined;
  composer(): DraftRestoreComposer | null;
  persistDraft?(sid: string | undefined, value: string, entries: readonly AttachmentEntry[], snapshot?: ComposerDocumentSnapshot): void;
  hasPersistedDraft?(sid: string | undefined): boolean;
}

export type DraftRestoreOutcome = 'in-place' | 'persisted' | 'kept-in-history';

function persistedDraftPresent(sid: string | undefined): boolean {
  if ((safeGetString(draftStorageKey(sid)) ?? '') !== '') return true;
  if (safeGetJson<unknown>(draftAttachmentsStorageKey(sid)) !== null) return true;
  return safeGetJson<unknown>(draftSnapshotStorageKey(sid)) !== null;
}

export function restoreSendDraftAtOrigin(
  originSid: string | undefined,
  draft: RecoveredSendDraft,
  deps: DraftRestoreDeps,
): DraftRestoreOutcome {
  const persist = (sid: string | undefined, value: string, entries: readonly AttachmentEntry[], snapshot?: ComposerDocumentSnapshot): void =>
    deps.persistDraft === undefined
      ? persistComposerDraftSnapshot(sid, value, entries, snapshot)
      : deps.persistDraft(sid, value, entries, snapshot);
  const hasPersisted = (sid: string | undefined): boolean =>
    deps.hasPersistedDraft === undefined ? persistedDraftPresent(sid) : deps.hasPersistedDraft(sid);
  if (deps.activeSessionId() === originSid) {
    const composer = deps.composer();
    if (composer !== null) {
      if (!composer.isComposerEmpty()) return 'kept-in-history';
      if (composer.loadRecoveredDraft(draft) !== false) return 'in-place';
    }
  }
  if (hasPersisted(originSid)) return 'kept-in-history';
  persist(originSid, draft.text, draft.restoreEntries ?? [], draft.snapshot);
  return 'persisted';
}
