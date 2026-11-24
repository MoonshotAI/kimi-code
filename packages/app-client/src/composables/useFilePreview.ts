
import { computed, getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';
import { isDaemonApiError, isFileTooLargeError } from '@moonshot-ai/app-core/api';
import type { Translator } from '@moonshot-ai/app-core/contracts';
import { expandWorkspacePathTilde, isAbsoluteLocalPath, normalizeRelativePath, pathRelativeTo, resolveLocalPath } from '@moonshot-ai/app-core/lib';
import { FILE_PREVIEW_MAX_BYTES, type FileData, type FilePreviewRequest } from '@moonshot-ai/app-core/client';

export interface FilePreviewClient {
  status: Ref<{ cwd: string }>;
  getFileDownloadUrl(path: string): string | null;
  getFsHome(): Promise<{ home: string; recentRoots: string[] }>;
  readHostFileContent(path: string): Promise<FileData>;
  readFileContent(path: string): Promise<FileData | null>;
  readWorkspaceFileBlob(path: string, opts?: { prefixBytes?: number }): Promise<Blob | null>;
  openWorkspaceFile(path: string, line?: number): Promise<boolean>;
  revealWorkspaceFile(path: string): Promise<boolean>;
}

const FS_PATH_NOT_FOUND = 40409;
const FS_TOO_LARGE = 41302;
const FS_TOO_LARGE_SIZE_PATTERN = /\((\d+) bytes >/;

function isNotFoundError(err: unknown): boolean {
  return isDaemonApiError(err) && err.code === FS_PATH_NOT_FOUND;
}

function isFsTooLargeError(err: unknown): boolean {
  return (isDaemonApiError(err) && err.code === FS_TOO_LARGE) || isFileTooLargeError(err);
}

function fsTooLargeTotalSize(err: unknown): number | undefined {
  if (!isDaemonApiError(err)) return undefined;
  const match = FS_TOO_LARGE_SIZE_PATTERN.exec(err.message);
  if (match === null) return undefined;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) ? size : undefined;
}

const MEDIA_PREVIEW_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

function mediaMimeForPath(path: string): string | undefined {
  const match = /\.[^./\\]+$/.exec(path);
  if (match === null) return undefined;
  return MEDIA_PREVIEW_MIME[match[0].toLowerCase()];
}

function looksBinary(sample: Uint8Array): boolean {
  return sample.includes(0);
}

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

export interface UseFilePreviewOptions {
  client: FilePreviewClient;
  t: Translator;
  root?: Ref<string | undefined>;
}

export function useFilePreview({ client, t, root }: UseFilePreviewOptions) {

  const previewTarget = ref<FilePreviewRequest | null>(null);
  const previewFile = ref<FileData | null>(null);
  const previewLoading = ref(false);
  const previewError = ref<string | null>(null);
  const previewNormalizedPath = ref<string | null>(null);
  const previewLoadedSeq = ref(0);
  const previewLoadStartedSeq = ref(0);
  const previewRefreshing = ref(false);
  const previewRoot = ref('');
  let previewRequestSeq = 0;

  const previewMediaUrl = ref<string | null>(null);
  let previewObjectUrl: string | null = null;

  function setMediaBlob(blob: Blob | null): void {
    if (previewObjectUrl !== null) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }
    if (blob !== null && typeof URL.createObjectURL === 'function') {
      previewObjectUrl = URL.createObjectURL(blob);
    }
    previewMediaUrl.value = previewObjectUrl;
  }

  if (getCurrentScope() !== undefined) {
    onScopeDispose(() => {
      previewRequestSeq += 1;
      setMediaBlob(null);
    });
  }

  const previewDownloadUrl = computed(() => {
    const path = previewNormalizedPath.value;
    return path ? client.getFileDownloadUrl(toClientPath(path)) : null;
  });
  const previewExternalActions = computed(
    () => previewTarget.value !== null && previewNormalizedPath.value !== null,
  );

  function trimTrailingSlash(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
  }

  function currentRoot(): string {
    return previewRoot.value || client.status.value.cwd;
  }

  function toClientPath(path: string): string {
    const root = currentRoot();
    if (!root || root === client.status.value.cwd || isAbsoluteLocalPath(path)) return path;
    return `${trimTrailingSlash(root)}/${path}`;
  }

  function workspaceRelativePath(absPath: string): string | null {
    const relative = pathRelativeTo(absPath, currentRoot());
    if (relative === null || relative.split(/[\\/]+/).includes('..')) return null;
    const rel = normalizeRelativePath(relative);
    return rel || null;
  }

  const previewAbsolutePath = computed(() => {
    const target = previewTarget.value;
    if (!target) return null;
    const normalized = previewNormalizedPath.value;
    if (normalized === null) return target.path;
    const cwd = currentRoot();
    return cwd ? resolveLocalPath(cwd, normalized) : normalized;
  });

  function normalizePreviewPath(inputPath: string): { path: string } | { error: string } {
    const raw = inputPath.trim();
    if (!raw) return { error: t('filePreview.errors.emptyPath') };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      return { error: t('filePreview.errors.unsupportedPath') };
    }
    if (raw.startsWith('~')) {
      return { error: t('filePreview.errors.outsideWorkspace') };
    }

    const cwd = trimTrailingSlash(currentRoot());
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

  async function openFilePreview(
    target: FilePreviewRequest,
    opts?: { preserveCurrent?: boolean },
  ): Promise<void> {
    const requestSeq = ++previewRequestSeq;
    const preserve = opts?.preserveCurrent === true && previewFile.value !== null;
    if (!preserve) previewRoot.value = root?.value ?? client.status.value.cwd;
    if (preserve) {
      previewRefreshing.value = true;
    } else {
      previewFile.value = null;
      previewError.value = null;
      previewLoading.value = true;
      previewRefreshing.value = false;
      setMediaBlob(null);
    }
    previewTarget.value = target;
    if (!preserve) previewNormalizedPath.value = null;

    if (typeof target.content === 'string') {
      previewLoading.value = false;
      previewRefreshing.value = false;
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

    previewLoadStartedSeq.value += 1;

    if (target.path === '~' || target.path.startsWith('~/')) {
      const { home } = await client.getFsHome();
      if (requestSeq !== previewRequestSeq) return;
      if (home) target = { ...target, path: expandWorkspacePathTilde(target.path, home) };
    }

    if (!isAbsoluteLocalPath(target.path) && target.path.split(/[\\/]+/).includes('..')) {
      const cwd = trimTrailingSlash(currentRoot());
      if (cwd) target = { ...target, path: normalizeAbsolutePath(`${cwd}/${target.path}`) };
    }

    if (isAbsoluteLocalPath(target.path)) {
      target = { ...target, path: normalizeAbsolutePath(target.path) };
      previewTarget.value = target;
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
          previewLoadedSeq.value += 1;
        } catch (err) {
          if (requestSeq !== previewRequestSeq) return;
          if (!preserve) {
            previewError.value = isNotFoundError(err)
              ? t('filePreview.errors.notFound')
              : isFileTooLargeError(err)
                ? t('filePreview.errors.tooLarge')
                : err instanceof Error
                  ? err.message
                  : t('filePreview.errors.loadFailed');
          }
        } finally {
          if (requestSeq === previewRequestSeq) settleLoadingState(preserve);
        }
        return;
      }
    }

    const normalized = normalizePreviewPath(target.path);
    if ('error' in normalized) {
      previewLoading.value = false;
      previewRefreshing.value = false;
      previewError.value = normalized.error;
      return;
    }
    previewNormalizedPath.value = normalized.path;

    const mediaMime = mediaMimeForPath(normalized.path);
    if (mediaMime !== undefined) {
      await openStreamedMediaPreview(normalized.path, mediaMime, requestSeq, preserve);
      return;
    }

    try {
      const result = await client.readFileContent(toClientPath(normalized.path));
      if (requestSeq !== previewRequestSeq) return;
      if (result) {
        previewFile.value = { ...result, path: result.path || normalized.path };
        previewLoadedSeq.value += 1;
      } else if (!preserve) {
        previewError.value = t('filePreview.errors.loadFailed');
      }
    } catch (err) {
      if (requestSeq !== previewRequestSeq) return;
      if (isFsTooLargeError(err)) {
        await openTruncatedTextPreview(normalized.path, requestSeq, preserve, fsTooLargeTotalSize(err));
      } else if (!preserve) {
        if (isNotFoundError(err)) {
          previewError.value = workspaceNotFoundMessage(normalized.path);
        } else {
          previewError.value = err instanceof Error ? err.message : t('filePreview.errors.loadFailed');
        }
      }
    } finally {
      if (requestSeq === previewRequestSeq) {
        settleLoadingState(preserve);
      }
    }
  }

  function workspaceNotFoundMessage(path: string): string {
    const cwd = trimTrailingSlash(currentRoot());
    return cwd
      ? t('filePreview.errors.notFoundInWorkspace', { path: `${cwd}/${path}` })
      : t('filePreview.errors.notFound');
  }

  async function openStreamedMediaPreview(
    path: string,
    mime: string,
    requestSeq: number,
    preserve: boolean,
  ): Promise<void> {
    try {
      const blob = await client.readWorkspaceFileBlob(toClientPath(path));
      if (requestSeq !== previewRequestSeq) return;
      if (blob) {
        setMediaBlob(blob);
        previewFile.value = {
          path,
          content: '',
          encoding: 'base64',
          mime,
          isBinary: true,
          size: blob.size,
        };
        previewLoadedSeq.value += 1;
      } else if (!preserve) {
        previewError.value = t('filePreview.errors.loadFailed');
      }
    } catch (err) {
      if (requestSeq !== previewRequestSeq) return;
      if (!preserve) {
        previewError.value = isNotFoundError(err)
          ? workspaceNotFoundMessage(path)
          : t('filePreview.errors.loadFailed');
      }
    } finally {
      if (requestSeq === previewRequestSeq) {
        settleLoadingState(preserve);
      }
    }
  }

  async function openTruncatedTextPreview(
    path: string,
    requestSeq: number,
    preserve: boolean,
    totalSize?: number,
  ): Promise<void> {
    try {
      const blob = await client.readWorkspaceFileBlob(toClientPath(path), { prefixBytes: FILE_PREVIEW_MAX_BYTES });
      if (requestSeq !== previewRequestSeq) return;
      if (!blob) {
        if (!preserve) previewError.value = t('filePreview.errors.tooLarge');
        return;
      }
      const sample = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
      if (requestSeq !== previewRequestSeq) return;
      if (blob.type === 'application/octet-stream' || looksBinary(sample)) {
        if (!preserve) previewError.value = t('filePreview.errors.tooLarge');
        return;
      }
      const head = await blob.slice(0, FILE_PREVIEW_MAX_BYTES).text();
      if (requestSeq !== previewRequestSeq) return;
      previewFile.value = {
        path,
        content: head,
        encoding: 'utf-8',
        mime: 'text/plain',
        isBinary: false,
        size: totalSize ?? blob.size,
        truncated: true,
      };
      previewLoadedSeq.value += 1;
    } catch (err) {
      if (requestSeq !== previewRequestSeq) return;
      if (!preserve) {
        previewError.value = isNotFoundError(err)
          ? workspaceNotFoundMessage(path)
          : t('filePreview.errors.tooLarge');
      }
    }
  }

  function settleLoadingState(preserve: boolean): void {
    if (preserve) previewRefreshing.value = false;
    else previewLoading.value = false;
  }

  function resetFilePreview(): void {
    previewRequestSeq += 1;
    previewTarget.value = null;
    previewNormalizedPath.value = null;
    previewFile.value = null;
    previewError.value = null;
    previewLoading.value = false;
    previewRefreshing.value = false;
    setMediaBlob(null);
  }

  function closeFilePreview(): void {
    resetFilePreview();
  }

  function refreshFilePreview(): void {
    const target = previewTarget.value;
    if (!target || previewRefreshing.value) return;
    void openFilePreview(target, { preserveCurrent: true });
  }

  function openPreviewInEditor(): void {
    const path = previewFile.value?.path ?? previewTarget.value?.path;
    if (!path) return;
    void client.openWorkspaceFile(toClientPath(path), previewTarget.value?.line);
  }

  function revealPreviewFile(): void {
    const path = previewFile.value?.path ?? previewTarget.value?.path;
    if (!path) return;
    void client.revealWorkspaceFile(toClientPath(path));
  }

  return {
    previewTarget,
    previewFile,
    previewLoading,
    previewError,
    previewNormalizedPath,
    previewLoadedSeq,
    previewLoadStartedSeq,
    previewRefreshing,
    previewDownloadUrl,
    previewExternalActions,
    previewAbsolutePath,
    previewMediaUrl,
    openFilePreview,
    closeFilePreview,
    refreshFilePreview,
    openPreviewInEditor,
    revealPreviewFile,
  };
}
