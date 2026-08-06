/**
 * DI debug feed — a dedicated global-events socket for the DI view. The
 * session activity hub (`useSessionActivities`) lives with the chat Sidebar,
 * which unmounts when the DI view is active, so the DI view owns its own
 * `GlobalEventsWs` (only one of the two is ever connected at a time).
 *
 * Every `event.di.unit_changed` frame invalidates the `['di']` query prefix
 * (the same pattern as `event.session.created` invalidating `['sessions']`),
 * so all DI panels refetch on unit transitions instead of waiting out their
 * poll interval. Bursts (a cascade flipping many units at once) are coalesced
 * with a short trailing throttle; a reconnect invalidates immediately, since
 * live transitions were missed while the socket was down.
 */

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
