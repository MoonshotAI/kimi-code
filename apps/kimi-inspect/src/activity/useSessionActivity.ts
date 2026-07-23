/**
 * React binding for the session activity hub: one hub per (server, token),
 * torn down on server switch or unmount. Consumers read per-session coarse
 * activity (`get(sessionId)`) and re-render on every store bump; list-level
 * signals invalidate the `['sessions']` react-query list directly.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useConnection } from '../connection';
import { SessionActivityHub, type SessionWorkFacts } from './store';

export function useSessionActivities(): {
  get(sessionId: string): SessionWorkFacts | undefined;
} {
  const { baseUrl, config } = useConnection();
  const queryClient = useQueryClient();
  const token = config.token.trim();
  const hub = useMemo(
    () =>
      new SessionActivityHub({
        url: baseUrl,
        token: token === '' ? undefined : token,
        onListChanged: () => void queryClient.invalidateQueries({ queryKey: ['sessions'] }),
      }),
    [baseUrl, token, queryClient],
  );
  useEffect(() => () => hub.close(), [hub]);
  useSyncExternalStore(
    (listener) => hub.store.subscribe(listener),
    () => hub.store.getVersion(),
  );
  return hub.store;
}
