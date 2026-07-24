/**
 * React binding for the session activity hub: one hub per (server, token),
 * torn down on server switch or unmount. Consumers read per-session coarse
 * activity (`get(sessionId)`) and re-render on every store bump; list-level
 * signals invalidate the `['sessions']` react-query list directly.
 *
 * The hub is created inside `useEffect` (not `useMemo`): under StrictMode
 * the mount → cleanup → re-mount cycle runs the cleanup of the FIRST mount,
 * and a memo-created hub would stay closed for the rest of the page's life.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useConnection } from '../connection';
import { SessionActivityHub, SessionActivityStore, type SessionWorkFacts } from './store';

const EMPTY_STORE = new SessionActivityStore();

export function useSessionActivities(): {
  get(sessionId: string): SessionWorkFacts | undefined;
} {
  const { baseUrl, config } = useConnection();
  const queryClient = useQueryClient();
  const token = config.token.trim();
  const [hub, setHub] = useState<SessionActivityHub | null>(null);

  useEffect(() => {
    const created = new SessionActivityHub({
      url: baseUrl,
      token: token === '' ? undefined : token,
      onListChanged: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
    });
    setHub(created);
    return () => {
      setHub(null);
      created.close();
    };
  }, [baseUrl, token, queryClient]);

  const store = hub?.store ?? EMPTY_STORE;
  useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getVersion(),
  );
  return store;
}
