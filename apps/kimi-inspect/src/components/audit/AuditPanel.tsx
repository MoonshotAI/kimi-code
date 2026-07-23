/**
 * Audit side panel for the chat view: replays how the visible
 * `TranscriptChatStore` was built, entry by entry.
 *
 *  - Timeline (draggable slider + entry list): every REST page load, WS
 *    frame (`transcript.ops` / `transcript.reset`), loss signal, and user
 *    action the channel processed, with its timestamp.
 *  - Detail tabs for the selected entry: `Diff` (structural diff vs the
 *    previous entry — added/modified/removed colored), `State` (the full
 *    store state at that point, goal/plan/todos included), `Event` (the
 *    raw REST request/response or WS payload).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { EMPTY_AGENT_STATE } from '@moonshot-ai/transcript';

import { diffValue, type DiffNode } from '../../audit/diff';
import { serializeState } from '../../audit/serialize';
import { tailTrunc } from '../../audit/truncate';
import type { AuditEntry, AuditTrail } from '../../audit/trail';
import { Badge } from '../../ui';
import { plainNode, StateTree } from './StateTree';

const KIND_TONE: Record<AuditEntry['kind'], 'sky' | 'green' | 'violet' | 'neutral'> = {
  rest: 'sky',
  ops: 'green',
  reset: 'violet',
  event: 'neutral',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const base = d.toLocaleTimeString('en-GB', { hour12: false });
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Raw payload view: full JSON, with long strings tail-truncated. */
function EventJson({ entry }: { entry: AuditEntry }) {
  const payload = useMemo(() => {
    switch (entry.kind) {
      case 'rest':
        return { request: entry.request, appliedAs: entry.appliedAs, response: entry.page };
      case 'ops':
        return { envelopeAt: entry.envelopeAt, delivery: entry.delivery, ops: entry.ops };
      case 'reset':
        return {
          envelopeAt: entry.envelopeAt,
          hasMoreOlder: entry.hasMoreOlder,
          snapshot: entry.snapshot,
        };
      case 'event':
        return { event: entry.event, detail: entry.detail };
    }
  }, [entry]);
  const text = JSON.stringify(
    payload,
    (_key, value: unknown) => (typeof value === 'string' ? tailTrunc(value) : value),
    2,
  );
  return (
    <pre className="p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-neutral-300">
      {text}
    </pre>
  );
}

export function AuditPanel({ trail }: { trail: AuditTrail }) {
  const entries = useSyncExternalStore(trail.subscribe, () => trail.getEntries());
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [tab, setTab] = useState<'diff' | 'state' | 'event'>('diff');
  const listRef = useRef<HTMLDivElement>(null);

  const current: AuditEntry | undefined =
    entries.find((entry) => entry.index === selectedIndex) ?? entries.at(-1);
  const currentPos = current !== undefined ? entries.indexOf(current) : -1;

  // Follow-latest: jump to (and scroll to) the newest entry as it lands.
  useEffect(() => {
    if (!follow || entries.length === 0) return;
    setSelectedIndex(entries.at(-1)!.index);
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [entries, follow]);

  const root: DiffNode | null = useMemo(() => {
    if (current === undefined || tab === 'event') return null;
    if (tab === 'state') return plainNode(serializeState(current.state));
    const prevState = currentPos > 0 ? (entries[currentPos - 1]?.state ?? EMPTY_AGENT_STATE) : EMPTY_AGENT_STATE;
    return diffValue(serializeState(prevState), serializeState(current.state));
  }, [current, currentPos, entries, tab]);

  return (
    <div className="flex w-[460px] shrink-0 flex-col border-l border-neutral-800">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <span className="text-[12px] font-medium text-neutral-200">Transcript audit</span>
        <Badge tone="neutral">{entries.length} entries</Badge>
      </div>

      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <input
          type="range"
          className="min-w-0 flex-1 accent-sky-500"
          min={0}
          max={Math.max(0, entries.length - 1)}
          value={Math.max(0, currentPos)}
          disabled={entries.length === 0}
          onChange={(e) => {
            const pos = Number(e.target.value);
            const entry = entries[pos];
            if (entry === undefined) return;
            setFollow(pos === entries.length - 1);
            setSelectedIndex(entry.index);
          }}
        />
        <label className="flex items-center gap-1 text-[10px] text-neutral-500 select-none">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="accent-sky-500"
          />
          follow
        </label>
      </div>

      <div ref={listRef} className="h-56 shrink-0 overflow-y-auto border-b border-neutral-800">
        {entries.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-neutral-600 italic">
            Nothing recorded yet — the initial transcript load is still running.
          </div>
        ) : null}
        {entries.map((entry, pos) => (
          <div
            key={entry.index}
            className={`flex cursor-pointer items-center gap-2 px-3 py-1 text-[11px] hover:bg-neutral-800/70 ${
              entry.index === current?.index ? 'bg-sky-950/50' : ''
            }`}
            onClick={() => {
              setFollow(pos === entries.length - 1);
              setSelectedIndex(entry.index);
            }}
          >
            <span className="w-8 shrink-0 font-mono text-neutral-600">#{entry.index}</span>
            <span className="shrink-0 font-mono text-neutral-500">{fmtTime(entry.at)}</span>
            <Badge tone={KIND_TONE[entry.kind]}>{entry.kind}</Badge>
            <span className="min-w-0 truncate text-neutral-400" title={entry.summary}>
              {entry.summary}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 border-b border-neutral-800 px-3 py-1.5">
        {(['diff', 'state', 'event'] as const).map((name) => (
          <button
            key={name}
            className={`rounded px-2 py-0.5 text-[11px] ${
              tab === name
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => setTab(name)}
          >
            {name === 'diff' ? 'Diff vs prev' : name === 'state' ? 'State' : 'Event'}
          </button>
        ))}
        {current !== undefined ? (
          <span className="ml-auto font-mono text-[10px] text-neutral-600">
            entry #{current.index}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {current === undefined ? (
          <div className="px-1 py-2 text-[11px] text-neutral-600 italic">No entry selected.</div>
        ) : tab === 'event' ? (
          <EventJson entry={current} />
        ) : root !== null ? (
          <StateTree root={root} defaultDepth={tab === 'state' ? 2 : 0} />
        ) : null}
      </div>
    </div>
  );
}
