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

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { ISessionStateService } from '@moonshot-ai/agent-core-v2/session/state/sessionState';

import { diffValue, type DiffNode } from '../audit/diff';
import { serviceByName } from '../channel';
import { useConnection } from '../connection';
import { type AnyService } from '../panels';
import { Badge, ErrorLine, ActionButton } from '../ui';
import { StateTree, plainNode } from './audit/StateTree';
import { InteractionsCard } from './InteractionsCard';
import { ScopePanels } from './ServicePanels';

type Tab = 'services' | 'state';

export function SessionPane({
  sessionId,
  ready,
}: {
  sessionId: string | null;
  ready: boolean;
}) {
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
          <StateCard sessionId={sessionId} />
        )}
      </div>
    </div>
  );
}

/**
 * The session's registered state as a live diff tree — the same view as the
 * audit panel's "Diff vs prev" (`StateTree` over a `DiffNode` root), so
 * every key is an interactive, collapsible row. Auto-loads on mount and
 * polls every second: the first snapshot (and any session switch) renders
 * as a plain tree, each later snapshot folds in as a structural diff
 * against the previous one (added = green, removed = red, modified =
 * amber). Changed subtrees auto-open; rows the user expanded stay expanded
 * across polls.
 */
function StateCard({ sessionId }: { sessionId: string }) {
  const { klient } = useConnection();
  const query = useQuery({
    queryKey: ['sessionState', sessionId],
    queryFn: async () => {
      const snapshot = await klient.session(sessionId).service(ISessionStateService).snapshot();
      return { sessionId, snapshot };
    },
    refetchInterval: 1000,
    placeholderData: (previous) => previous,
  });

  // Fold each poll into a diff against the previous snapshot. `plainNode`
  // on first load / session switch — diffing a freshly loaded tree against
  // nothing (or against the previous session) would paint it all-green.
  const [tree, setTree] = useState<{ sessionId: string; node: DiffNode } | null>(null);
  useEffect(() => {
    const data = query.data;
    if (data === undefined) return;
    setTree((prev) =>
      prev === null || prev.sessionId !== data.sessionId
        ? { sessionId: data.sessionId, node: plainNode(data.snapshot) }
        : { sessionId: data.sessionId, node: diffValue(prev.node.value, data.snapshot) },
    );
  }, [query.data]);

  // One-click expand/collapse: bumping `nonce` remounts the tree, and the
  // fresh `defaultDepth` decides how deep nodes open (Infinity = expand all,
  // 0 = collapse all — diff-changed subtrees still auto-open, as in the
  // audit panel). Polls afterwards keep the local open state untouched.
  const [expand, setExpand] = useState({ nonce: 0, depth: 1 });

  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/60">
      <div className="flex items-center justify-between border-b border-neutral-800/60 px-3 py-2">
        <div>
          <span className="text-[12px] font-medium text-neutral-200">Session state</span>
          <span className="ml-2 font-mono text-[10px] text-neutral-600">sessionStateService</span>
          {tree !== null ? (
            <Badge tone="neutral">
              {Object.keys(tree.node.value as Record<string, unknown>).length} keys
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <ActionButton
            onClick={() =>
              setExpand((s) => ({ nonce: s.nonce + 1, depth: Number.POSITIVE_INFINITY }))
            }
          >
            Expand
          </ActionButton>
          <ActionButton onClick={() => setExpand((s) => ({ nonce: s.nonce + 1, depth: 0 }))}>
            Collapse
          </ActionButton>
          <span className="text-[10px] text-neutral-600">live · 1s</span>
        </div>
      </div>
      <div className="px-3 py-2">
        {query.isError ? (
          <div className="mb-2">
            <ErrorLine error={query.error} />
          </div>
        ) : null}
        {tree === null ? (
          <div className="text-[11px] text-neutral-600 italic">
            {query.isPending ? 'Loading state…' : 'no state registered'}
          </div>
        ) : (
          <StateTree key={expand.nonce} root={tree.node} defaultDepth={expand.depth} />
        )}
      </div>
    </div>
  );
}
