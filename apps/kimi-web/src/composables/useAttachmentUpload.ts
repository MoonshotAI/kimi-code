// apps/kimi-web/src/composables/useAttachmentUpload.ts
// Image/video attachment handling for the composer: file picker, paste, drag &
// drop, the upload machinery, the chip strip, and the preview lightbox.
//
// Pending attachments are scoped per session (keyed by session id) so switching
// sessions can't leak one session's unsent attachments into another session's
// next submit. The composer keeps `handleSubmit`/`handleSteer` (which read the
// attachments to build the payload) and the `hasUpload` toolbar flag; this
// composable owns the attachment state, all the file-input UI handlers, and the
// paste listener + object-URL cleanup lifecycle.

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

export interface Attachment {
  /** Unique local id (used as :key) */
  localId: string;
  /** File name */
  name: string;
  /** image or video — drives the chip preview and the content-block type. */
  kind: 'image' | 'video';
  /** Object URL for the thumbnail preview */
  previewUrl: string;
  /** True while uploading */
  uploading: boolean;
  /** Resolved daemon file id (set after upload completes) */
  fileId?: string;
  /** True if upload failed */
  error?: boolean;
}

type UploadImage = (
  file: Blob,
  name?: string,
) => Promise<{ fileId: string; name: string; mediaType: string } | null>;

export interface AttachmentUploadDeps {
  /** Upload a blob; resolves to the daemon file id, or null on failure.
      Getter so a prop change is picked up. Undefined disables attaching. */
  uploadImage: () => UploadImage | undefined;
  /** Active session id — scopes pending attachments (getter for reactivity). */
  sessionId: () => string | undefined;
}

export function useAttachmentUpload(deps: AttachmentUploadDeps) {
  const { uploadImage, sessionId } = deps;

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
    try { URL.revokeObjectURL(att.previewUrl); } catch { /* ignore */ }
  }

  function mediaKind(mime: string): 'image' | 'video' | null {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    return null;
  }

  async function addFiles(files: File[]): Promise<void> {
    const upload = uploadImage();
    if (!upload) return;
    // Capture the session at upload time; async completion must update the same
    // session even if the user has since switched away.
    const sid = sessionId() ?? '';
    const media = files
      .map((file) => ({ file, kind: mediaKind(file.type) }))
      .filter((m): m is { file: File; kind: 'image' | 'video' } => m.kind !== null);
    if (media.length === 0) return;

    for (const { file, kind } of media) {
      const localId = nextLocalId();
      const previewUrl = URL.createObjectURL(file);
      const att: Attachment = { localId, name: file.name, kind, previewUrl, uploading: true };
      setForSession(sid, [...(attachmentsBySession.value[sid] ?? []), att]);

      // Upload in background; update the attachment when done.
      upload(file, file.name).then((result) => {
        const current = attachmentsBySession.value[sid] ?? [];
        setForSession(
          sid,
          current.map((a) =>
            a.localId === localId
              ? { ...a, uploading: false, fileId: result?.fileId, error: result === null }
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
    void addFiles(files);
    // Reset so re-selecting the same file fires change again.
    input.value = '';
  }

  // Global document-level paste handler — captures Ctrl+V anywhere the composer is mounted.
  function handleDocumentPaste(e: ClipboardEvent): void {
    if (!uploadImage()) return;

    const cd = e.clipboardData;
    if (!cd) return;

    // Collect image files from both .items and .files to cover all browsers/OS.
    const files: File[] = [];
    const seenKeys = new Set<string>();

    const addBlob = (blob: File | Blob, name: string): void => {
      const key = `${blob.size}:${blob.type}:${name}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      const ext = blob.type.split('/')[1] ?? 'png';
      const safeName = name.includes('.') ? name : `paste-${Date.now()}.${ext}`;
      files.push(blob instanceof File ? blob : new File([blob], safeName, { type: blob.type }));
    };

    // From DataTransferItemList.
    for (const item of Array.from(cd.items)) {
      if (item.kind === 'file' && mediaKind(item.type)) {
        const blob = item.getAsFile();
        if (blob) addBlob(blob, blob.name || `paste-${Date.now()}.${item.type.split('/')[1] ?? 'png'}`);
      }
    }

    // From FileList (some browsers/OS put screenshots here directly).
    for (const file of Array.from(cd.files)) {
      if (mediaKind(file.type)) {
        addBlob(file, file.name);
      }
    }

    if (files.length === 0) return; // No media — let normal text paste proceed unmodified.

    e.preventDefault();
    void addFiles(files);
  }

  // Drag-drop handlers.
  function handleDragOver(e: DragEvent): void {
    if (!uploadImage()) return;
    const hasFiles = Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === 'file');
    if (!hasFiles) return;
    e.preventDefault();
    isDragOver.value = true;
  }

  function handleDragLeave(): void {
    isDragOver.value = false;
  }

  function handleDrop(e: DragEvent): void {
    isDragOver.value = false;
    if (!uploadImage()) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    void addFiles(files);
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

  // Close the preview lightbox when switching sessions — it may reference an
  // attachment that belongs to the previous session.
  watch(sessionId, () => {
    previewAttachment.value = null;
  });

  onMounted(() => {
    document.addEventListener('paste', handleDocumentPaste);
  });

  // Revoke all object URLs (every session) and remove the global listener on unmount.
  onUnmounted(() => {
    document.removeEventListener('paste', handleDocumentPaste);
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
  };
}
