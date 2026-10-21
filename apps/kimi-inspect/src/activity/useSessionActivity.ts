import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';

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
      onListChanged: () => {
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      },
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
