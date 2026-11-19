
import { ref } from 'vue';
import { defineStore } from 'pinia';
import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import type { AppSession, FsEntry, ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { isAbsoluteLocalPath, logWarn, pathRelativeTo, resolveLocalPath } from '@moonshot-ai/app-core/lib';
import { parseDiff, type DiffViewLine } from '@moonshot-ai/app-core/client';
import { buildFullDiffTexts, type DiffFullTexts } from '@moonshot-ai/app-core/client';
import type { FilePreviewRequest } from '@moonshot-ai/app-core/client';
import { getDeviceApi, getKimiWebApi } from '../client/deps';
import type { GitStatusEntry } from '../client/types';
import type { FileSearch } from '../composables/useMentionMenu';
import { track } from '../contracts';
import { sessionsStore } from './sessions';
import { workspacesStore } from './workspaces';
import { clientPinia } from './pinia';

const FS_PATH_NOT_FOUND_CODE = 40409;
const FS_TOO_LARGE_CODE = 41302;
const IMAGE_READ_MAX_BYTES = 10_485_760;
const WORKSPACE_READ_MAX_BYTES = 10_485_760;

export interface FilesHooks {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
}

let filesHooks: FilesHooks | null = null;

export function setFilesHooks(next: FilesHooks | null): void {
  filesHooks = next;
}

export interface FileTreeWorkspaceScope {
  workspaceId?: string;
  root: string;
}

export interface FileTreeSessionState {
  children: Record<string, FsEntry[]>;
  loading: Record<string, boolean>;
  expanded: Record<string, boolean>;
  failed: Record<string, boolean>;
}

function emptyFileTreeSessionState(): FileTreeSessionState {
  return {
    children: Object.create(null) as Record<string, FsEntry[]>,
    loading: Object.create(null) as Record<string, boolean>,
    expanded: Object.create(null) as Record<string, boolean>,
    failed: Object.create(null) as Record<string, boolean>,
  };
}

function toSessionPullRequest(
  pr: { number: number; state: string; url: string } | null,
): AppSession['pullRequest'] {
  if (!pr) return null;
  if (pr.state !== 'open' && pr.state !== 'closed' && pr.state !== 'merged') return null;
  return { number: pr.number, state: pr.state, url: pr.url };
}

function samePullRequest(a: AppSession['pullRequest'], b: AppSession['pullRequest']): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.number === b.number && a.state === b.state && a.url === b.url;
}

export const useFilesStore = defineStore('kimi.files', () => {
  const selectedDiffPath = ref<string | null>(null);
  const fileDiffLines = ref<DiffViewLine[]>([]);
  const fileDiffLoading = ref(false);
  const fileDiffTexts = ref<DiffFullTexts | null>(null);
  const fileDiffEmptyFile = ref(false);
  const fileDiffLoadedSeq = ref(0);
  const fileDiffLoadedKey = ref<string | null>(null);
  const fileDiffLoadStartedSeq = ref(0);
  const fileDiffRefreshing = ref(false);
  let fileDiffRequestSeq = 0;
  const selectedDiffRoot = ref<string | undefined>();

  const gitStatusBySession = ref<Record<string, GitStatusEntry>>({});
  const gitStatusBySessionRoot = ref<Record<string, Record<string, GitStatusEntry>>>({});
  const gitStatusRequestSeqBySessionRoot = new Map<string, number>();

  async function readFileContent(path: string): Promise<{
    path: string;
    content: string;
    encoding: 'utf-8' | 'base64';
    mime: string;
    languageId?: string;
    isBinary: boolean;
    size: number;
    lineCount?: number;
    truncated: boolean;
  } | null> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return null;
    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, {
        path,
        length: WORKSPACE_READ_MAX_BYTES,
        allowExternalSymlinks: true,
      });
      return {
        path: result.path,
        content: result.content,
        encoding: result.encoding,
        mime: result.mime,
        languageId: result.languageId,
        isBinary: result.isBinary,
        size: result.size,
        lineCount: result.lineCount,
        truncated: result.truncated,
      };
    } catch (err) {
      logWarn('[kimi-code] readFileContent failed for', path, err);
      if (
        isDaemonApiError(err) &&
        (err.code === FS_PATH_NOT_FOUND_CODE || err.code === FS_TOO_LARGE_CODE)
      ) {
        throw err;
      }
      return null;
    }
  }

  async function readWorkspaceFileBlob(path: string, opts?: { prefixBytes?: number }): Promise<Blob | null> {
    const sid = sessionsStore().activeSessionId;
    if (sid) {
      return getKimiWebApi().downloadSessionFile(sid, path, {
        prefixBytes: opts?.prefixBytes,
        allowExternalSymlinks: true,
      });
    }
    const workspace = workspacesStore().visibleWorkspace;
    if (!workspace?.root) return null;
    const absolutePath = isAbsoluteLocalPath(path) ? path : `${workspace.root.replace(/[\\/]+$/, '')}/${path}`;
    return getDeviceApi(workspace.hostId).downloadHostFile(absolutePath, opts);
  }

  let fileDiffAbortController: AbortController | undefined;

  async function loadFileDiff(path: string, opts?: { preserveCurrent?: boolean; root?: string }): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    const root = opts?.root;
    const cacheKey = `${sid}:${root ?? ''}:${path}`;
    const requestSeq = ++fileDiffRequestSeq;
    fileDiffAbortController?.abort();
    const controller = new AbortController();
    fileDiffAbortController = controller;
    fileDiffLoadStartedSeq.value += 1;
    const preserve =
      opts?.preserveCurrent === true && selectedDiffPath.value === path && selectedDiffRoot.value === root && fileDiffLoadedKey.value === cacheKey;
    selectedDiffPath.value = path;
    selectedDiffRoot.value = root;
    if (preserve) {
      fileDiffRefreshing.value = true;
    } else {
      fileDiffLines.value = [];
      fileDiffTexts.value = null;
      fileDiffEmptyFile.value = false;
      fileDiffLoading.value = true;
    }
    const isCurrent = (): boolean =>
      requestSeq === fileDiffRequestSeq && selectedDiffPath.value === path && selectedDiffRoot.value === root && sessionsStore().activeSessionId === sid;
    const readPath = root === undefined ? path : resolveLocalPath(root, path);
    try {
      const api = getKimiWebApi();
      const result = await api.getFileDiff(
        sid,
        path,
        root === undefined ? undefined : { root },
        { background: false, signal: controller.signal },
      );
      if (!isCurrent()) return;
      const rows = parseDiff(result.diff);
      if (rows.length === 0) {
        const file = await readFileContent(readPath).catch(() => null);
        if (!isCurrent()) return;
        fileDiffLines.value = rows;
        fileDiffEmptyFile.value = file !== null && file.size === 0;
        fileDiffLoadedSeq.value += 1;
        fileDiffLoadedKey.value = cacheKey;
        return;
      }
      if (!preserve) fileDiffLines.value = rows;
      const texts = await buildFullDiffTexts(rows, {
        truncated: result.truncated,
        readNewText: async () => {
          const file = await readFileContent(readPath).catch(() => null);
          if (!file || file.isBinary || file.encoding !== 'utf-8') return null;
          return file.content;
        },
      });
      if (!isCurrent()) return;
      fileDiffLines.value = rows;
      fileDiffTexts.value = texts;
      fileDiffLoadedSeq.value += 1;
      fileDiffLoadedKey.value = cacheKey;
    } catch (err) {
      if (requestSeq === fileDiffRequestSeq && selectedDiffPath.value === path && !preserve) fileDiffLines.value = [];
      logWarn('[loadFileDiff] diff unavailable for', path, err);
    } finally {
      if (requestSeq === fileDiffRequestSeq) {
        fileDiffLoading.value = false;
        fileDiffRefreshing.value = false;
      }
    }
  }

  function clearFileDiff(): void {
    fileDiffAbortController?.abort();
    fileDiffAbortController = undefined;
    selectedDiffPath.value = null;
    selectedDiffRoot.value = undefined;
    fileDiffLines.value = [];
    fileDiffTexts.value = null;
    fileDiffEmptyFile.value = false;
    fileDiffLoading.value = false;
    fileDiffRefreshing.value = false;
    fileDiffLoadedKey.value = null;
  }

  async function loadGitStatus(sessionId: string, options?: ReadRequestOptions & { root?: string }): Promise<void> {
    if (options?.signal?.aborted) return;
    const root = options?.root;
    const requestKey = root === undefined ? undefined : `${sessionId}\0${root}`;
    const requestSeq = requestKey === undefined ? 0 : (gitStatusRequestSeqBySessionRoot.get(requestKey) ?? 0) + 1;
    if (requestKey !== undefined) gitStatusRequestSeqBySessionRoot.set(requestKey, requestSeq);
    try {
      const api = getKimiWebApi();
      const result = await (options === undefined
        ? api.getGitStatus(sessionId)
        : options.root === undefined
          ? api.getGitStatus(sessionId, undefined, options)
          : api.getGitStatus(sessionId, { root: options.root }, options));
      if (options?.signal?.aborted) return;
      if (requestKey !== undefined && gitStatusRequestSeqBySessionRoot.get(requestKey) !== requestSeq) return;
      if (options?.root !== undefined) {
        gitStatusBySessionRoot.value[sessionId] = { ...gitStatusBySessionRoot.value[sessionId], [options.root]: result };
        return;
      }
      gitStatusBySession.value[sessionId] = result;
      const pr = toSessionPullRequest(result.pullRequest);
      sessionsStore().updateSession(sessionId, (s) =>
        samePullRequest(s.pullRequest, pr) ? s : { ...s, pullRequest: pr },
      );
    } catch {}
  }

  function gitStatusForRoot(sessionId: string, root: string): GitStatusEntry | undefined {
    return gitStatusBySessionRoot.value[sessionId]?.[root];
  }

  function clearSessionGitStatus(sid: string): void {
    delete gitStatusBySession.value[sid];
    delete gitStatusBySessionRoot.value[sid];
    for (const key of gitStatusRequestSeqBySessionRoot.keys()) {
      if (key.startsWith(`${sid}\0`)) gitStatusRequestSeqBySessionRoot.delete(key);
    }
  }

  const fileTreeBySession = ref<Record<string, FileTreeSessionState>>({});
  const fileTreeSeqs = new Map<string, number>();
  const fileTreeRootByWorkspace = ref<Record<string, string>>({});

  function resolveFileTreeRoot(workspaceId: string | null, roots: readonly string[], cwd: string): string {
    const remembered = workspaceId === null ? undefined : fileTreeRootByWorkspace.value[workspaceId];
    return remembered !== undefined && roots.includes(remembered) ? remembered : (roots[0] ?? cwd);
  }

  function selectFileTreeRoot(workspaceId: string | null, roots: readonly string[], root: string, cwd: string): void {
    if (workspaceId === null || root === resolveFileTreeRoot(workspaceId, roots, cwd) || !roots.includes(root)) return;
    fileTreeRootByWorkspace.value = { ...fileTreeRootByWorkspace.value, [workspaceId]: root };
    track('file_tree_root_switched', {});
  }

  function fileTreeState(sid: string): FileTreeSessionState {
    if (fileTreeBySession.value[sid] === undefined) {
      fileTreeBySession.value[sid] = emptyFileTreeSessionState();
    }
    return fileTreeBySession.value[sid]!;
  }

  async function loadFileTreeChildren(sessionId: string, path: string, workspace?: FileTreeWorkspaceScope): Promise<void> {
    const state = fileTreeState(sessionId);
    if (state.loading[path]) return;
    const key = `${sessionId}:${path}`;
    const seq = (fileTreeSeqs.get(key) ?? 0) + 1;
    fileTreeSeqs.set(key, seq);
    state.loading[path] = true;
    state.failed[path] = false;
    try {
      const api = getKimiWebApi();
      let items: FsEntry[];
      if (workspace === undefined) {
        const result = await api.listDirectory(sessionId, {
          path,
          showHidden: true,
          allowIgnoredGlobs: ['.tmp', '.tmp/**'],
          allowExternalSymlinks: true,
        });
        items = result.items;
      } else {
        const result = await api.listWorkspaceDirectory(workspace.workspaceId ?? workspace.root, {
          path,
          showHidden: true,
          allowIgnoredGlobs: ['.tmp', '.tmp/**'],
          allowExternalSymlinks: true,
        });
        items = result.items;
      }
      const current = fileTreeBySession.value[sessionId];
      if (fileTreeSeqs.get(key) !== seq || current === undefined) return;
      current.children[path] = items;
    } catch (err) {
      const current = fileTreeBySession.value[sessionId];
      if (fileTreeSeqs.get(key) !== seq || current === undefined) return;
      logWarn('[kimi-code] loadFileTreeChildren failed for', path, err);
      current.failed[path] = true;
    } finally {
      const current = fileTreeBySession.value[sessionId];
      if (fileTreeSeqs.get(key) === seq && current !== undefined) {
        current.loading[path] = false;
      }
    }
  }

  async function toggleFileTreeDir(sessionId: string, path: string, workspace?: FileTreeWorkspaceScope): Promise<void> {
    const state = fileTreeState(sessionId);
    if (state.expanded[path]) {
      delete state.expanded[path];
      return;
    }
    state.expanded[path] = true;
    if (state.children[path] === undefined) {
      await loadFileTreeChildren(sessionId, path, workspace);
    }
  }

  async function refreshFileTree(sessionId: string, workspace?: FileTreeWorkspaceScope): Promise<void> {
    const state = fileTreeBySession.value[sessionId];
    const paths = new Set<string>(['.']);
    if (state !== undefined) {
      for (const [path, on] of Object.entries(state.expanded)) {
        if (on) paths.add(path);
      }
      for (const path of Object.keys(state.children)) {
        if (!paths.has(path)) delete state.children[path];
      }
    }
    await Promise.all([...paths].map((path) => loadFileTreeChildren(sessionId, path, workspace)));
  }

  function clearSessionFileTree(sid: string): void {
    delete fileTreeBySession.value[sid];
    for (const key of [...fileTreeSeqs.keys()]) {
      if (key.startsWith(`${sid}:`)) fileTreeSeqs.delete(key);
    }
    delete filePreviewTargetBySession.value[sid];
  }

  const filePreviewTargetBySession = ref<Record<string, FilePreviewRequest | null>>({});

  function filePreviewTargetOf(sid: string): FilePreviewRequest | null {
    return filePreviewTargetBySession.value[sid] ?? null;
  }

  function setFilePreviewTarget(sid: string, target: FilePreviewRequest | null): void {
    filePreviewTargetBySession.value[sid] = target;
  }

  async function probeWorkspacePath(path: string, kind: 'file' | 'folder'): Promise<boolean> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) {
      let abs = path;
      if (!isAbsoluteLocalPath(path)) {
        const wid = workspacesStore().activeWorkspaceId;
        const root = wid ? workspacesStore().mergedWorkspaces.find((w) => w.id === wid)?.root : undefined;
        if (!root) return true;
        abs = `${root.replace(/[\\/]+$/, '')}/${path}`;
      }
      try {
        await readHostFileContent(abs);
        return true;
      } catch (err) {
        return !(isDaemonApiError(err) && err.code === FS_PATH_NOT_FOUND_CODE);
      }
    }
    try {
      if (isAbsoluteLocalPath(path)) {
        await readHostFileContent(path);
        return true;
      }
      const api = getKimiWebApi();
      if (kind === 'folder') {
        await api.listDirectory(sid, { path, allowExternalSymlinks: true });
      } else {
        await api.readFile(sid, { path, length: 1, allowExternalSymlinks: true });
      }
      return true;
    } catch (err) {
      return !(isDaemonApiError(err) && err.code === FS_PATH_NOT_FOUND_CODE);
    }
  }

  function workspaceMachineApi(workspaceId: string | null | undefined) {
    return getDeviceApi(workspaceId ? workspacesStore().workspaceById.get(workspaceId)?.hostId : undefined);
  }

  async function readHostFileContent(path: string) {
    return workspaceMachineApi(workspacesStore().activeWorkspaceId).readHostFileContent(path);
  }

  function getFileDownloadUrl(path: string): string | null {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return null;
    return getKimiWebApi().getFileDownloadUrl(sid, path, { allowExternalSymlinks: true });
  }

  async function openWorkspaceFile(path: string, line?: number): Promise<boolean> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().openFile(sid, { path, line });
      return true;
    } catch (err) {
      filesHooks?.pushOperationFailure('openFile', err, { sessionId: sid });
      return false;
    }
  }

  async function revealWorkspaceFile(path: string): Promise<boolean> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return false;
    try {
      await getKimiWebApi().revealFile(sid, { path });
      return true;
    } catch (err) {
      filesHooks?.pushOperationFailure('revealFile', err, { sessionId: sid });
      return false;
    }
  }

  async function resolveImageUrl(src: string): Promise<string> {
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    const sid = sessionsStore().activeSessionId;
    if (!sid) return src;

    let path = src;
    if (isAbsoluteLocalPath(path)) {
      const cwd = sessionsStore().sessions.find((s) => s.id === sid)?.cwd;
      const relative = cwd ? pathRelativeTo(path, cwd) : null;
      if (relative) {
        path = relative;
      } else {
        try {
          const result = await readHostFileContent(path);
          if (!result.isBinary || result.encoding !== 'base64') return src;
          return `data:${result.mime};base64,${result.content}`;
        } catch {
          return src;
        }
      }
    }

    try {
      const api = getKimiWebApi();
      const result = await api.readFile(sid, {
        path,
        length: IMAGE_READ_MAX_BYTES,
        allowExternalSymlinks: true,
      });
      if (!result.isBinary || result.encoding !== 'base64' || result.truncated) return src;
      return `data:${result.mime};base64,${result.content}`;
    } catch {
      return src;
    }
  }

  let suggestUnavailable = false;
  const searchFiles: FileSearch = async (query, options) => {
    const session = sessionsStore().sessions.find((s) => s.id === sessionsStore().activeSessionId);
    const root = options?.root;
    const workspaceId =
      session === undefined
        ? workspacesStore().activeWorkspaceId
        : workspacesStore().workspaceIdForSession(session);
    const ref = root ?? workspaceId;
    if (!ref) return [];
    try {
      const api = getKimiWebApi();
      if (root !== undefined) {
        const result = await workspaceMachineApi(workspaceId).suggestFilesAtRoots([root], { query, limit: 20 }, { signal: options?.signal });
        return result.items.map((item) => ({ path: item.path, name: item.name, kind: item.kind, matchPositions: item.matchPositions }));
      }
      if (!suggestUnavailable) {
        try {
          const result = await api.suggestFiles(ref, { query, limit: 20 }, { signal: options?.signal });
          return result.items.map((item) => ({ path: item.path, name: item.name, kind: item.kind, matchPositions: item.matchPositions }));
        } catch (err) {
          if (!isDaemonApiError(err) || err.code !== 404) throw err;
          suggestUnavailable = true;
        }
      }
      const result = await api.searchFiles(ref, { query, limit: 20 }, { signal: options?.signal });
      return result.items.map((item) => ({ path: item.path, name: item.name, kind: item.kind, matchPositions: item.matchPositions }));
    } catch {
      return [];
    }
  };

  function resetFilesSearch(): void {
    suggestUnavailable = false;
  }

  return {
    selectedDiffPath,
    selectedDiffRoot,
    fileDiffLines,
    fileDiffLoading,
    fileDiffTexts,
    fileDiffEmptyFile,
    fileDiffLoadedSeq,
    fileDiffLoadStartedSeq,
    fileDiffRefreshing,
    gitStatusBySession,
    gitStatusBySessionRoot,
    readFileContent,
    loadFileDiff,
    clearFileDiff,
    loadGitStatus,
    gitStatusForRoot,
    clearSessionGitStatus,
    fileTreeBySession,
    fileTreeRootByWorkspace,
    resolveFileTreeRoot,
    selectFileTreeRoot,
    loadFileTreeChildren,
    toggleFileTreeDir,
    refreshFileTree,
    clearSessionFileTree,
    filePreviewTargetOf,
    setFilePreviewTarget,
    probeWorkspacePath,
    readHostFileContent,
    readWorkspaceFileBlob,
    getFileDownloadUrl,
    openWorkspaceFile,
    revealWorkspaceFile,
    resolveImageUrl,
    searchFiles,
    resetFilesSearch,
  };
});

export function filesStore() {
  return useFilesStore(clientPinia);
}
