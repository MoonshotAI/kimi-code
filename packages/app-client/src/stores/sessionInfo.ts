import { ref } from 'vue';
import { defineStore } from 'pinia';

import {
  FS_DIRECTORY_NOT_FOUND_CODE,
  FS_GIT_UNAVAILABLE_CODE,
  isDaemonApiError,
  type GitBatchError,
  type GitStatusEntry,
  type PullRequestBatchResult,
  type ReadRequestOptions,
  type SessionContextSummary,
} from '@moonshot-ai/app-core/api';
import { workspaceFolders, type WorkspaceFolder } from '@moonshot-ai/app-core/client';
import { isWorktreeSession, sessionDirectoryRoots } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
import { sessionsStore } from './sessions';
import { workspacesStore } from './workspaces';
import { clientPinia } from './pinia';

export type SessionFolderGitState =
  | { status: 'loading' }
  | { status: 'ready'; value: GitStatusEntry }
  | { status: 'non-git' }
  | { status: 'missing' }
  | { status: 'error'; output?: string };

export interface SessionFolderInfoRow extends WorkspaceFolder {
  state: SessionFolderGitState;
  statusLoading?: boolean;
  pullRequestLoading?: boolean;
}

export interface SessionInfoRefreshError {
  output: string;
}

function errorOutput(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export type SessionContextInfoState =
  | { status: 'loading'; value?: SessionContextSummary }
  | { status: 'ready'; value: SessionContextSummary }
  | { status: 'error'; message: string; value?: SessionContextSummary };

export const useSessionInfoStore = defineStore('kimi.sessionInfo', () => {
  const observedBySession = ref<Record<string, readonly WorkspaceFolder[]>>({});
  const foldersBySession = ref<Record<string, readonly WorkspaceFolder[]>>({});
  const stateBySession = ref<Record<string, Record<string, SessionFolderGitState>>>({});
  const pullRequestLoadingBySession = ref<Record<string, Record<string, boolean>>>({});
  const refreshingBySession = ref<Record<string, boolean>>({});
  const statusLoadingBySession = ref<Record<string, boolean>>({});
  const statusRequestBySession = new Map<string, symbol>();
  const refreshErrorBySession = ref<Record<string, SessionInfoRefreshError>>({});
  const observedContextBySession = ref<Record<string, true>>({});
  const contextBySession = ref<Record<string, SessionContextInfoState>>({});
  const generationBySession = new Map<string, number>();
  const inFlightBySession = new Map<string, Promise<void>>();
  const queuedRefreshBySession = new Map<string, Promise<void>>();
  const contextGenerationBySession = new Map<string, number>();
  const contextInFlightBySession = new Map<string, Promise<void>>();
  const contextQueuedRefreshBySession = new Map<string, Promise<void>>();

  function foldersForSession(sessionId: string): WorkspaceFolder[] {
    const session = sessionsStore().sessions.find((item) => item.id === sessionId);
    if (!session) return [];
    const workspaceId = workspacesStore().workspaceIdForSession(session);
    const workspace = workspacesStore().mergedWorkspaces.find((item) => item.id === workspaceId);
    const [root = '', ...additionalDirs] = sessionDirectoryRoots(session, workspace);
    return workspaceFolders({ root, additionalDirs });
  }

  function rows(sessionId: string): SessionFolderInfoRow[] {
    const folders = observedBySession.value[sessionId] ?? foldersBySession.value[sessionId];
    if (!folders) return [];
    return folders.map((folder) => ({
      ...folder,
      state: stateBySession.value[sessionId]?.[folder.path] ?? { status: 'loading' },
      statusLoading: statusLoadingBySession.value[sessionId] === true,
      pullRequestLoading: pullRequestLoadingBySession.value[sessionId]?.[folder.path] === true,
    }));
  }

  function refreshing(sessionId: string): boolean {
    return refreshingBySession.value[sessionId] === true;
  }

  function refreshError(sessionId: string): SessionInfoRefreshError | null {
    return refreshErrorBySession.value[sessionId] ?? null;
  }

  function signature(folders: readonly WorkspaceFolder[]): string {
    return JSON.stringify(folders.map((folder) => [folder.path, folder.primary]));
  }

  function setState(sessionId: string, path: string, state: SessionFolderGitState): void {
    stateBySession.value[sessionId] = { ...stateBySession.value[sessionId], [path]: state };
  }

  function setPullRequestLoading(sessionId: string, paths: readonly string[], loading: boolean): void {
    const next = { ...pullRequestLoadingBySession.value[sessionId] };
    for (const path of paths) {
      if (loading) next[path] = true;
      else delete next[path];
    }
    pullRequestLoadingBySession.value[sessionId] = next;
  }

  function setRefreshError(sessionId: string, output: string | null): void {
    if (output === null) delete refreshErrorBySession.value[sessionId];
    else refreshErrorBySession.value[sessionId] = { output };
  }

  function setLoadError(sessionId: string, path: string, error: { code?: number; output: string }): boolean {
    if (error.code === FS_GIT_UNAVAILABLE_CODE) {
      setState(sessionId, path, { status: 'non-git' });
      return false;
    }
    if (error.code === FS_DIRECTORY_NOT_FOUND_CODE) {
      setState(sessionId, path, { status: 'missing' });
      return false;
    }
    const current = stateBySession.value[sessionId]?.[path];
    if (current?.status === 'ready') return true;
    setState(sessionId, path, { status: 'error', output: error.output });
    return false;
  }

  function syncWorktreeMissing(sessionId: string, folders: readonly WorkspaceFolder[]): void {
    const primary = folders.find((folder) => folder.primary);
    if (primary === undefined) return;
    const session = sessionsStore().sessions.find((item) => item.id === sessionId);
    if (session === undefined || !isWorktreeSession(session) || session.cwd !== primary.path) return;
    const status = stateBySession.value[sessionId]?.[primary.path]?.status;
    const missing = status === 'missing';
    if (status !== 'missing' && status !== 'ready' && status !== 'non-git') return;
    if ((session.worktree?.missing === true) === missing) return;
    sessionsStore().updateSession(sessionId, (current) =>
      current.worktree === undefined ? current : { ...current, worktree: { ...current.worktree, missing } },
    );
  }

  function isCurrent(sessionId: string, generation: number, path: string, options?: ReadRequestOptions): boolean {
    return generationBySession.get(sessionId) === generation &&
      foldersBySession.value[sessionId]?.some((folder) => folder.path === path) === true &&
      options?.signal?.aborted !== true;
  }

  function applyPullRequests(
    sessionId: string,
    generation: number,
    roots: readonly string[],
    result: PullRequestBatchResult | { failure: string },
    options?: ReadRequestOptions,
  ): void {
    for (const root of roots) {
      const current = stateBySession.value[sessionId]?.[root];
      if (!isCurrent(sessionId, generation, root, options) || current?.status !== 'ready') continue;
      const { pullRequestStatus: _status, pullRequestError: _error, ...rest } = current.value;
      if ('failure' in result) {
        setState(sessionId, root, {
          status: 'ready',
          value: { ...rest, pullRequestStatus: 'failed', pullRequestError: result.failure },
        });
        continue;
      }
      const rootError: GitBatchError | undefined = result.errors[root];
      if (rootError !== undefined) {
        setState(sessionId, root, {
          status: 'ready',
          value: { ...rest, pullRequestStatus: 'failed', pullRequestError: rootError.msg },
        });
        continue;
      }
      if (!Object.hasOwn(result.results, root)) continue;
      const reported = result.statuses[root];
      const value: GitStatusEntry = { ...rest, pullRequest: result.results[root] ?? null };
      if (reported?.status !== undefined) value.pullRequestStatus = reported.status;
      if (reported?.error !== undefined) value.pullRequestError = reported.error;
      if (reported?.status === 'failed' && value.pullRequest === null) value.pullRequest = current.value.pullRequest;
      setState(sessionId, root, { status: 'ready', value });
    }
  }

  function load(sessionId: string, generation: number, options?: ReadRequestOptions): Promise<void> {
    const folders = foldersBySession.value[sessionId] ?? [];
    refreshingBySession.value[sessionId] = true;
    const promise = (async () => {
      if (folders.length === 0) return;
      const api = getKimiWebApi();
      const roots = folders.map(folder => folder.path);
      try {
        const request = Symbol('status');
        statusRequestBySession.set(sessionId, request);
        statusLoadingBySession.value[sessionId] = true;
        const batch = await api
          .getGitStatusBatch(sessionId, { roots, includePullRequest: false, includeUntracked: true }, options)
          .finally(() => {
            if (statusRequestBySession.get(sessionId) !== request) return;
            statusRequestBySession.delete(sessionId);
            delete statusLoadingBySession.value[sessionId];
          });
        let staleOutput: string | null = null;
        for (const folder of folders) {
          if (!isCurrent(sessionId, generation, folder.path, options)) return;
          const value = batch.results[folder.path];
          if (value !== undefined) {
            const previous = stateBySession.value[sessionId]?.[folder.path];
            const { pullRequestStatus: _status, pullRequestError: _error, ...status } = value;
            const next: GitStatusEntry = previous?.status === 'ready'
              ? { ...status, pullRequest: previous.value.pullRequest }
              : status;
            if (previous?.status === 'ready') {
              if (previous.value.pullRequestStatus !== undefined) next.pullRequestStatus = previous.value.pullRequestStatus;
              if (previous.value.pullRequestError !== undefined) next.pullRequestError = previous.value.pullRequestError;
            }
            setState(sessionId, folder.path, { status: 'ready', value: next });
          } else {
            const rootError = batch.errors[folder.path];
            const kept = setLoadError(sessionId, folder.path, {
              code: rootError?.code,
              output: rootError?.msg ?? '',
            });
            if (kept) staleOutput = rootError?.msg ?? '';
          }
        }
        setRefreshError(sessionId, staleOutput);
        syncWorktreeMissing(sessionId, folders);
        const prRoots = roots.filter(root => batch.results[root] !== undefined);
        setPullRequestLoading(
          sessionId,
          roots.filter((root) => !prRoots.includes(root)),
          false,
        );
        if (prRoots.length === 0) return;
        let pullRequests: PullRequestBatchResult | { failure: string };
        try {
          pullRequests = await api.getPullRequestBatch(sessionId, { roots: prRoots }, options);
        } catch (error) {
          if (isAbort(error)) return;
          pullRequests = { failure: errorOutput(error) };
        }
        applyPullRequests(sessionId, generation, prRoots, pullRequests, options);
        if (generationBySession.get(sessionId) === generation) setPullRequestLoading(sessionId, prRoots, false);
      } catch (error) {
        if (isAbort(error)) return;
        const output = errorOutput(error);
        const code = isDaemonApiError(error) ? error.code : undefined;
        let stale = false;
        for (const folder of folders) {
          if (!isCurrent(sessionId, generation, folder.path, options)) return;
          if (setLoadError(sessionId, folder.path, { code, output })) stale = true;
        }
        setRefreshError(sessionId, stale ? output : null);
        setPullRequestLoading(sessionId, roots, false);
        syncWorktreeMissing(sessionId, folders);
      }
    })().finally(() => {
      if (inFlightBySession.get(sessionId) === promise) {
        inFlightBySession.delete(sessionId);
        delete refreshingBySession.value[sessionId];
      }
    });
    inFlightBySession.set(sessionId, promise);
    return promise;
  }

  function adoptFolders(sessionId: string, folders: readonly WorkspaceFolder[]): void {
    const nextSignature = signature(folders);
    const previousFolders = foldersBySession.value[sessionId];
    foldersBySession.value[sessionId] = folders.map((folder) => ({ ...folder }));
    if (previousFolders === undefined || signature(previousFolders) !== nextSignature) {
      stateBySession.value[sessionId] = {};
      pullRequestLoadingBySession.value[sessionId] = {};
      setRefreshError(sessionId, null);
    }
    const pendingPullRequests: string[] = [];
    for (const folder of folders) {
      if (stateBySession.value[sessionId]?.[folder.path] === undefined) {
        setState(sessionId, folder.path, { status: 'loading' });
        pendingPullRequests.push(folder.path);
      }
    }
    setPullRequestLoading(sessionId, pendingPullRequests, true);
  }

  function nextGeneration(sessionId: string): number {
    const generation = (generationBySession.get(sessionId) ?? 0) + 1;
    generationBySession.set(sessionId, generation);
    return generation;
  }

  function observe(sessionId: string, folders: readonly WorkspaceFolder[]): Promise<void> {
    if (folders.length === 0) {
      unobserve(sessionId);
      return Promise.resolve();
    }
    for (const observedId of Object.keys(observedBySession.value)) {
      if (observedId !== sessionId) unobserve(observedId);
    }
    const nextSignature = signature(folders);
    if (observedBySession.value[sessionId] !== undefined && signature(observedBySession.value[sessionId]) === nextSignature) {
      return inFlightBySession.get(sessionId) ?? Promise.resolve();
    }
    adoptFolders(sessionId, folders);
    observedBySession.value[sessionId] = foldersBySession.value[sessionId]!;
    return load(sessionId, nextGeneration(sessionId));
  }

  function reload(sessionId: string, options?: ReadRequestOptions): Promise<void> {
    const queued = queuedRefreshBySession.get(sessionId);
    if (queued) return queued;
    const existing = inFlightBySession.get(sessionId);
    if (existing) {
      const pending = existing.finally(() => {
        queuedRefreshBySession.delete(sessionId);
        if (!foldersBySession.value[sessionId]) return;
        return load(sessionId, nextGeneration(sessionId), options);
      });
      queuedRefreshBySession.set(sessionId, pending);
      return pending;
    }
    return load(sessionId, nextGeneration(sessionId), options);
  }

  function refresh(sessionId: string, options?: ReadRequestOptions): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (observedContextBySession.value[sessionId]) tasks.push(refreshContext(sessionId, options));
    if (observedBySession.value[sessionId]) tasks.push(reload(sessionId, options));
    return Promise.all(tasks).then(() => undefined);
  }

  function refreshNow(sessionId: string, options?: ReadRequestOptions): Promise<void> {
    if (observedBySession.value[sessionId]) return reload(sessionId, options);
    const folders = foldersForSession(sessionId);
    if (folders.length === 0) return Promise.resolve();
    adoptFolders(sessionId, folders);
    return reload(sessionId, options);
  }

  function contextState(sessionId: string): SessionContextInfoState | undefined {
    return contextBySession.value[sessionId];
  }

  function existingContextValue(sessionId: string): SessionContextSummary | undefined {
    return contextBySession.value[sessionId]?.value;
  }

  function isContextCurrent(sessionId: string, generation: number, options?: ReadRequestOptions): boolean {
    return contextGenerationBySession.get(sessionId) === generation &&
      observedContextBySession.value[sessionId] === true &&
      options?.signal?.aborted !== true;
  }

  function loadContext(sessionId: string, generation: number, options?: ReadRequestOptions): Promise<void> {
    const promise = (async () => {
      if (!sessionId) return;
      let getSummary: KimiContextSummaryGetter | undefined;
      try {
        const api = getKimiWebApi() as { getSessionContextSummary?: KimiContextSummaryGetter };
        if (typeof api.getSessionContextSummary === 'function') {
          getSummary = api.getSessionContextSummary.bind(api);
        }
      } catch {
        return;
      }
      if (!getSummary) return;
      try {
        const value = await getSummary(sessionId, undefined, {
          ...options,
          background: options?.background ?? true,
        });
        if (!isContextCurrent(sessionId, generation, options)) return;
        contextBySession.value[sessionId] = { status: 'ready', value };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (!isContextCurrent(sessionId, generation, options)) return;
        contextBySession.value[sessionId] = {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          value: existingContextValue(sessionId),
        };
      }
    })().finally(() => {
      if (contextInFlightBySession.get(sessionId) === promise) contextInFlightBySession.delete(sessionId);
    });
    contextInFlightBySession.set(sessionId, promise);
    return promise;
  }

  function observeContext(sessionId: string, options?: ReadRequestOptions): Promise<void> {
    if (!sessionId) return Promise.resolve();
    for (const observedId of Object.keys(observedContextBySession.value)) {
      if (observedId !== sessionId) unobserveContext(observedId);
    }
    if (observedContextBySession.value[sessionId]) {
      return contextInFlightBySession.get(sessionId) ?? Promise.resolve();
    }
    observedContextBySession.value[sessionId] = true;
    const previous = existingContextValue(sessionId);
    contextBySession.value[sessionId] = previous !== undefined
      ? { status: 'loading', value: previous }
      : { status: 'loading' };
    const generation = (contextGenerationBySession.get(sessionId) ?? 0) + 1;
    contextGenerationBySession.set(sessionId, generation);
    return loadContext(sessionId, generation, options);
  }

  function refreshContext(sessionId: string, options?: ReadRequestOptions): Promise<void> {
    if (!observedContextBySession.value[sessionId]) return Promise.resolve();
    const queued = contextQueuedRefreshBySession.get(sessionId);
    if (queued) return queued;
    const existing = contextInFlightBySession.get(sessionId);
    if (!existing) return reloadContext(sessionId, options);
    const reloadQueued = (): Promise<void> => {
      contextQueuedRefreshBySession.delete(sessionId);
      return reloadContext(sessionId, options);
    };
    const pending = existing.then(reloadQueued, reloadQueued);
    contextQueuedRefreshBySession.set(sessionId, pending);
    return pending;
  }

  function reloadContext(sessionId: string, options?: ReadRequestOptions): Promise<void> {
    if (!observedContextBySession.value[sessionId]) return Promise.resolve();
    const previous = existingContextValue(sessionId);
    if (previous !== undefined) {
      contextBySession.value[sessionId] = { status: 'loading', value: previous };
    }
    const generation = (contextGenerationBySession.get(sessionId) ?? 0) + 1;
    contextGenerationBySession.set(sessionId, generation);
    return loadContext(sessionId, generation, options);
  }

  function unobserveContext(sessionId: string): void {
    delete observedContextBySession.value[sessionId];
    contextGenerationBySession.set(sessionId, (contextGenerationBySession.get(sessionId) ?? 0) + 1);
    contextInFlightBySession.delete(sessionId);
  }

  function unobserve(sessionId: string): void {
    delete observedBySession.value[sessionId];
    generationBySession.set(sessionId, (generationBySession.get(sessionId) ?? 0) + 1);
    inFlightBySession.delete(sessionId);
    delete refreshingBySession.value[sessionId];
    statusRequestBySession.delete(sessionId);
    delete statusLoadingBySession.value[sessionId];
  }

  function discard(sessionId: string): void {
    unobserve(sessionId);
    unobserveContext(sessionId);
    delete foldersBySession.value[sessionId];
    delete stateBySession.value[sessionId];
    delete pullRequestLoadingBySession.value[sessionId];
    delete refreshErrorBySession.value[sessionId];
    delete contextBySession.value[sessionId];
  }

  return {
    foldersForSession,
    rows,
    refreshing,
    refreshError,
    contextState,
    observe,
    observeContext,
    refresh,
    refreshNow,
    refreshContext,
    unobserve,
    unobserveContext,
    discard,
  };
});

type KimiContextSummaryGetter = (
  sessionId: string,
  agentId?: string,
  options?: ReadRequestOptions,
) => Promise<SessionContextSummary>;

export function sessionInfoStore() {
  return useSessionInfoStore(clientPinia);
}
