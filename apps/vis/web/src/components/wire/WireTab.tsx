import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSession } from '../../hooks/useSession';
import { useWire } from '../../hooks/useWire';
import { computeIssues, topSeverity } from '../../lib/issues';
import type { WireLine } from '../../types';
import { IssuesDrawer } from './IssuesDrawer';
import { WireRow } from './WireRow';

interface WireTabProps {
  sessionId: string;
  /** Override starting agentId; defaults to 'main'. */
  initialAgentId?: string;
}

export function WireTab({ sessionId, initialAgentId = 'main' }: WireTabProps) {
  const [agentId, setAgentId] = useState<string>(initialAgentId);
  // Re-sync when the route changes the prop while this component stays
  // mounted (e.g. navigating between /sessions/x/agents/a → /agents/b).
  useEffect(() => {
    setAgentId(initialAgentId);
  }, [initialAgentId]);
  const { data: detail } = useSession(sessionId);
  const { data: wire, isLoading, error } = useWire(sessionId, agentId);
  const parentRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);

  const records: WireLine[] = useMemo(() => {
    return (wire?.records ?? []) as WireLine[];
  }, [wire?.records]);
  const warnings = wire?.warnings ?? [];

  const filtered = useMemo(() => {
    if (search.length === 0) return records;
    const needle = search.toLowerCase();
    return records.filter((r) => {
      if (r.type.toLowerCase().includes(needle)) return true;
      try {
        return JSON.stringify(r).toLowerCase().includes(needle);
      } catch {
        return false;
      }
    });
  }, [records, search]);

  const issues = useMemo(() => computeIssues(records, warnings), [records, warnings]);
  const issuesSeverity = topSeverity(issues);

  const virt = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (i) => filtered[i]?._lineNo ?? i,
  });

  const toggle = useCallback((lineNo: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(lineNo)) next.delete(lineNo);
      else next.add(lineNo);
      return next;
    });
  }, []);

  const filteredLineIdx = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 0; i < filtered.length; i += 1) {
      const r = filtered[i];
      if (r !== undefined) m.set(r._lineNo, i);
    }
    return m;
  }, [filtered]);

  const jumpToLine = useCallback(
    (lineNo: number) => {
      const idx = filteredLineIdx.get(lineNo);
      if (idx === undefined) return;
      virt.scrollToIndex(idx, { align: 'center' });
      setExpanded((prev) => (prev.has(lineNo) ? prev : new Set(prev).add(lineNo)));
    },
    [filteredLineIdx, virt],
  );

  const expandAll = () => {
    setExpanded(new Set(filtered.map((r) => r._lineNo)));
  };
  const collapseAll = () => {
    setExpanded(new Set());
  };

  const agents = detail?.agents ?? [];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
        <label className="flex items-center gap-2 font-mono text-[11px] text-fg-2">
          <span className="text-fg-3">agent</span>
          <select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
            }}
            className="border border-border bg-surface-0 px-2 py-1 font-mono text-[12px] text-fg-0 focus:border-border-strong focus:outline-none"
          >
            {agents.length === 0 ? <option value={agentId}>{agentId}</option> : null}
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.agentId} ({a.type}
                {a.parentAgentId ? ` ← ${a.parentAgentId}` : ''})
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          placeholder="search records (substring)"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          className="w-80 border border-border bg-surface-0 px-2 py-1 font-mono text-[12px] text-fg-0 placeholder:text-fg-3 focus:border-border-strong focus:outline-none"
        />
        <div className="ml-auto flex items-center gap-3 font-mono text-[11px] text-fg-2">
          <span className="tabular">
            {filtered.length} / {records.length} ev
          </span>
          {issues.length > 0 && issuesSeverity !== null ? (
            <button
              onClick={() => {
                setDrawerOpen(true);
              }}
              title={`${issues.length} issue${issues.length > 1 ? 's' : ''} — click to inspect`}
              className="flex items-center gap-1 border px-2 py-0.5"
              style={{
                borderColor: `var(--color-sev-${issuesSeverity})`,
                color: `var(--color-sev-${issuesSeverity})`,
                backgroundColor: `color-mix(in oklab, var(--color-sev-${issuesSeverity}) 10%, transparent)`,
              }}
            >
              <span>
                {issuesSeverity === 'error' ? '⚠' : issuesSeverity === 'warning' ? '⚠' : 'ℹ'}
              </span>
              <span className="tabular">{issues.length}</span>
            </button>
          ) : null}
          <button
            onClick={expandAll}
            className="border border-border px-2 py-0.5 text-fg-2 hover:border-border-strong hover:text-fg-0"
          >
            expand all
          </button>
          <button
            onClick={collapseAll}
            className="border border-border px-2 py-0.5 text-fg-2 hover:border-border-strong hover:text-fg-0"
          >
            collapse
          </button>
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="shrink-0 border-b border-[var(--color-sev-warning)] bg-[color-mix(in_oklab,var(--color-sev-warning)_8%,transparent)] px-3 py-1 font-mono text-[11px] text-[var(--color-sev-warning)]">
          {warnings.length} warning{warnings.length > 1 ? 's' : ''} · first: {warnings[0]}
        </div>
      ) : null}

      {isLoading ? (
        <div className="p-6 font-mono text-[12px] text-fg-3">loading wire…</div>
      ) : error ? (
        <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">
          {(error as Error).message}
        </div>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-6 font-mono text-[12px] text-fg-3">
              no records match the current filter
            </div>
          ) : (
            <div
              style={{
                height: virt.getTotalSize(),
                position: 'relative',
              }}
            >
              {virt.getVirtualItems().map((vi) => {
                const r = filtered[vi.index];
                if (!r) return null;
                return (
                  <div
                    key={vi.key}
                    data-index={vi.index}
                    ref={virt.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <WireRow
                      record={r}
                      expanded={expanded.has(r._lineNo)}
                      onToggle={() => {
                        toggle(r._lineNo);
                      }}
                      onJumpTo={jumpToLine}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {drawerOpen ? (
        <IssuesDrawer
          issues={issues}
          onClose={() => {
            setDrawerOpen(false);
          }}
          onJumpTo={jumpToLine}
          isLineVisible={(lineNo) => filteredLineIdx.has(lineNo)}
        />
      ) : null}
    </div>
  );
}
