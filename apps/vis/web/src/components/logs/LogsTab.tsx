import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';

import { useLogs } from '../../hooks/useTasks';
import type { LogLine } from '../../types';
import { formatWallClock } from '../../util/time';
import { Pill, type PillTone } from '../shared/Pill';

interface LogsTabProps {
  sessionId: string;
}

function levelTone(level: string | null): PillTone {
  switch (level) {
    case 'ERROR':
    case 'FATAL':
      return 'error';
    case 'WARN':
    case 'WARNING':
      return 'warning';
    case 'INFO':
      return 'info';
    case 'DEBUG':
    case 'TRACE':
      return 'meta';
    default:
      return 'neutral';
  }
}

const LEVELS = ['ALL', 'ERROR', 'WARN', 'INFO', 'DEBUG'] as const;
type LevelFilter = (typeof LEVELS)[number];

function matchesLevel(line: LogLine, filter: LevelFilter): boolean {
  if (filter === 'ALL') return true;
  if (line.level === null) return false;
  if (filter === 'WARN') return line.level === 'WARN' || line.level === 'WARNING';
  if (filter === 'ERROR') return line.level === 'ERROR' || line.level === 'FATAL';
  return line.level === filter;
}

/** Logs tab — structured view of a session's diagnostic log. Works for both
 *  local sessions (whose dir holds `logs/kimi-code.log`) and imported bundles
 *  (which additionally may carry the global log). */
export function LogsTab({ sessionId }: LogsTabProps) {
  const [which, setWhich] = useState<'session' | 'global'>('session');
  const [level, setLevel] = useState<LevelFilter>('ALL');
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useLogs(sessionId, which);
  const parentRef = useRef<HTMLDivElement>(null);

  const lines = data?.lines ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lines.filter((l) => {
      if (!matchesLevel(l, level)) return false;
      if (!q) return true;
      return l.raw.toLowerCase().includes(q);
    });
  }, [lines, level, search]);

  const virt = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 20,
    getItemKey: (i) => filtered[i]?.lineNo ?? i,
  });

  const available = data?.available ?? { session: false, global: false };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface-1 px-3 py-2">
        <div className="flex items-center gap-1 font-mono text-[11px]">
          <SegBtn active={which === 'session'} onClick={() => { setWhich('session'); }} disabled={!available.session && !isLoading}>
            session
          </SegBtn>
          <SegBtn active={which === 'global'} onClick={() => { setWhich('global'); }} disabled={!available.global}>
            global
          </SegBtn>
        </div>
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-fg-2">
          <span className="text-fg-3">level</span>
          <select
            value={level}
            onChange={(e) => { setLevel(e.target.value as LevelFilter); }}
            className="border border-border bg-surface-0 px-1 py-0.5 text-fg-1 focus:border-border-strong focus:outline-none"
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l.toLowerCase()}</option>
            ))}
          </select>
        </label>
        <input
          type="text"
          placeholder="search log (substring)"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          className="w-64 border border-border bg-surface-0 px-2 py-1 font-mono text-[12px] text-fg-0 placeholder:text-fg-3 focus:border-border-strong focus:outline-none"
        />
        <span className="ml-auto font-mono text-[11px] text-fg-3 tabular">
          {filtered.length} / {lines.length}
          {data?.truncated ? ' · tail' : ''}
        </span>
      </div>

      {isLoading ? (
        <div className="p-6 font-mono text-[12px] text-fg-3">loading log…</div>
      ) : error ? (
        <div className="p-6 font-mono text-[12px] text-[var(--color-sev-error)]">{error.message}</div>
      ) : lines.length === 0 ? (
        <div className="p-6 font-mono text-[12px] text-fg-3">
          {which === 'global' && !available.global
            ? 'no global log in this bundle (export without --include-global-log)'
            : 'no log available for this session'}
        </div>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
          {data?.truncated ? (
            <div className="border-b border-[var(--color-sev-warning)] bg-[color-mix(in_oklab,var(--color-sev-warning)_8%,transparent)] px-3 py-1 font-mono text-[10px] text-[var(--color-sev-warning)]">
              log is large — showing the most recent {lines.length} lines
            </div>
          ) : null}
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const line = filtered[vi.index];
              if (!line) return null;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virt.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  <LogRow line={line} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SegBtn({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: import('react').ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'border px-2 py-0.5',
        active ? 'border-[var(--color-cat-conversation)] text-fg-0' : 'border-border text-fg-2 hover:text-fg-0',
        disabled ? 'opacity-40' : '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const fieldKeys = Object.keys(line.fields);
  return (
    <div className="flex items-start gap-2 border-b border-border/40 px-3 py-[3px] font-mono text-[11px] hover:bg-surface-1">
      <span className="w-[68px] shrink-0 text-fg-3 tabular" title={line.time ?? ''}>
        {line.time ? formatWallClock(Date.parse(line.time)) : '—'}
      </span>
      <span className="w-[52px] shrink-0">
        {line.level ? (
          <Pill tone={levelTone(line.level)} variant="outline">{line.level}</Pill>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 break-words text-fg-1">
        {line.message}
        {fieldKeys.length > 0 ? (
          <span className="ml-2 text-fg-3">
            {fieldKeys.map((k) => (
              <span key={k} className="mr-2">
                <span className="text-fg-2">{k}</span>=<span className="text-[var(--color-sev-info)]">{line.fields[k]}</span>
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}
