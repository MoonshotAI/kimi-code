import { ref } from 'vue';
import type { BootStage } from '@moonshot-ai/app-core/lib';
import { isSessionAdminLocation, logError, logInfo, logWarn, readSessionIdFromLocation } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi, traceKeyEvent } from './deps';
import { authStore, type AuthCheckResult } from '../stores/auth';
import { configStore } from '../stores/config';
import { modelsStore } from '../stores/models';
import { modelSwitchConfirmStore } from '../stores/modelSwitchConfirm';
import { effortSwitchStore } from '../stores/effortSwitch';
import { sessionListStore, type FiredSessionGroupPage } from '../stores/sessionList';
import { sessionViewsStore } from '../stores/sessionViews';
import { sessionsStore } from '../stores/sessions';
import { warningsStore } from '../stores/warnings';
import { workspacesStore } from '../stores/workspaces';
import type { UseModelProviderState } from './useModelProviderState';
import type { ExtendedState } from './types';
import type { UseSessionSelection } from './sessionSelection';
import { routeLocation } from './sessionRoute';
import { resetObservationScopes } from './observationScope';
import { loadPinnedSessions } from '@moonshot-ai/app-core/lib';

const FIRST_LOAD_AUTH_RETRY_MS = 2000;
const BOOT_STEP_PENDING_LOG_MS = 10_000;

function bootErrorDetails(error: unknown): Record<string, unknown> {
  const value = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined;
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    method: typeof value?.method === 'string' ? value.method : undefined,
    path: typeof value?.path === 'string' ? value.path : undefined,
    code: typeof value?.code === 'number' ? value.code : undefined,
    requestId: typeof value?.requestId === 'string' ? value.requestId : undefined,
    phase: typeof value?.phase === 'string' ? value.phase : undefined,
    httpStatus: typeof value?.status === 'number' ? value.status : undefined,
    statusText: typeof value?.statusText === 'string' ? value.statusText : undefined,
    timeoutMs: typeof value?.timeoutMs === 'number' ? value.timeoutMs : undefined,
  };
}

async function traceBootStep<T>(
  options: { runId: number; stage: BootStage; step: string; signal: AbortSignal },
  request: (reportError: (error: unknown) => void) => Promise<T>,
): Promise<T> {
  const { runId, stage, step, signal } = options;
  const name = `[boot] ${stage}.${step}`;
  const startedAt = Date.now();
  let terminal = false;
  const pendingTimer = setTimeout(() => {
    if (!terminal) logWarn(`${name} pending`, { runId, elapsedMs: Date.now() - startedAt });
  }, BOOT_STEP_PENDING_LOG_MS);
  const reportError = (error: unknown): void => {
    if (terminal) return;
    terminal = true;
    clearTimeout(pendingTimer);
    logError(`${name} error`, { runId, durationMs: Date.now() - startedAt, ...bootErrorDetails(error) });
  };
  const onAbort = (): void => {
    if (!terminal) {
      terminal = true;
      logInfo(`${name} cancelled`, { runId, durationMs: Date.now() - startedAt });
    }
    clearTimeout(pendingTimer);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  logInfo(`${name} start`, { runId });
  try {
    const result = await request(reportError);
    if (!terminal) {
      if (signal.aborted) onAbort();
      else {
        terminal = true;
        logInfo(`${name} ok`, { runId, durationMs: Date.now() - startedAt });
      }
    }
    return result;
  } catch (error) {
    if (signal.aborted) onAbort();
    else reportError(error);
    throw error;
  } finally {
    terminal = true;
    clearTimeout(pendingTimer);
    signal.removeEventListener('abort', onAbort);
  }
}

export interface WorkspaceBootDeps {
  connectEventsIfNeeded?: () => void;
  modelProvider: UseModelProviderState;
  bindSessionRoute: () => void;
  writeSessionUrl: (sessionId: string | undefined, mode: 'push' | 'replace') => void;
  unpinSessions: (ids: string[]) => void;
  setActiveSessionId: (id: string | undefined) => void;
  sessionSelection: UseSessionSelection;
  resumeObservationReads?: () => void;
}

export function createWorkspaceBoot(rawState: ExtendedState, deps: WorkspaceBootDeps) {
  const initialized = ref(false);
  const bootStage = ref<BootStage>('auth');
  const bootRetries = ref(0);

  let controller: AbortController | undefined;
  let loadGeneration = 0;

  function cancel(): void {
    controller?.abort();
    controller = undefined;
    sessionListStore().cancelBackgroundReads();
    resetObservationScopes();
    rawState.loading = false;
  }

  async function waitForFirstAuth(signal: AbortSignal, runId: number): Promise<AuthCheckResult> {
    let firstRetry = true;
    for (;;) {
      signal.throwIfAborted();
      const result = await traceBootStep({ runId, stage: 'auth', step: 'check', signal }, (reportError) => authStore().checkAuth(reportError));
      signal.throwIfAborted();
      if (result !== 'retry') return result;
      bootRetries.value += 1;
      if (firstRetry) {
        authStore().connectIssue = null;
        firstRetry = false;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, FIRST_LOAD_AUTH_RETRY_MS);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  async function load(): Promise<void> {
    cancel();
    const run = new AbortController();
    controller = run;
    const options = { signal: run.signal };
    const runId = ++loadGeneration;
    const trace = <T>(stage: BootStage, step: string, request: (reportError: (error: unknown) => void) => Promise<T>): Promise<T> =>
      traceBootStep({ runId, stage, step, signal: options.signal }, request);
    const startedAt = Date.now();
    let traceStatus = 'accepted';
    traceKeyEvent('app:load:start');
    rawState.loading = true;
    sessionListStore().clearPoolInserts();
    const firstLoad = !initialized.value;
    let authResolved = true;
    try {
      bootStage.value = 'auth';
      bootRetries.value = 0;
      if (firstLoad && (await waitForFirstAuth(run.signal, runId)) === 'server-auth-required') {
        authResolved = false;
        traceStatus = 'auth-required';
        return;
      }
      options.signal.throwIfAborted();
      bootRetries.value = 0;
      const api = getKimiWebApi();
      deps.connectEventsIfNeeded?.();
      bootStage.value = 'server';
      void modelsStore().loadCatalogProviders();
      void modelSwitchConfirmStore().refresh({ signal: run.signal });
      void effortSwitchStore().refresh({ signal: run.signal });
      await Promise.all([
        trace('server', 'health', () => api.getHealth()).catch(() => null),
        trace('server', 'server-meta', (reportError) => configStore().refreshServerMeta(reportError)),
        trace('server', 'models', (reportError) => deps.modelProvider.loadModels(reportError)),
      ]);
      options.signal.throwIfAborted();

      if (!firstLoad) await trace('auth', 'check', (reportError) => authStore().checkAuth(reportError));
      options.signal.throwIfAborted();
      bootStage.value = 'config';
      await trace('config', 'load', (reportError) => configStore().loadConfig(reportError));
      options.signal.throwIfAborted();

      bootStage.value = 'sessions';
      let firedGroups!: FiredSessionGroupPage;
      const firstPage = trace('sessions', 'first-page', (reportError) => {
        firedGroups = sessionListStore().fireFirstSessionGroupPage(options, reportError);
        return firedGroups.firstPage;
      });
      options.signal = firedGroups.signal;
      await workspacesStore().loadWorkspaces((step, request) => trace('sessions', `workspaces.${step}`, request));
      options.signal.throwIfAborted();
      const initialLoad = await trace('sessions', 'initial', (reportError) =>
        sessionListStore().loadInitialSessionsByWorkspace({ ...firedGroups, firstPage }, reportError));
      options.signal.throwIfAborted();
      if (initialLoad !== undefined) {
        sessionListStore().setSessionsPreservingLiveUsage(initialLoad.sessions);
      }
      const liveHydrateIds = sessionListStore().takePendingLiveHydrateIds();
      const hydratedLiveIds = new Set<string>();
      const hydrateTarget = async (id: string) => {
        if (!liveHydrateIds.includes(id)) return;
        await trace(bootStage.value, 'hydrate', (reportError) =>
          sessionListStore().hydrateLiveSession(id, { ...options, background: false }, reportError));
        options.signal.throwIfAborted();
        hydratedLiveIds.add(id);
      };
      const refreshFlat = !firstLoad && initialLoad !== undefined && rawState.flatSessionsSeeded;

      const missingActiveId = sessionsStore().activeSessionId;
      if (
        missingActiveId !== undefined &&
        !sessionsStore().sessions.some((s) => s.id === missingActiveId)
      ) {
        const outcome = await trace(bootStage.value, 'fetch', () => deps.sessionSelection.fetchSessionIntoList(missingActiveId, options));
        options.signal.throwIfAborted();
        if (outcome === 'not-found' && sessionsStore().activeSessionId === missingActiveId) {
          deps.setActiveSessionId(undefined);
          deps.writeSessionUrl(undefined, 'replace');
        }
      }
      const statusActiveId = sessionsStore().activeSessionId;
      if (statusActiveId !== undefined) {
        await hydrateTarget(statusActiveId);
        options.signal.throwIfAborted();
      }

      bootStage.value = 'session';
      const mostRecent = sessionsStore().sessions[0];
      const persisted = workspacesStore().storedActiveWorkspaceId;
      const persistedStillExists =
        persisted !== null && workspacesStore().mergedWorkspaces.some((w) => w.id === persisted);
      if (!persistedStillExists && mostRecent) {
        workspacesStore().selectWorkspace(workspacesStore().workspaceIdForSession(mostRecent));
      }

      deps.bindSessionRoute();
      const sessionAdminDeepLink =
        typeof window !== 'undefined' && isSessionAdminLocation(routeLocation());
      if (sessionAdminDeepLink) rawState.mainView = 'sessionAdmin';
      const urlSessionId =
        typeof window !== 'undefined' ? readSessionIdFromLocation(routeLocation()) : undefined;
      let allowMostRecent = true;
      if (!sessionsStore().activeSessionId && urlSessionId !== undefined) {
        const outcome = sessionsStore().sessions.some((s) => s.id === urlSessionId)
          ? 'ok'
          : await trace('session', 'fetch', () => deps.sessionSelection.fetchSessionIntoList(urlSessionId, options));
        options.signal.throwIfAborted();
        allowMostRecent = outcome === 'not-found';
        if (outcome === 'ok' && !sessionsStore().activeSessionId) {
          await hydrateTarget(urlSessionId);
          if (!sessionsStore().activeSessionId && !sessionListStore().hasDeletedTombstone(urlSessionId)) {
            await trace('session', 'select', () => deps.sessionSelection.selectSession(urlSessionId, { urlMode: 'replace', skipTrack: true }));
            options.signal.throwIfAborted();
          }
        }
      }

      const nextSession = sessionsStore().sessions[0];
      if (firstLoad && !sessionsStore().activeSessionId && allowMostRecent && nextSession !== undefined) {
        await hydrateTarget(nextSession.id);
        if (!sessionsStore().activeSessionId && !sessionListStore().hasDeletedTombstone(nextSession.id)) {
          await trace('session', 'select', () => deps.sessionSelection.selectSession(nextSession.id, {
            urlMode: sessionAdminDeepLink ? 'none' : 'replace',
            skipTrack: true,
          }));
          options.signal.throwIfAborted();
        }
      }

      deps.resumeObservationReads?.();
      const backgroundOptions = sessionListStore().backgroundReadOptions(options);
      if (initialLoad?.finishInBackground !== undefined) {
        void initialLoad.finishInBackground(backgroundOptions);
      }
      for (const id of liveHydrateIds) {
        if (hydratedLiveIds.has(id)) continue;
        void sessionListStore().hydrateLiveSession(id, backgroundOptions).then(() => {
          if (backgroundOptions.signal.aborted || sessionListStore().hasDeletedTombstone(id) ||
            sessionListStore().hasArchiveTombstone(id)) return;
        });
      }
      for (const id of loadPinnedSessions()) {
        if (sessionsStore().sessions.some((s) => s.id === id)) continue;
        void deps.sessionSelection.backfillPinnedSession(id, backgroundOptions).then((outcome) => {
          if (!backgroundOptions.signal.aborted && outcome === 'stale') deps.unpinSessions([id]);
        }).catch(() => {});
      }
      if (refreshFlat) {
        rawState.flatSessionsSeeded = false;
        rawState.flatSessionsNextPageToken = null;
        rawState.flatSessionsHasMore = true;
        sessionViewsStore().setFlatSessionsFrontier(null);
        void sessionListStore().fetchFlatSessionsFirstPage(backgroundOptions).catch((err) => {
          if (!backgroundOptions.signal.aborted) warningsStore().pushOperationFailure('ensureFlatSessions', err);
        });
      }
    } catch (err) {
      traceStatus = options.signal.aborted ? 'cancelled' : 'failed';
      if (!options.signal.aborted) warningsStore().pushOperationFailure('load', err);
    } finally {
      if (controller === run && !options.signal.aborted) {
        rawState.loading = false;
        if (authResolved) initialized.value = true;
      }
      traceKeyEvent('app:load:complete', {
        status: traceStatus,
        sessionId: sessionsStore().activeSessionId,
        sessionCount: sessionsStore().sessions.length,
        workspaceCount: workspacesStore().workspaces.length,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  return {
    initialized,
    bootStage,
    bootRetries,
    load,
    cancel,
  };
}

export type UseWorkspaceBoot = ReturnType<typeof createWorkspaceBoot>;
