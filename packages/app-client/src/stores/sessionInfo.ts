import { ref } from 'vue';
import { defineStore } from 'pinia';

import {
  isDaemonApiError,
  type GitStatusEntry,
  type ReadRequestOptions,
  type SessionContextSummary,
} from '@moonshot-ai/app-core/api';
import { workspaceFolders, type WorkspaceFolder } from '@moonshot-ai/app-core/client';
import { getKimiWebApi } from '../client/deps';
import { sessionsStore } from './sessions';
import { workspacesStore } from './workspaces';
import { clientPinia } from './pinia';

const FS_GIT_UNAVAILABLE_CODE = 40908;

export type SessionFolderGitState =
  | { status: 'loading' }
  | { status: 'ready'; value: GitStatusEntry }
  | { status: 'non-git' }
  | { status: 'error' };

export interface SessionFolderInfoRow extends WorkspaceFolder {
  state: SessionFolderGitState;
}

export type SessionContextInfoState =
  | { status: 'loading'; value?: SessionContextSummary }
  | { status: 'ready'; value: SessionContextSummary }
  | { status: 'error'; message: string; value?: SessionContextSummary };

export const useSessionInfoStore = defineStore('kimi.sessionInfo', () => {
  const observedBySession = ref<Record<string, readonly WorkspaceFolder[]>>({});
  const foldersBySession = ref<Record<string, readonly WorkspaceFolder[]>>({});
  const stateBySession = ref<Record<string, Record<string, SessionFolderGitState>>>({});
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
    const { root, roots } = workspacesStore().sessionPanelRoots(session);
    return workspaceFolders({ root, additionalDirs: roots.slice(1) });
  }

  function rows(sessionId: string): SessionFolderInfoRow[] {
    const folders = observedBySession.value[sessionId] ?? foldersBySession.value[sessionId];
    if (!folders) return [];
    return folders.map((folder) => ({
      ...folder,
      state: stateBySession.value[sessionId]?.[folder.path] ?? { status: 'loading' },
    }));
  }

  function signature(folders: readonly WorkspaceFolder[]): string {
    return JSON.stringify(folders.map((folder) => [folder.path, folder.primary]));
  }

  function setState(sessionId: string, path: string, state: SessionFolderGitState): void {
    stateBySession.value[sessionId] = { ...stateBySession.value[sessionId], [path]: state };
  }

  function setLoadError(sessionId: string, path: string, code?: number): void {
    const current = stateBySession.value[sessionId]?.[path];
    if (code !== FS_GIT_UNAVAILABLE_CODE && current?.status === 'ready') return;
    setState(sessionId, path, { status: code === FS_GIT_UNAVAILABLE_CODE ? 'non-git' : 'error' });
  }

  function isCurrent(sessionId: string, generation: number, path: string, options?: ReadRequestOptions): boolean {
    return generationBySession.get(sessionId) === generation &&
      observedBySession.value[sessionId]?.some((folder) => folder.path === path) === true &&
      options?.signal?.aborted !== true;
  }

  function load(sessionId: string, generation: number, options?: ReadRequestOptions): Promise<void> {
    const folders = observedBySession.value[sessionId] ?? [];
    const promise = (async () => {
      if (folders.length === 0) return;
      const api = getKimiWebApi();
      const roots = folders.map(folder => folder.path);
      try {
        const batch = await api.getGitStatusBatch(sessionId, { roots, includePullRequest: false }, options);
        for (const folder of folders) {
          if (!isCurrent(sessionId, generation, folder.path, options)) return;
          const value = batch.results[folder.path];
          if (value !== undefined) {
            const previous = stateBySession.value[sessionId]?.[folder.path];
            setState(sessionId, folder.path, {
              status: 'ready',
              value: {
                ...value,
                pullRequest: previous?.status === 'ready' ? previous.value.pullRequest : value.pullRequest,
              },
            });
          } else {
            setLoadError(sessionId, folder.path, batch.errors[folder.path]?.code);
          }
        }
        const prRoots = roots.filter(root => batch.results[root] !== undefined);
        if (prRoots.length === 0) return;
        let pullRequests;
        try {
          pullRequests = await api.getPullRequestBatch(sessionId, { roots: prRoots }, options);
        } catch {
          return;
        }
        for (const root of prRoots) {
          const current = stateBySession.value[sessionId]?.[root];
          if (isCurrent(sessionId, generation, root, options) && current?.status === 'ready' && Object.hasOwn(pullRequests.results, root)) {
            setState(sessionId, root, {
              status: 'ready',
              value: { ...current.value, pullRequest: pullRequests.results[root] ?? null },
            });
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        for (const folder of folders) {
          if (!isCurrent(sessionId, generation, folder.path, options)) return;
          setLoadError(sessionId, folder.path, isDaemonApiError(error) ? error.code : undefined);
        }
      }
    })().finally(() => {
      if (inFlightBySession.get(sessionId) === promise) inFlightBySession.delete(sessionId);
    });
    inFlightBySession.set(sessionId, promise);
    return promise;
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
    observedBySession.value[sessionId] = folders.map((folder) => ({ ...folder }));
    const previousFolders = foldersBySession.value[sessionId];
    foldersBySession.value[sessionId] = observedBySession.value[sessionId];
    if (previousFolders === undefined || signature(previousFolders) !== nextSignature) {
      stateBySession.value[sessionId] = {};
    }
    for (const folder of folders) {
      if (stateBySession.value[sessionId]?.[folder.path] === undefined) setState(sessionId, folder.path, { status: 'loading' });
    }
    const generation = (generationBySession.get(sessionId) ?? 0) + 1;
    generationBySession.set(sessionId, generation);
    return load(sessionId, generation);
  }

  function refresh(sessionId: string, options?: ReadRequestOptions): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (observedContextBySession.value[sessionId]) {
      tasks.push(refreshContext(sessionId, options));
    }
    const observed = observedBySession.value[sessionId];
    if (!observed) return tasks.length > 0 ? Promise.all(tasks).then(() => undefined) : Promise.resolve();
    const queued = queuedRefreshBySession.get(sessionId);
    if (queued) {
      tasks.push(queued);
      return Promise.all(tasks).then(() => undefined);
    }
    const existing = inFlightBySession.get(sessionId);
    if (existing) {
      const pending = existing.finally(() => {
        queuedRefreshBySession.delete(sessionId);
        if (!observedBySession.value[sessionId]) return;
        const generation = (generationBySession.get(sessionId) ?? 0) + 1;
        generationBySession.set(sessionId, generation);
        return load(sessionId, generation, options);
      });
      queuedRefreshBySession.set(sessionId, pending);
      tasks.push(pending);
      return Promise.all(tasks).then(() => undefined);
    }
    const generation = (generationBySession.get(sessionId) ?? 0) + 1;
    generationBySession.set(sessionId, generation);
    tasks.push(load(sessionId, generation, options));
    return Promise.all(tasks).then(() => undefined);
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
  }

  function discard(sessionId: string): void {
    unobserve(sessionId);
    unobserveContext(sessionId);
    delete foldersBySession.value[sessionId];
    delete stateBySession.value[sessionId];
    delete contextBySession.value[sessionId];
  }

  return {
    foldersForSession,
    rows,
    contextState,
    observe,
    observeContext,
    refresh,
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
