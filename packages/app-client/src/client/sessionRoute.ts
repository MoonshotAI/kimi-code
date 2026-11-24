import {
  isSessionAdminLocation,
  readSessionIdFromLocation,
  SESSION_ADMIN_PATH,
  sessionUrl,
  stripRcDevicePrefix,
  withRcQuery,
  type SessionUrlMode,
} from '@moonshot-ai/app-core/lib';
import type { ExtendedState } from './types';

export function routeLocation(): Pick<Location, 'pathname'> {
  return { pathname: stripRcDevicePrefix(window.location.pathname) };
}

export interface SessionRouteDeps {
  selectSession: (
    sessionId: string,
    opts?: { urlMode?: SessionUrlMode; skipTrack?: boolean },
  ) => Promise<void>;
  fetchSessionIntoList: (sessionId: string) => Promise<'ok' | 'not-found' | 'error'>;
  setActiveSessionId: (id: string | undefined) => void;
}

export function createSessionRoute(rawState: ExtendedState, deps: SessionRouteDeps) {
  function writeUrl(target: string, mode: SessionUrlMode): void {
    if (mode === 'none') return;
    if (typeof window === 'undefined' || !window.history) return;
    if (routeLocation().pathname === target) return;
    const carried = withRcQuery(target, window.location.search);
    try {
      if (mode === 'push') window.history.pushState(null, '', carried);
      else window.history.replaceState(null, '', carried);
    } catch {
    }
  }

  function writeSessionUrl(sessionId: string | undefined, mode: SessionUrlMode): void {
    if (rawState.mainView !== 'chat') return;
    writeUrl(sessionUrl(sessionId), mode);
  }

  function openSessionAdmin(): void {
    if (rawState.mainView === 'sessionAdmin') return;
    rawState.mainView = 'sessionAdmin';
    writeUrl(SESSION_ADMIN_PATH, 'push');
  }

  function closeSessionAdmin(opts?: { urlMode?: 'push' | 'replace' }): void {
    if (rawState.mainView !== 'sessionAdmin') return;
    rawState.mainView = 'chat';
    writeSessionUrl(rawState.activeSessionId, opts?.urlMode ?? 'push');
  }

  function onSessionRoutePopState(): void {
    if (isSessionAdminLocation(routeLocation())) {
      rawState.mainView = 'sessionAdmin';
      return;
    }
    rawState.mainView = 'chat';
    const id = readSessionIdFromLocation(routeLocation());
    if (id === undefined) {
      deps.setActiveSessionId(undefined);
      return;
    }
    if (id === rawState.activeSessionId) return;
    if (rawState.sessions.some((s) => s.id === id)) {
      void deps.selectSession(id, { urlMode: 'none', skipTrack: true });
      return;
    }
    void (async () => {
      const outcome = await deps.fetchSessionIntoList(id);
      if (readSessionIdFromLocation(routeLocation()) !== id) return;
      if (outcome === 'ok') {
        await deps.selectSession(id, { urlMode: 'none', skipTrack: true });
        return;
      }
      const next = rawState.sessions[0];
      if (next) {
        await deps.selectSession(next.id, { urlMode: 'replace', skipTrack: true });
      } else {
        deps.setActiveSessionId(undefined);
        writeSessionUrl(undefined, 'replace');
      }
    })();
  }

  let sessionRouteBound = false;
  function bindSessionRoute(): void {
    if (sessionRouteBound || typeof window === 'undefined') return;
    sessionRouteBound = true;
    window.addEventListener('popstate', onSessionRoutePopState);
  }

  return {
    writeSessionUrl,
    openSessionAdmin,
    closeSessionAdmin,
    onSessionRoutePopState,
    bindSessionRoute,
  };
}
