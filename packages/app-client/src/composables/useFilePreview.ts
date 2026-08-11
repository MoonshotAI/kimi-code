// packages/app-client/src/composables/useFilePreview.ts
// File preview: download / path normalization / request-sequence guard. Claims
// the 'file' slot of the shared right-side detail layer. The translator is
// injected — see UseFilePreviewOptions.

import { computed, ref, watch, type Ref } from 'vue';
import { isDaemonApiError, isFileTooLargeError } from '@moonshot-ai/app-core/api';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { pathRelativeTo } from '@moonshot-ai/app-core/lib';
import type { FileData, FilePreviewRequest } from '@moonshot-ai/app-core/client';

/** The slice of the app's client composable this preview needs (structural —
    the app's useKimiWebClient return satisfies it). */
export interface FilePreviewClient {
  status: Ref<{ cwd: string }>;
  getFileDownloadUrl(path: string): string | null;
  readHostFileContent(path: string): Promise<FileData>;
  readFileContent(path: string): Promise<FileData | null>;
  openWorkspaceFile(path: string, line?: number): Promise<boolean>;
  revealWorkspaceFile(path: string): Promise<boolean>;
}

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

// Lexically normalize an absolute path — resolve "." and ".." segments without
// touching the filesystem (".." clamps at the root / drive). POSIX and
// Windows-drive paths stay absolute; UNC shares pass through untouched. Done
// before the in-workspace check so "src/../a.ts" (or "/repo/src/../a.ts")
// keeps the session read path instead of falling into the host-read branch.
function normalizeAbsolutePath(path: string): string {
  if (path.startsWith('\\\\')) return path;
  const drive = /^[a-zA-Z]:/.test(path) ? path.slice(0, 2) : '';
  const out: string[] = [];
  for (const part of path.slice(drive.length).split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return drive ? `${drive}/${out.join('/')}` : `/${out.join('/')}`;
}

/** Which occupant currently owns the shared right-side detail layer. */
export type DetailTarget = 'file' | 'diff' | 'turn-diff' | 'compaction' | 'agent' | 'btw';

export interface UseFilePreviewOptions {
  client: FilePreviewClient;
  detailTarget: Ref<DetailTarget | null>;
  /** Translator for the error strings (the app's vue-i18n `t`). */
  t: Translator;
}

export function useFilePreview({ client, detailTarget, t }: UseFilePreviewOptions) {

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

    // A parent-relative path ("../shared/x.ts") has no absolute form yet —
    // resolve it against the cwd, normalized, so the absolute-path branch
    // below sorts it correctly: "src/../a.ts" stays in-cwd and keeps the
    // session read path; only a path that genuinely escapes ("../../x") lands
    // in the host-read branch.
    if (!isAbsoluteToolPath(target.path) && target.path.split(/[\\/]+/).includes('..')) {
      const cwd = trimTrailingSlash(client.status.value.cwd);
      if (cwd) target = { ...target, path: normalizeAbsolutePath(`${cwd}/${target.path}`) };
    }

    // Absolute path. An in-workspace file relativizes and falls through to the
    // session path below (which also serves its download URL / open / reveal).
    // A genuinely-external file reads via the daemon's global fs:content —
    // previewing is a local read-only action, so it is not confined to the
    // workspace (workspace-level trust gating is handled separately).
    if (isAbsoluteToolPath(target.path)) {
      target = { ...target, path: normalizeAbsolutePath(target.path) };
      const relPath = workspaceRelativePath(target.path);
      if (relPath !== null) {
        target = { ...target, path: relPath };
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
            : isFileTooLargeError(err)
              ? t('filePreview.errors.tooLarge')
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

  function resetFilePreview(): void {
    previewRequestSeq += 1;
    previewTarget.value = null;
    previewNormalizedPath.value = null;
    previewFile.value = null;
    previewError.value = null;
    previewLoading.value = false;
  }

  function closeFilePreview(): void {
    resetFilePreview();
    if (detailTarget.value === 'file') detailTarget.value = null;
  }

  // Close the preview when the user switches to another detail panel
  // (useDetailPanel only flips detailTarget and does not call closeFilePreview),
  // so an in-flight request can't populate a hidden panel.
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
    closeFilePreview,
    openPreviewInEditor,
    revealPreviewFile,
  };
}
