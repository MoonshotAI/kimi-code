/**
 * Session pane — the column right next to the session-list sidebar in the
 * chat view. Hosts everything session-scoped: the pending-interactions card
 * and the session Service panels under the `Services` tab, plus a `State`
 * tab reading the session's registered plain-data state through
 * `ISessionStateService.snapshot()` (every key a Session Service registered
 * into the session-state container, JSON-safe). The Service panels are
 * fetch-on-demand (no Service-event push channel exists); the State tab
 * instead auto-loads on mount and polls once a second, so it stays live
 * without a Refresh button.
 */

import { ISessionStateService } from '@moonshot-ai/agent-core-v2/session/state/sessionState';
import { useMemo, useState } from 'react';

import { serviceByName } from '../channel';
import { useConnection } from '../connection';
import { type AnyService } from '../panels';
import { InteractionsCard } from './InteractionsCard';
import { ScopePanels } from './ServicePanels';
import { StateCard } from './StateCard';

type Tab = 'services' | 'state';

export function SessionPane({ sessionId, ready }: { sessionId: string | null; ready: boolean }) {
  const { klient } = useConnection();
  const [tab, setTab] = useState<Tab>('services');

  const proxyFor = useMemo(() => {
    return (name: string): AnyService | null => {
      return (
        serviceByName<AnyService>(klient, name, {
          scope: 'session',
          sessionId: sessionId !== null && ready ? sessionId : undefined,
        }) ?? null
      );
    };
  }, [klient, sessionId, ready]);

  const blocked = sessionId === null || !ready;

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-900/30">
      <div className="flex border-b border-neutral-800 text-[11px]">
        {(['services', 'state'] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 px-2 py-2 font-medium uppercase tracking-wider ${
              tab === t ? 'bg-neutral-800 text-sky-400' : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'services' ? 'Services' : 'State'}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {blocked ? (
          <div className="text-[12px] text-neutral-600">
            {sessionId === null ? 'No session selected.' : 'Loading session…'}
          </div>
        ) : tab === 'services' ? (
          <>
            <InteractionsCard sessionId={sessionId} />
            <ScopePanels scope="session" proxyFor={proxyFor} />
          </>
        ) : (
          <StateCard
            id={sessionId}
            queryKey={['sessionState', sessionId]}
            title="Session state"
            label="sessionStateService"
            fetchSnapshot={() => klient.session(sessionId).service(ISessionStateService).snapshot()}
          />
        )}
      </div>
    </div>
  );
}
