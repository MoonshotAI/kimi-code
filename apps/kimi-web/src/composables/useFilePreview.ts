// apps/kimi-web/src/composables/useFilePreview.ts
// File preview: download / path normalization / request-sequence guard. Claims
// the 'file' slot of the shared right-side detail layer.

import { computed, ref, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import type { FileData, FilePreviewRequest, ToolMedia } from '../types';
import type { useKimiWebClient } from './useKimiWebClient';

type KimiWebClient = ReturnType<typeof useKimiWebClient>;

/** Which occupant currently owns the shared right-side detail layer. */
export type DetailTarget = 'file' | 'diff' | 'thinking' | 'compaction' | 'agent' | 'toolDiff' | 'btw';

/** Whether a url can feed a native <video>/<img> src. A provider reference like
 *  `ms://…` has no local bytes and only yields a broken player, so it's treated
 *  as non-loadable and falls through to the no-preview card. */
export function isPlayableMediaUrl(url: string): boolean {
  return /^(?:https?:|blob:|data:)/i.test(url);
}

export interface UseFilePreviewOptions {
  client: KimiWebClient;
  detailTarget: Ref<DetailTarget | null>;
}

export function useFilePreview({ client, detailTarget }: UseFilePreviewOptions) {
  const { t } = useI18n();

  const previewTarget = ref<FilePreviewRequest | null>(null);
  const previewFile = ref<FileData | null>(null);
  const previewLoading = ref(false);
  const previewError = ref<string | null>(null);
  // Normalized workspace-relative path of the currently-open preview. Used for
  // the download URL so it matches the server's relative-path contract even when
  // the user opened the preview from an absolute path in the chat.
  const previewNormalizedPath = ref<string | null>(null);
  // Incremented on every openFilePreview call so a slower earlier request can't
  // overwrite the result of a later one (request-sequence guard).
  let previewRequestSeq = 0;
  // Authenticated blob URL backing the current media preview, when the media
  // came from the file store (a bare getFileUrl 401s in <img> under daemon
  // auth). Revoked when the preview is replaced or closed.
  let mediaObjectUrl: string | null = null;
  function revokeMediaObjectUrl(): void {
    if (mediaObjectUrl !== null) {
      URL.revokeObjectURL(mediaObjectUrl);
      mediaObjectUrl = null;
    }
  }

  const previewDownloadUrl = computed(() => {
    const path = previewNormalizedPath.value;
    return path ? client.getFileDownloadUrl(path) : null;
  });
  const previewExternalActions = computed(() => previewTarget.value !== null);

  function trimTrailingSlash(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  }

  function normalizeRelativePath(path: string): string {
    const out: string[] = [];
    for (const part of path.split(/[\\/]+/)) {
      if (!part || part === '.') continue;
      if (part === '..') {
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out.join('/');
  }

  function normalizePreviewPath(inputPath: string): { path: string } | { error: string } {
    const raw = inputPath.trim();
    if (!raw) return { error: t('filePreview.errors.emptyPath') };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return { error: t('filePreview.errors.unsupportedPath') };
    }
    if (raw.startsWith('~')) {
      return { error: t('filePreview.errors.outsideWorkspace') };
    }

    const cwd = trimTrailingSlash(client.status.value.cwd);
    if (raw.startsWith('/')) {
      if (!cwd || (raw !== cwd && !raw.startsWith(`${cwd}/`))) {
        return { error: t('filePreview.errors.outsideWorkspace') };
      }
      const relative = raw === cwd ? '' : raw.slice(cwd.length + 1);
      if (relative.split(/[\\/]+/).includes('..')) {
        return { error: t('filePreview.errors.outsideWorkspace') };
      }
      const path = normalizeRelativePath(relative);
      return path ? { path } : { error: t('filePreview.errors.isDirectory') };
    }

    if (raw.split(/[\\/]+/).includes('..')) {
      return { error: t('filePreview.errors.outsideWorkspace') };
    }

    const path = normalizeRelativePath(raw);
    return path ? { path } : { error: t('filePreview.errors.emptyPath') };
  }

  async function openFilePreview(target: FilePreviewRequest): Promise<void> {
    // Clicking the link for the already-open file toggles the panel closed.
    const current = previewTarget.value;
    if (
      detailTarget.value === 'file' &&
      current &&
      current.path === target.path &&
      current.line === target.line
    ) {
      closeFilePreview();
      return;
    }
    const requestSeq = ++previewRequestSeq;
    revokeMediaObjectUrl();
    detailTarget.value = 'file';
    previewFile.value = null;
    previewError.value = null;
    previewLoading.value = true;
    previewTarget.value = target;
    previewNormalizedPath.value = null;

    const normalized = normalizePreviewPath(target.path);
    if ('error' in normalized) {
      previewLoading.value = false;
      previewError.value = normalized.error;
      return;
    }
    previewNormalizedPath.value = normalized.path;

    try {
      const result = await client.readFileContent(normalized.path);
      // A newer openFilePreview started while this one was in flight — discard
      // the stale result so the right-side panel shows the latest file.
      if (requestSeq !== previewRequestSeq) return;
      if (result) {
        previewFile.value = { ...result, path: result.path || normalized.path };
      } else {
        // readFileContent swallows daemon failures into null — show the error
        // state instead of a misleading 0-byte "empty file" (the cause is
        // already console.warn'd in readFileContent).
        previewError.value = t('filePreview.errors.loadFailed');
      }
    } catch (err) {
      if (requestSeq !== previewRequestSeq) return;
      previewError.value = err instanceof Error ? err.message : t('filePreview.errors.loadFailed');
    } finally {
      if (requestSeq === previewRequestSeq) {
        previewLoading.value = false;
      }
    }
  }

  function mimeFromDataUrl(url: string): string | undefined {
    const match = /^data:([^;,]+)/i.exec(url);
    return match?.[1];
  }

  function openMediaPreview(media: ToolMedia): void {
    if (media.kind !== 'image' && media.kind !== 'video') return;
    const seq = ++previewRequestSeq;
    revokeMediaObjectUrl();
    detailTarget.value = 'file';
    previewTarget.value = null;
    previewNormalizedPath.value = null;
    previewError.value = null;
    const isVideo = media.kind === 'video';
    const base = {
      path: media.path ?? (isVideo ? 'Video' : 'ReadMediaFile image'),
      content: '',
      encoding: 'utf-8' as const,
      mime: media.mimeType ?? mimeFromDataUrl(media.url) ?? (isVideo ? 'video/*' : 'image/*'),
      isBinary: true,
      size: media.bytes ?? 0,
    };
    // The raw URL 401s under daemon auth (browsers load media without the
    // Bearer token), so fetch the bytes with auth and preview a blob URL.
    if (media.fileId) {
      previewLoading.value = true;
      previewFile.value = base;
      void getKimiWebApi().getFileBlob(media.fileId).then((blob) => {
        if (seq !== previewRequestSeq) return;
        // The user may have switched to another detail panel while this was in
        // flight — don't create (and leak) a blob URL for a hidden panel.
        if (detailTarget.value !== 'file' || !previewFile.value) {
          previewLoading.value = false;
          return;
        }
        mediaObjectUrl = URL.createObjectURL(blob);
        previewFile.value = { ...previewFile.value, sourceUrl: mediaObjectUrl };
        previewLoading.value = false;
      }).catch(() => {
        if (seq !== previewRequestSeq) return;
        // Fall back to the raw URL so the user sees an honest broken state.
        if (previewFile.value) previewFile.value = { ...previewFile.value, sourceUrl: media.url };
        previewLoading.value = false;
      });
    } else {
      previewLoading.value = false;
      // A non-loadable url (e.g. a provider `ms://` reference with no local
      // bytes) can't feed a <video>/<img> src — leave sourceUrl unset so the
      // preview shows the no-preview card instead of a broken player.
      previewFile.value = isPlayableMediaUrl(media.url) ? { ...base, sourceUrl: media.url } : base;
    }
  }

  function resetFilePreview(): void {
    // Invalidate any in-flight authenticated media fetch so it doesn't create a
    // blob URL after the panel is gone (which would leak until the next preview).
    previewRequestSeq += 1;
    previewTarget.value = null;
    previewNormalizedPath.value = null;
    previewFile.value = null;
    previewError.value = null;
    previewLoading.value = false;
    revokeMediaObjectUrl();
  }

  function closeFilePreview(): void {
    resetFilePreview();
    if (detailTarget.value === 'file') detailTarget.value = null;
  }

  // Revoke/close the preview when the user switches to another detail panel
  // (useDetailPanel only flips detailTarget and does not call closeFilePreview),
  // so an in-flight or already-shown blob URL isn't held while the file panel
  // is hidden.
  watch(detailTarget, (target, oldTarget) => {
    if (oldTarget === 'file' && target !== 'file') resetFilePreview();
  });

  function openPreviewInEditor(): void {
    const path = previewFile.value?.path ?? previewTarget.value?.path;
    if (!path) return;
    void client.openWorkspaceFile(path, previewTarget.value?.line);
  }

  function revealPreviewFile(): void {
    const path = previewFile.value?.path ?? previewTarget.value?.path;
    if (!path) return;
    void client.revealWorkspaceFile(path);
  }

  return {
    previewTarget,
    previewFile,
    previewLoading,
    previewError,
    previewDownloadUrl,
    previewExternalActions,
    openFilePreview,
    openMediaPreview,
    closeFilePreview,
    openPreviewInEditor,
    revealPreviewFile,
  };
}
