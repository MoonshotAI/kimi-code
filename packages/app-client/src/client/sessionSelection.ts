import type { AppSession, ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { sessionReadScope } from './observationScope';
import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import type { SessionUrlMode } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi, t } from './deps';
import { track } from '../contracts';
import { startSessionOpenTiming } from '../lib/perfTracking';
import { filesStore } from '../stores/files';
import { sessionListStore } from '../stores/sessionList';
import { sessionViewsStore } from '../stores/sessionViews';
import { sessionsStore } from '../stores/sessions';
import { sessionInfoStore } from '../stores/sessionInfo';
import { warningsStore } from '../stores/warnings';
import { workspacesStore } from '../stores/workspaces';
import type { UseModelProviderState } from './useModelProviderState';
import type { SessionCreatedSource } from './deps';

const SESSION_NOT_FOUND_CODE = 40401;

export interface SessionSelectionDeps {
  modelProvider: UseModelProviderState;
  hasLoadedMessages: (sessionId: string) => boolean;
  whenMainConversationLoaded?: (sessionId: string) => Promise<void>;
  prefetchMainConversation?: (sessionId: string) => void;
  markSessionStatusSettled: (sessionId: string) => void;
  appendSession: (session: AppSession) => void;
  setActiveSessionId: (id: string | undefined) => void;
  writeSessionUrl: (sessionId: string | undefined, mode: SessionUrlMode) => void;
  setMainView: (view: 'chat' | 'sessionAdmin') => void;
  setSessionLoading: (loading: boolean) => void;
}

function locationPath(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.pathname;
}

export function createSessionSelection(deps: SessionSelectionDeps) {
  let navigationAttempt = 0;
  let selectionGeneration = 0;

  function refreshSessionSidecars(sessionId: string, opts?: { skipStatus?: boolean }): void {
    const options = sessionReadScope.options(sessionId);
    void filesStore().loadGitStatus(sessionId, options);
    void sessionInfoStore().refresh(sessionId, options);
    if (opts?.skipStatus === true) deps.markSessionStatusSettled(sessionId);
    warningsStore().refreshSessionWarnings(sessionId, options);
    if (!Object.prototype.hasOwnProperty.call(deps.modelProvider.skillsBySession.value, sessionId)) {
      void deps.modelProvider.loadSkillsForSession(sessionId, options);
    }
  }

  async function fetchSessionIntoList(sessionId: string, options?: ReadRequestOptions): Promise<'ok' | 'not-found' | 'error'> {
    if (options?.signal?.aborted) return 'error';
    try {
      const session = await getKimiWebApi().getSession(sessionId, options);
      if (options?.signal?.aborted) return 'error';
      if (sessionListStore().hasDeletedTombstone(sessionId)) return 'not-found';
      if (!session.archived && sessionListStore().hasArchiveTombstone(sessionId)) return 'not-found';
      if (!sessionsStore().sessions.some((s) => s.id === session.id)) {
        sessionListStore().notePoolInsert(session.id);
        deps.appendSession(session);
      }
      return 'ok';
    } catch (err) {
      if (options?.signal?.aborted) return 'error';
      return isDaemonApiError(err) && err.code === SESSION_NOT_FOUND_CODE ? 'not-found' : 'error';
    }
  }

  async function backfillPinnedSession(sessionId: string, options?: ReadRequestOptions): Promise<'ok' | 'stale' | 'retry'> {
    try {
      const session = await getKimiWebApi().getSession(sessionId, { ...options, background: true });
      if (options?.signal?.aborted) return 'retry';
      if (session.archived) return 'stale';
      if (sessionListStore().hasDeletedTombstone(sessionId)) return 'stale';
      if (sessionListStore().hasArchiveTombstone(sessionId)) return 'stale';
      if (!sessionsStore().sessions.some((s) => s.id === session.id)) {
        sessionListStore().notePoolInsert(session.id);
        deps.appendSession(session);
      }
      return 'ok';
    } catch (err) {
      if (options?.signal?.aborted) return 'retry';
      return isDaemonApiError(err) && err.code === SESSION_NOT_FOUND_CODE ? 'stale' : 'retry';
    }
  }

  async function selectSession(
    sessionId: string,
    opts?: {
      urlMode?: SessionUrlMode;
      skipTrack?: boolean;
      skipStatusRefresh?: boolean;
      source?: SessionCreatedSource;
    },
  ): Promise<void> {
    const sessionSource = opts?.source ?? 'sidebar';
    const attempt = ++navigationAttempt;
    const completeOpen =
      opts?.skipTrack === true || sessionsStore().activeSessionId === sessionId
        ? undefined
        : startSessionOpenTiming(sessionId);
    if (!sessionsStore().sessions.some((s) => s.id === sessionId)) {
      if ((await fetchSessionIntoList(sessionId)) !== 'ok') {
        return;
      }
      if (attempt !== navigationAttempt) {
        return;
      }
    }
    const messagesLoaded = deps.hasLoadedMessages(sessionId);
    const isResumedNavigation = sessionsStore().activeSessionId !== sessionId;
    const loadingForBaseline = !messagesLoaded;
    try {
      if (loadingForBaseline) deps.prefetchMainConversation?.(sessionId);
      if ((opts?.urlMode ?? 'push') === 'push') deps.setMainView('chat');
      deps.writeSessionUrl(sessionId, opts?.urlMode ?? 'push');
      const generation = ++selectionGeneration;
      deps.setSessionLoading(loadingForBaseline);
      sessionReadScope.activate(sessionId);
      deps.setActiveSessionId(sessionId);
      if (!opts?.skipTrack && isResumedNavigation) {
        track('session_created', { kind: 'resumed', source: sessionSource });
      }
      if (sessionViewsStore().unreadBySession[sessionId]) {
        sessionViewsStore().clearUnread(sessionId);
      }
      filesStore().clearFileDiff();

      const selected = sessionsStore().sessions.find((s) => s.id === sessionId);
      if (selected) {
        const wid = workspacesStore().workspaceIdForSession(selected);
        if (workspacesStore().storedActiveWorkspaceId !== wid) workspacesStore().selectWorkspace(wid);
      }

      refreshSessionSidecars(sessionId, { skipStatus: opts?.skipStatusRefresh === true });
      const baselinePromise = deps.whenMainConversationLoaded?.(sessionId) ?? Promise.resolve();
      if (loadingForBaseline) {
        const finishLoading = () => {
          if (generation === selectionGeneration && sessionsStore().activeSessionId === sessionId) deps.setSessionLoading(false);
        };
        void baselinePromise.then(finishLoading, finishLoading);
      }
      completeOpen?.({
        cached: messagesLoaded,
        baseline: baselinePromise,
        isLoaded: () => deps.hasLoadedMessages(sessionId),
        isCurrent: () => generation === selectionGeneration && sessionsStore().activeSessionId === sessionId,
      });
    } catch (err) {
      warningsStore().pushOperationFailure('selectSession', err, { sessionId });
    } finally {
      if (!loadingForBaseline && sessionsStore().activeSessionId === sessionId) {
        deps.setSessionLoading(false);
      }
    }
  }

  async function openSessionLink(sessionId: string, source: SessionCreatedSource): Promise<void> {
    if (!sessionsStore().sessions.some((s) => s.id === sessionId)) {
      const attempt = ++navigationAttempt;
      const path = locationPath();
      const outcome = await fetchSessionIntoList(sessionId);
      if (attempt !== navigationAttempt || locationPath() !== path) return;
      if (outcome !== 'ok') {
        warningsStore().pushWarning({
          severity: 'warning',
          title: t(outcome === 'not-found' ? 'sessions.notFound' : 'sessions.openFailed'),
        });
        return;
      }
    }
    await selectSession(sessionId, { source });
  }

  return {
    refreshSessionSidecars,
    fetchSessionIntoList,
    backfillPinnedSession,
    selectSession,
    openSessionLink,
  };
}

export type UseSessionSelection = ReturnType<typeof createSessionSelection>;
