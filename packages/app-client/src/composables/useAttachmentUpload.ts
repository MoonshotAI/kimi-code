
import { onMounted, onUnmounted, ref, watch } from 'vue';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import { track } from '../contracts';
import { attachmentKind, type AttachmentInputSource } from '../lib/composerAttachments';
import {
  attachmentDraftStorageKey,
  partitionDroppedItems,
  partitionPastedItems,
  resolveFilePath,
  safeGetJson,
  safeRemove,
  type DroppedItem,
} from '@moonshot-ai/app-core/lib';
import { promptAttachmentToTurnAttachment } from '../client/attachmentsToContent';
import type { PromptAttachment } from '../client/types';

type UploadImage = (
  file: Blob,
  name?: string,
) => Promise<{ fileId: string; name: string; mediaType: string } | null>;

export interface AttachmentUploadDeps {
  api: Pick<KimiWebApi, 'getFileBlob' | 'getSessionMediaBlob' | 'getFileUrl' | 'getSessionMediaUrl'>;
  uploadImage: () => UploadImage | undefined;
  sessionId: () => string | undefined;
  insertFolderPaths?: (paths: string[]) => void;
  insertFileAttachment?: (
    file: File,
    path: string | null,
    context: {
      source: AttachmentInputSource;
      at?: { clientX: number; clientY: number };
    },
  ) => boolean;
  insertFileAttachments?: (
    files: readonly { file: File; path: string | null }[],
    context: {
      source: AttachmentInputSource;
      at?: { clientX: number; clientY: number };
    },
  ) => boolean[];
  pasteTarget?: () => 'editor' | 'composer' | 'ignore';
  adoptFileAttachment?: (att: TurnAttachment) => void;
  adoptMediaAttachment?: (att: TurnAttachment) => void;
  windowDrop?: () => boolean;
  dropSurfaceVisible?: () => boolean;
}

type PersistedAttachmentDraft = Pick<PromptAttachment, 'fileId' | 'kind' | 'name' | 'mediaType' | 'size' | 'sessionId'> & {
  seq?: number;
};

const dragOverResetters = new Set<() => void>();

function resetAllDragOver(): void {
  for (const reset of dragOverResetters) reset();
}

export function useAttachmentUpload(deps: AttachmentUploadDeps) {
  const { api, uploadImage, sessionId, insertFolderPaths, insertFileAttachment, insertFileAttachments, adoptFileAttachment, adoptMediaAttachment } = deps;

  const fileInputRef = ref<HTMLInputElement | null>(null);
  const isDragOver = ref(false);

  function readStoredDraft(sid: string): PersistedAttachmentDraft[] | null {
    const stored = safeGetJson<unknown>(attachmentDraftStorageKey(sid));
    if (!Array.isArray(stored) || stored.length === 0) return null;
    const valid: PersistedAttachmentDraft[] = [];
    for (const entry of stored as Array<Partial<PersistedAttachmentDraft> | null>) {
      if (!entry || typeof entry.fileId !== 'string' || entry.fileId === '') continue;
      if (entry.kind !== 'image' && entry.kind !== 'video' && entry.kind !== 'file') continue;
      valid.push({
        fileId: entry.fileId,
        kind: entry.kind,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.kind,
        mediaType: typeof entry.mediaType === 'string' ? entry.mediaType : undefined,
        size: typeof entry.size === 'number' ? entry.size : undefined,
        sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
      });
    }
    return valid.length === 0 ? null : valid;
  }

  let deferredDrafts: { sid: string; drafts: PersistedAttachmentDraft[] } | null = null;

  function adoptDrafts(drafts: readonly PersistedAttachmentDraft[]): void {
    for (const att of drafts) {
      const turn = promptAttachmentToTurnAttachment(api, att);
      if (turn.kind === 'file') adoptFileAttachment?.(turn);
      else adoptMediaAttachment?.(turn);
    }
  }

  function hydrateDraft(sid: string): void {
    const stored = readStoredDraft(sid);
    if (!stored) return;
    if (adoptFileAttachment !== undefined || adoptMediaAttachment !== undefined) {
      deferredDrafts = { sid, drafts: stored };
    }
    safeRemove(attachmentDraftStorageKey(sid));
  }

  function adoptStoredDrafts(): void {
    const deferred = deferredDrafts;
    deferredDrafts = null;
    if (!deferred || deferred.sid !== (sessionId() ?? '')) return;
    adoptDrafts(deferred.drafts);
  }

  function attachmentSizeBucket(size: number): '<1mb' | '1-10mb' | '10-50mb' | '50mb+' {
    if (size < 1024 * 1024) return '<1mb';
    if (size < 10 * 1024 * 1024) return '1-10mb';
    if (size < 50 * 1024 * 1024) return '10-50mb';
    return '50mb+';
  }

  function routeFiles(
    files: File[],
    via: 'drop' | 'click' | 'paste' | 'screenshot',
    source: AttachmentInputSource,
    at?: { clientX: number; clientY: number },
  ): void {
    if ((!insertFileAttachment && !insertFileAttachments) || !uploadImage() || files.length === 0) return;
    const context = {
      source,
      ...(at === undefined ? {} : { at }),
    };
    if (insertFileAttachments !== undefined) {
      const accepted = insertFileAttachments(
        files.map((file) => ({ file, path: resolveFilePath(file) })),
        context,
      );
      files.forEach((file, index) => {
        if (accepted[index] !== true) return;
        track('attachment_added', {
          via,
          kind: attachmentKind(file.type),
          size_bucket: attachmentSizeBucket(file.size),
          count: Math.min(files.length, 100),
        });
      });
      return;
    }
    let seamTaken = false;
    for (const file of files) {
      if (insertFileAttachment!(file, resolveFilePath(file), {
        source,
        ...(seamTaken || at === undefined ? {} : { at }),
      })) {
        seamTaken = true;
        track('attachment_added', {
          via,
          kind: attachmentKind(file.type),
          size_bucket: attachmentSizeBucket(file.size),
          count: Math.min(files.length, 100),
        });
      }
    }
  }

  function openFilePicker(): void {
    fileInputRef.value?.click();
  }

  function addFiles(files: File[]): void {
    routeFiles(files, 'screenshot', 'screenshot');
  }

  function handleFileInputChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    routeFiles(files, 'click', 'picker');
    input.value = '';
  }

  function handleDocumentPaste(e: ClipboardEvent): void {
    const cd = e.clipboardData;
    if (!cd) return;
    const pasteTarget = deps.pasteTarget?.() ?? 'editor';
    if (pasteTarget === 'ignore') return;

    const { items, folderPaths, hasFolders } = partitionPastedItems(cd);
    const consumesFiles = items.some((item) => item.kind === 'file') && uploadImage();
    if (folderPaths.length > 0 || hasFolders || consumesFiles) e.preventDefault();
    let fileRun: File[] = [];
    const flushFileRun = (): void => {
      if (fileRun.length === 0) return;
      routeFiles(
        renamePastedBlobs(fileRun),
        'paste',
        pasteTarget === 'editor' ? 'paste-editor' : 'paste-composer',
      );
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

  function renamePastedBlobs(files: readonly File[]): File[] {
    return files.map((file) => {
      if (file.name.includes('.')) return file;
      if (resolveFilePath(file) !== null) return file;
      const ext = file.type.split('/')[1] ?? 'png';
      return new File([file], `paste-${Date.now()}.${ext}`, { type: file.type });
    });
  }

  let windowDragDepth = 0;

  function handleDragOver(e: DragEvent): void {
    if (!uploadImage()) return;
    const hasFiles = Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === 'file');
    if (!hasFiles) return;
    e.preventDefault();
    e.stopPropagation();
    isDragOver.value = true;
  }

  function handleDragLeave(): void {
    isDragOver.value = false;
  }

  function routeDroppedItems(
    items: readonly DroppedItem[],
    at: { clientX: number; clientY: number },
    consumesFiles: boolean,
  ): void {
    let fileRun: File[] = [];
    let coords: { clientX: number; clientY: number } | undefined = at;
    const flushFileRun = (): void => {
      if (fileRun.length === 0) return;
      routeFiles(fileRun, 'drop', 'drop', coords);
      coords = undefined;
      fileRun = [];
    };
    for (const item of items) {
      if (item.kind === 'folder') {
        flushFileRun();
        insertFolderPaths?.([item.path]);
        coords = undefined;
      } else if (consumesFiles) {
        fileRun.push(item.file);
      }
    }
    flushFileRun();
  }

  function handleDrop(e: DragEvent): void {
    resetAllDragOver();
    const { items, folderPaths } = partitionDroppedItems(e);
    if (folderPaths.length > 0) {
      e.preventDefault();
      e.stopPropagation();
    }
    const consumesFiles = uploadImage();
    if (consumesFiles) {
      e.preventDefault();
      e.stopPropagation();
    }
    routeDroppedItems(items, { clientX: e.clientX, clientY: e.clientY }, !!consumesFiles);
  }

  function windowDragHasFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === 'file');
  }

  function dropSurfaceHidden(): boolean {
    return deps.dropSurfaceVisible?.() === false;
  }

  function handleWindowDragEnter(e: DragEvent): void {
    if (dropSurfaceHidden() || !uploadImage() || !windowDragHasFiles(e)) return;
    e.preventDefault();
    windowDragDepth += 1;
    isDragOver.value = true;
  }

  function handleWindowDragOver(e: DragEvent): void {
    if (dropSurfaceHidden() || !uploadImage() || !windowDragHasFiles(e)) return;
    e.preventDefault();
  }

  function handleWindowDragLeave(e: DragEvent): void {
    if (!uploadImage() || !windowDragHasFiles(e)) return;
    windowDragDepth = Math.max(0, windowDragDepth - 1);
    if (windowDragDepth === 0) isDragOver.value = false;
  }

  function handleWindowDrop(e: DragEvent): void {
    resetAllDragOver();
    if (dropSurfaceHidden()) return;
    const { items, folderPaths } = partitionDroppedItems(e);
    if (folderPaths.length > 0) e.preventDefault();
    const consumesFiles = uploadImage();
    if (consumesFiles) e.preventDefault();
    routeDroppedItems(items, { clientX: e.clientX, clientY: e.clientY }, !!consumesFiles);
  }

  watch(sessionId, () => {
    hydrateDraft(sessionId() ?? '');
  });

  hydrateDraft(sessionId() ?? '');

  let windowDropRegistered = false;
  const resetDragOver = (): void => {
    windowDragDepth = 0;
    isDragOver.value = false;
  };
  onMounted(() => {
    dragOverResetters.add(resetDragOver);
    document.addEventListener('paste', handleDocumentPaste);
    windowDropRegistered = deps.windowDrop?.() !== false;
    if (!windowDropRegistered) return;
    document.addEventListener('dragenter', handleWindowDragEnter);
    document.addEventListener('dragover', handleWindowDragOver);
    document.addEventListener('dragleave', handleWindowDragLeave);
    document.addEventListener('drop', handleWindowDrop);
  });

  onUnmounted(() => {
    dragOverResetters.delete(resetDragOver);
    document.removeEventListener('paste', handleDocumentPaste);
    if (!windowDropRegistered) return;
    document.removeEventListener('dragenter', handleWindowDragEnter);
    document.removeEventListener('dragover', handleWindowDragOver);
    document.removeEventListener('dragleave', handleWindowDragLeave);
    document.removeEventListener('drop', handleWindowDrop);
  });

  return {
    fileInputRef,
    isDragOver,
    openFilePicker,
    addFiles,
    handleFileInputChange,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    adoptStoredDrafts,
  };
}
