// packages/app-client/src/composables/useAttachmentUpload.ts
// Attachment handling for the composer: file picker, paste, drag & drop, the
// upload machinery, the chip strip, and the preview lightbox. Images and
// videos get media chips with thumbnails; any other file type attaches as a
// generic file chip (an icon + name, no thumbnail) and is sent as a file part.
// Dropped or pasted folders are the exception: they are never uploaded (the
// endpoint rejects them) — the desktop bridge resolves their absolute paths
// and they are inserted into the draft text instead (see
// nativeWorkspaceDrop.ts).
//
// Pending attachments are scoped per session (keyed by session id) so switching
// sessions can't leak one session's unsent attachments into another session's
// next submit. The composer keeps `handleSubmit`/`handleSteer` (which read the
// attachments to build the payload) and the `hasUpload` toolbar flag; this
// composable owns the attachment state, all the file-input UI handlers, and the
// paste listener + object-URL cleanup lifecycle.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import type { TurnAttachment } from '@moonshot-ai/app-core/client';
import { track } from '../contracts';
import { partitionDroppedItems, partitionPastedItems } from '@moonshot-ai/app-core/lib';

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
      auth, so protected thumbnails load through the API client. */
  api: Pick<KimiWebApi, 'getFileBlob' | 'getSessionMediaBlob'>;
  /** Upload a blob; resolves to the daemon file id, or null on failure.
      Getter so a prop change is picked up. Undefined disables attaching. */
  uploadImage: () => UploadImage | undefined;
  /** Active session id — scopes pending attachments (getter for reactivity). */
  sessionId: () => string | undefined;
  /** Dropped or pasted folders are never uploaded (the endpoint rejects
      them) — the desktop bridge resolves their absolute paths and the
      composer inserts them into the draft text instead. Without the bridge
      (web) a folder resolves to no path and is simply ignored. */
  insertFolderPaths?: (paths: string[]) => void;
}

export function useAttachmentUpload(deps: AttachmentUploadDeps) {
  const { api, uploadImage, sessionId, insertFolderPaths } = deps;

  const attachmentsBySession = ref<Record<string, Attachment[]>>({});
  const attachments = computed(() => attachmentsBySession.value[sessionId() ?? ''] ?? []);
  const previewAttachment = ref<Attachment | null>(null);
  const fileInputRef = ref<HTMLInputElement | null>(null);
  const isDragOver = ref(false);

  let localIdCounter = 0;
  function nextLocalId(): string {
    return `att_${++localIdCounter}`;
  }

  function setForSession(sid: string, next: Attachment[]): void {
    attachmentsBySession.value = { ...attachmentsBySession.value, [sid]: next };
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

  async function addFiles(files: File[], via: 'drop' | 'click' | 'paste'): Promise<void> {
    const upload = uploadImage();
    if (!upload) return;
    // Capture the session at upload time; async completion must update the same
    // session even if the user has since switched away.
    const sid = sessionId() ?? '';
    if (files.length === 0) return;

    for (const file of files) {
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
        uploading: true,
      };
      setForSession(sid, [...(attachmentsBySession.value[sid] ?? []), att]);

      // Upload in background; update the attachment when done.
      upload(file, file.name).then((result) => {
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
        const current = attachmentsBySession.value[sid] ?? [];
        setForSession(
          sid,
          current.map((a) => (a.localId === localId ? { ...a, uploading: false, error: true } : a)),
        );
      });
    }
  }

  function removeAttachment(localId: string): void {
    const sid = sessionId() ?? '';
    const current = attachmentsBySession.value[sid] ?? [];
    const att = current.find((a) => a.localId === localId);
    if (previewAttachment.value?.localId === localId) previewAttachment.value = null;
    if (att) revokeAttachment(att);
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
    void addFiles(files, 'click');
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
    const { files: pastedFiles, folderPaths, hasFolders } = partitionPastedItems(cd);
    if (folderPaths.length > 0) {
      insertFolderPaths?.(folderPaths);
      // Keep the default paste from also inserting the folder's name as text.
      e.preventDefault();
    } else if (hasFolders) {
      // Folders were seen but none resolved (web / no bridge): they are meant
      // to be ignored, so swallow the default paste too — otherwise the
      // clipboard's text/plain (the folder's name) lands in the draft.
      e.preventDefault();
    }

    if (!uploadImage()) return;
    if (pastedFiles.length === 0) return; // No files — let normal text paste proceed unmodified.

    // A pasted blob with a dot-less name (e.g. a screenshot) gets a
    // paste-<timestamp>.<ext> name so the chip and wire part stay readable.
    const files = pastedFiles.map((file) => {
      if (file.name.includes('.')) return file;
      const ext = file.type.split('/')[1] ?? 'png';
      return new File([file], `paste-${Date.now()}.${ext}`, { type: file.type });
    });

    e.preventDefault();
    void addFiles(files, 'paste');
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

  function handleDrop(e: DragEvent): void {
    windowDragDepth = 0;
    isDragOver.value = false;
    const { files, folderPaths } = partitionDroppedItems(e);
    if (folderPaths.length > 0) {
      // Folders never hit the upload endpoint — their paths go into the draft.
      insertFolderPaths?.(folderPaths);
      // Keep the document-level drop handler from re-inserting the same paths.
      e.preventDefault();
      e.stopPropagation();
    }
    if (!uploadImage()) return;
    // Stop the document-level drop handler from adding the same files twice.
    e.preventDefault();
    e.stopPropagation();
    void addFiles(files, 'drop');
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
    const { files, folderPaths } = partitionDroppedItems(e);
    if (folderPaths.length > 0) {
      // Folders never hit the upload endpoint — their paths go into the draft.
      insertFolderPaths?.(folderPaths);
      e.preventDefault();
    }
    if (!uploadImage()) return;
    e.preventDefault();
    void addFiles(files, 'drop');
  }

  /** Revoke every object URL and drop all attachments for the current session
      (called after submit/steer). */
  function clearAfterSubmit(): void {
    const sid = sessionId() ?? '';
    for (const att of attachmentsBySession.value[sid] ?? []) {
      revokeAttachment(att);
    }
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
      setForSession(sid, []);
    }
    for (const att of atts) {
      const localId = nextLocalId();
      const isData = /^data:/i.test(att.url);
      const isBlob = /^blob:/i.test(att.url);
      const name = att.name ?? att.kind;

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
        };
        setForSession(sid, [...(attachmentsBySession.value[sid] ?? []), entry]);
        if (att.kind === 'image' && !isData && !isBlob) {
          const blobRequest = att.sessionId
            ? api.getSessionMediaBlob(att.sessionId, att.fileId)
            : api.getFileBlob(att.fileId);
          void blobRequest.then((blob) => {
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
          uploading: true,
        };
        setForSession(sid, [...(attachmentsBySession.value[sid] ?? []), entry]);
        void urlToBlob(att.url)
          .then((blob) => {
            const fname = name.includes('.') ? name : `${name}.${blob.type.split('/')[1] ?? 'bin'}`;
            return upload(blob, fname);
          })
          .then((result) => {
            if (result === null) {
              const current = attachmentsBySession.value[sid] ?? [];
              setForSession(sid, current.filter((a) => a.localId !== localId));
              return;
            }
            patchAttachment(sid, localId, { uploading: false, fileId: result.fileId });
          })
          .catch(() => {
            const current = attachmentsBySession.value[sid] ?? [];
            setForSession(sid, current.filter((a) => a.localId !== localId));
          });
      }
    }
  }

  // Close the preview lightbox when switching sessions — it may reference an
  // attachment that belongs to the previous session.
  watch(sessionId, () => {
    previewAttachment.value = null;
  });

  onMounted(() => {
    document.addEventListener('paste', handleDocumentPaste);
    document.addEventListener('dragenter', handleWindowDragEnter);
    document.addEventListener('dragover', handleWindowDragOver);
    document.addEventListener('dragleave', handleWindowDragLeave);
    document.addEventListener('drop', handleWindowDrop);
  });

  // Revoke all object URLs (every session) and remove the global listener on unmount.
  onUnmounted(() => {
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
  };
}
