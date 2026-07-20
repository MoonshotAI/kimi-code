import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSession } from '../../hooks/useSession';
import { useWire } from '../../hooks/useWire';
import { computeIssues, topSeverity } from '../../lib/issues';
import type { AgentRecord, WireEntry } from '../../types';
import { IssuesDrawer } from './IssuesDrawer';
import { WireRow, type PairHint } from './WireRow';

interface PairRecord {
  callLineNo: number | null;
  resultLineNo: number | null;
  callTime: number | null;
  resultTime: number | null;
}

/** Scan all entries and pair every `tool.call` with its `tool.result`
 *  by `toolCallId`. Used to render the inline "→ #N" / "← #N" cross-
 *  references, the call→result duration, and to drive the hover-pair
 *  highlight. */
function computePairMap(entries: readonly WireEntry[]): Map<string, PairRecord> {
  const map = new Map<string, PairRecord>();
  const ensure = (id: string): PairRecord => {
    const existing = map.get(id);
    if (existing) return existing;
    const fresh: PairRecord = { callLineNo: null, resultLineNo: null, callTime: null, resultTime: null };
    map.set(id, fresh);
    return fresh;
  };
  for (const entry of entries) {
    if (entry.data.type !== 'context.append_loop_event') continue;
    const ev = entry.data.event;
    const time = entry.data.time ?? null;
    if (ev.type === 'tool.call') {
      const rec = ensure(ev.toolCallId);
      rec.callLineNo = entry.lineNo;
      rec.callTime = time;
    } else if (ev.type === 'tool.result') {
      const rec = ensure(ev.toolCallId);
      rec.resultLineNo = entry.lineNo;
      rec.resultTime = time;
    }
  }
  return map;
}

function pairInfoFor(record: AgentRecord, map: Map<string, PairRecord>): PairHint | undefined {
  if (record.type !== 'context.append_loop_event') return undefined;
  const ev = record.event;
  if (ev.type !== 'tool.call' && ev.type !== 'tool.result') return undefined;
  const entry = map.get(ev.toolCallId);
  if (entry === undefined) return undefined;
  const durationMs =
    entry.callTime !== null && entry.resultTime !== null ? entry.resultTime - entry.callTime : null;
  return {
    toolCallId: ev.toolCallId,
    kind: ev.type === 'tool.call' ? 'call' : 'result',
    callLineNo: entry.callLineNo,
    resultLineNo: entry.resultLineNo,
    durationMs,
  };
}

interface WireTabProps {
  sessionId: string;
  /** Override starting agentId; defaults to 'main'. */
  initialAgentId?: string;
}

export function WireTab({ sessionId, initialAgentId = 'main' }: WireTabProps) {
  const [agentId, setAgentId] = useState<string>(initialAgentId);
  // Re-sync when the route changes either the session or the agent id
  // while this component stays mounted. Without `sessionId` in the deps,
  // navigating /sessions/A → /sessions/B (with default initialAgentId)
  // would preserve a subagent selection from the previous session and
  // 404 on the new one.
  useEffect(() => {
    setAgentId(initialAgentId);
  }, [sessionId, initialAgentId]);
  const { data: detail } = useSession(sessionId);
  const { data: wire, isLoading, error } = useWire(sessionId, agentId);
  const parentRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hoveredPairId, setHoveredPairId] = useState<string | null>(null);

  const entries: WireEntry[] = useMemo(() => {
    return (wire?.records ?? []) as WireEntry[];
  }, [wire?.records]);
  const warnings = wire?.warnings ?? [];

  const pairMap = useMemo(() => computePairMap(entries), [entries]);
  // Precompute the per-entry PairHint so the object identity is stable
  // across hover state changes. Without this, every hover would create
  // fresh pair objects and bust WireRow's memo for every tool row.
  const pairByLineNo = useMemo(() => {
    const m = new Map<number, PairHint>();
    for (const entry of entries) {
      const p = pairInfoFor(entry.data, pairMap);
      if (p !== undefined) m.set(entry.lineNo, p);
    }
    return m;
  }, [entries, pairMap]);
  const onHoverPair = useCallback((id: string | null) => {
    setHoveredPairId(id);
  }, []);

  const filtered = useMemo(() => {
    if (search.length === 0) return entries;
    const needle = search.toLowerCase();
    return entries.filter((e) => {
      if (e.data.type.toLowerCase().includes(needle)) return true;
      try {
        return JSON.stringify(e.data).toLowerCase().includes(needle);
      } catch {
        return false;
      }
    });
  }, [entries, search]);

  const issues = useMemo(() => computeIssues(entries, warnings), [entries, warnings]);
  const issuesSeverity = topSeverity(issues);

  const virt = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (i) => filtered[i]?.lineNo ?? i,
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
      const e = filtered[i];
      if (e !== undefined) m.set(e.lineNo, i);
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
    setExpanded(new Set(filtered.map((e) => e.lineNo)));
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
            {filtered.length} / {entries.length} ev
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
                const e = filtered[vi.index];
                if (!e) return null;
                const pair = pairByLineNo.get(e.lineNo);
                const highlighted =
                  pair !== undefined && hoveredPairId === pair.toolCallId;
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
                      entry={e}
                      expanded={expanded.has(e.lineNo)}
                      onToggle={() => {
                        toggle(e.lineNo);
                      }}
                      onJumpTo={jumpToLine}
                      pair={pair}
                      highlighted={highlighted}
                      onHoverPair={onHoverPair}
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
