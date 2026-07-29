// apps/kimi-web/src/composables/useFilePreview.ts
// File preview: download / path normalization / request-sequence guard. Claims
// the 'file' slot of the shared right-side detail layer.

import { computed, ref, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import { isDaemonApiError } from '../api/errors';
import { pathRelativeTo } from '../lib/pathRelativeTo';
import type { FileData, FilePreviewRequest, ToolMedia } from '../types';
import type { useKimiWebClient } from './useKimiWebClient';

type KimiWebClient = ReturnType<typeof useKimiWebClient>;

// Daemon FS_PATH_NOT_FOUND (see kap-server protocol/error-codes): the global
// fs:content reports a genuinely-absent absolute path with this code.
const FS_PATH_NOT_FOUND = 40409;

function isNotFoundError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === FS_PATH_NOT_FOUND;
}

// A tool-reported absolute path: POSIX (`/x`), a Windows drive (`C:\x`/`C:/x`),
// or a UNC share (`\\host\x`). The daemon's global fs:content takes these as-is;
// anything else is workspace-relative and stays on the session fs:read path.
function isAbsoluteToolPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Which occupant currently owns the shared right-side detail layer. */
export type DetailTarget = 'file' | 'diff' | 'turn-diff' | 'compaction' | 'agent' | 'btw';

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
  // Open-in-editor / reveal go through the session-relative fs:open/:reveal, so
  // they only work for a file inside the workspace (previewNormalizedPath set);
  // hide them for a genuinely-external absolute path those endpoints can't serve.
  const previewExternalActions = computed(
    () => previewTarget.value !== null && previewNormalizedPath.value !== null,
  );

  function trimTrailingSlash(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  }

  // The workspace-relative form of an in-cwd absolute path, or null when the
  // file lives outside the active workspace (no servable download URL then).
  function workspaceRelativePath(absPath: string): string | null {
    const relative = pathRelativeTo(absPath, client.status.value.cwd);
    if (relative === null || relative.split(/[\\/]+/).includes('..')) return null;
    const rel = normalizeRelativePath(relative);
    return rel || null;
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
    // Clicking the link for the already-open file toggles the panel closed. The
    // identity includes allowHostRead: a chat link that failed outsideWorkspace
    // (no opt-in) and the summary's trusted open of the SAME path are different
    // requests — the trusted one must read, not toggle the error panel shut.
    const current = previewTarget.value;
    if (
      detailTarget.value === 'file' &&
      current &&
      current.path === target.path &&
      current.line === target.line &&
      (current.allowHostRead ?? false) === (target.allowHostRead ?? false)
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

    // Inline content (e.g. the plan file, which lives outside the workspace
    // root and the daemon can't serve): render directly, no fetch. Keep
    // previewNormalizedPath null — a download URL built from it would point at
    // a path the daemon cannot serve.
    if (typeof target.content === 'string') {
      previewLoading.value = false;
      previewFile.value = {
        path: target.path,
        content: target.content,
        encoding: 'utf-8',
        mime: 'text/markdown',
        isBinary: false,
        size: target.content.length,
      };
      return;
    }

    // An opted-in (allowHostRead) parent-relative path ("../shared/x.ts") has
    // no absolute form yet — resolve it against the cwd so the absolute-path
    // branch below can read it via fs:content; a non-opted-in one stays
    // confined (normalizePreviewPath rejects the "..").
    if (
      target.allowHostRead &&
      !isAbsoluteToolPath(target.path) &&
      target.path.split(/[\\/]+/).includes('..')
    ) {
      const cwd = trimTrailingSlash(client.status.value.cwd);
      if (cwd) target = { ...target, path: `${cwd}/${target.path}` };
    }

    // Absolute path. An in-workspace file relativizes and falls through to the
    // session path below (which also serves its download URL / open / reveal).
    // A genuinely-external file reads via the daemon's global fs:content ONLY
    // when the caller opted in (allowHostRead — the turn's file-change summary,
    // whose paths the agent touched); an ordinary chat / Markdown link to an
    // outside path stays confined (outsideWorkspace).
    if (isAbsoluteToolPath(target.path)) {
      const relPath = workspaceRelativePath(target.path);
      if (relPath !== null) {
        target = { ...target, path: relPath };
      } else if (!target.allowHostRead) {
        previewLoading.value = false;
        previewError.value = t('filePreview.errors.outsideWorkspace');
        return;
      } else {
        try {
          const result = await client.readHostFileContent(target.path);
          if (requestSeq !== previewRequestSeq) return;
          previewNormalizedPath.value = null;
          previewFile.value = {
            path: target.path,
            content: result.content,
            encoding: result.encoding,
            mime: result.mime,
            isBinary: result.isBinary,
            size: result.size,
          };
        } catch (err) {
          if (requestSeq !== previewRequestSeq) return;
          previewError.value = isNotFoundError(err)
            ? t('filePreview.errors.notFound')
            : err instanceof Error
              ? err.message
              : t('filePreview.errors.loadFailed');
        } finally {
          if (requestSeq === previewRequestSeq) previewLoading.value = false;
        }
        return;
      }
    }

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
        // already logged in readFileContent).
        previewError.value = t('filePreview.errors.loadFailed');
      }
    } catch (err) {
      if (requestSeq !== previewRequestSeq) return;
      // readFileContent rethrows fs.path_not_found — the file was renamed or
      // deleted after the turn touched it, which is not a read failure.
      previewError.value = isNotFoundError(err)
        ? t('filePreview.errors.notFound')
        : err instanceof Error
          ? err.message
          : t('filePreview.errors.loadFailed');
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
    if (media.kind !== 'image') return;
    const seq = ++previewRequestSeq;
    revokeMediaObjectUrl();
    detailTarget.value = 'file';
    previewTarget.value = null;
    previewNormalizedPath.value = null;
    previewError.value = null;
    const base = {
      path: media.path ?? 'ReadMediaFile image',
      content: '',
      encoding: 'utf-8' as const,
      mime: media.mimeType ?? mimeFromDataUrl(media.url) ?? 'image/*',
      isBinary: true,
      size: media.bytes ?? 0,
    };
    if (media.fileId) {
      // The raw getFileUrl 401s under daemon auth (browsers load <img> without
      // the Bearer token), so fetch the bytes with auth and preview a blob URL.
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
      previewFile.value = { ...base, sourceUrl: media.url };
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
