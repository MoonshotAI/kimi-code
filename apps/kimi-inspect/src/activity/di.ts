import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useConnection } from '../connection';
import { GlobalEventsWs } from './ws';

const INVALIDATE_THROTTLE_MS = 250;

export function useDiQueryInvalidation(): void {
  const { baseUrl, config } = useConnection();
  const queryClient = useQueryClient();
  const token = config.token.trim();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey: ['di'] });
      }, INVALIDATE_THROTTLE_MS);
    };
    const ws = new GlobalEventsWs({
      url: baseUrl,
      token: token === '' ? undefined : token,
      handlers: {
        onWorkChanged: () => {},
        onSessionCreated: () => {},
        onMetaUpdated: () => {},
        onDiUnitChanged: invalidate,
        onReconnected: invalidate,
      },
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      ws.close();
    };
  }, [baseUrl, token, queryClient]);
}
