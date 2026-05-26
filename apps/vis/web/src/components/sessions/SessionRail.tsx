import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { useDeleteSession, useSessions } from '../../hooks/useSession';
import type { SessionSummary, SessionHealth } from '../../types';
import { SessionCard } from './SessionCard';
import { SessionFilter } from './SessionFilter';

export type SessionSortKey = 'recent' | 'oldest' | 'most_records' | 'most_subagents';
export type HealthFilter = 'all' | SessionHealth;

function workspaceKey(s: SessionSummary): string {
  if (!s.workDir) return '(no workspace)';
  return s.workDir.split('/').slice(-2).join('/');
}

function sortSessions(sessions: readonly SessionSummary[], key: SessionSortKey): SessionSummary[] {
  switch (key) {
    case 'recent':
      return sessions.toSorted((a, b) => b.updatedAt - a.updatedAt);
    case 'oldest':
      return sessions.toSorted((a, b) => a.createdAt - b.createdAt);
    case 'most_records':
      return sessions.toSorted((a, b) => b.mainWireRecordCount - a.mainWireRecordCount);
    case 'most_subagents':
      return sessions.toSorted((a, b) => (b.agentCount - 1) - (a.agentCount - 1));
  }
}

export function SessionRail() {
  const { data, isLoading, error } = useSessions();
  const deleteSession = useDeleteSession();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SessionSortKey>('recent');
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.filter((s) => {
      if (healthFilter !== 'all' && s.health !== healthFilter) return false;
      if (!q) return true;
      const hay = [
        s.sessionId,
        s.title ?? '',
        s.lastPrompt ?? '',
        s.workDir ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [data, search, healthFilter]);

  const grouped = useMemo(() => {
    if (sortKey !== 'recent') return null;
    const map = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      const k = workspaceKey(s);
      const existing = map.get(k);
      if (existing === undefined) {
        map.set(k, [s]);
      } else {
        existing.push(s);
      }
    }
    return [...map.entries()]
      .map(([group, items]) => {
        const sorted = items.toSorted((a, b) => b.updatedAt - a.updatedAt);
        return [group, sorted] as const;
      })
      .toSorted(([, a], [, b]) => {
        const ua = a[0]?.updatedAt ?? 0;
        const ub = b[0]?.updatedAt ?? 0;
        return ub - ua;
      });
  }, [filtered, sortKey]);

  const flat = useMemo(
    () => (grouped === null ? sortSessions(filtered, sortKey) : null),
    [filtered, sortKey, grouped],
  );

  async function handleDeleteSession(session: SessionSummary) {
    const label = session.title ?? session.lastPrompt ?? session.sessionId;
    if (!window.confirm(`Delete session "${label}"?\n\nThis removes its files from KIMI_CODE_HOME.`)) {
      return;
    }
    try {
      await deleteSession.mutateAsync(session.sessionId);
      if (sessionId === session.sessionId) {
        void navigate('/');
      }
    } catch (deleteError) {
      window.alert(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  return (
    <aside className="flex h-full min-h-0 w-[320px] shrink-0 flex-col border-r border-border bg-surface-1">
      <SessionFilter
        search={search}
        onSearchChange={setSearch}
        sortKey={sortKey}
        onSortChange={setSortKey}
        healthFilter={healthFilter}
        onHealthChange={setHealthFilter}
        totalCount={data?.length ?? 0}
        filteredCount={filtered.length}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-3 font-mono text-[11px] text-fg-3">loading…</div>
        ) : error ? (
          <div className="p-3 font-mono text-[11px] text-[var(--color-sev-error)]">
            {error.message}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-3 font-mono text-[11px] text-fg-3">no sessions match</div>
        ) : grouped !== null ? (
          grouped.map(([group, items]) => (
            <div key={group}>
              <div className="sticky top-0 z-10 border-b border-border bg-surface-1 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
                {group} <span className="text-fg-3 tabular">· {items.length}</span>
              </div>
              {items.map((s) => (
                <SessionCard
                  key={s.sessionId}
                  session={s}
                  onDelete={(target) => {
                    void handleDeleteSession(target);
                  }}
                  deleting={deleteSession.isPending && deleteSession.variables === s.sessionId}
                />
              ))}
            </div>
          ))
        ) : (
          flat?.map((s) => (
            <SessionCard
              key={s.sessionId}
              session={s}
              onDelete={(target) => {
                void handleDeleteSession(target);
              }}
              deleting={deleteSession.isPending && deleteSession.variables === s.sessionId}
            />
          ))
        )}
      </div>
    </aside>
  );
}
