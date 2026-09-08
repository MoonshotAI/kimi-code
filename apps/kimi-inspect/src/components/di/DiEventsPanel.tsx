/**
 * DI Events panel — event-subscription introspection
 * (`IDebugEventsService.subscriptions`), two merged sides:
 *
 *   - Subscriptions: the unit-book side — every materialized unit's ledger
 *     entries labeled as an event subscription (`on:<name>` from a named
 *     Emitter or the fiber `on` capability, `disposable:EventSubscription`
 *     from an unnamed one), grouped by scope path;
 *   - Bus listeners: the emitter-side fallback — per-`IEventBus` listener
 *     counts (`*` = the full stream) plus the global `IEventService` count,
 *     which also cover subscriptions never registered on a unit book.
 *
 * Pure React + Tailwind.
 */
import type {
  DebugEventBusSnapshot,
  DebugEventSubscription,
  DebugEventSubscriptions,
} from '@moonshot-ai/agent-core-v2/features/debugEvents/debugEvents';

import { Badge } from '../../ui';

const KIND_TONES: Record<DebugEventSubscription['kind'], 'neutral' | 'sky' | 'violet'> = {
  disposer: 'neutral',
  effect: 'sky',
  ledger: 'violet',
};

export function DiEventsPanel({ data }: { data: DebugEventSubscriptions }) {
  const groups = groupByScope(data.subscriptions);
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-wider text-neutral-600 uppercase">
        subscriptions ({data.subscriptions.length})
      </div>
      {groups.length === 0 ? (
        <div className="mb-4 text-[11px] text-neutral-600 italic">
          no event subscriptions on any unit book
        </div>
      ) : (
        groups.map(([scopePath, subs]) => (
          <div
            key={scopePath}
            className="mb-2 rounded-lg border border-neutral-800 bg-neutral-900/60"
          >
            <div className="border-b border-neutral-800/60 px-3 py-2">
              <span className="font-mono text-[11px] text-neutral-200">{scopePath}</span>
              <span className="ml-2 text-[10px] text-neutral-600">{subs.length}</span>
            </div>
            <div className="px-3 py-2">
              {subs.map((sub, i) => (
                <div
                  key={`${sub.unit}:${sub.label}:${i}`}
                  className="mb-1 flex items-center gap-2 rounded border border-neutral-800/70 bg-neutral-950/40 px-2 py-1.5"
                >
                  <span
                    className="min-w-0 truncate font-mono text-[11px] text-neutral-200"
                    title={sub.unit}
                  >
                    {sub.unit}
                  </span>
                  {sub.uid !== undefined ? (
                    <span className="shrink-0 text-[10px] text-neutral-600">#{sub.uid}</span>
                  ) : null}
                  <span
                    className="shrink-0 font-mono text-[10px] text-sky-400"
                    title={sub.label}
                  >
                    {sub.label}
                  </span>
                  <span className="ml-auto shrink-0">
                    <Badge tone={KIND_TONES[sub.kind]}>{sub.kind}</Badge>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <div className="mt-4 mb-1 text-[10px] font-semibold tracking-wider text-neutral-600 uppercase">
        bus listeners
      </div>
      {data.buses.length === 0 && data.globalListeners === undefined ? (
        <div className="text-[11px] text-neutral-600 italic">no materialized event buses</div>
      ) : (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2">
          {data.globalListeners !== undefined ? (
            <BusRow scopePath="app" type="eventService (global)" count={data.globalListeners} />
          ) : null}
          {data.buses.flatMap((bus) => busRows(bus))}
        </div>
      )}
    </div>
  );
}

function groupByScope(
  subs: readonly DebugEventSubscription[],
): [string, DebugEventSubscription[]][] {
  const map = new Map<string, DebugEventSubscription[]>();
  for (const sub of subs) {
    const group = map.get(sub.scopePath) ?? [];
    group.push(sub);
    map.set(sub.scopePath, group);
  }
  return [...map.entries()];
}

function busRows(bus: DebugEventBusSnapshot) {
  const rows = [
    <BusRow key={`${bus.scopePath}:*`} scopePath={bus.scopePath} type="*" count={bus.all} />,
  ];
  for (const type of Object.keys(bus.perType).toSorted()) {
    rows.push(
      <BusRow
        key={`${bus.scopePath}:${type}`}
        scopePath={bus.scopePath}
        type={type}
        count={bus.perType[type] ?? 0}
      />,
    );
  }
  return rows;
}

function BusRow({
  scopePath,
  type,
  count,
}: {
  scopePath: string;
  type: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="min-w-0 truncate font-mono text-[10px] text-neutral-500" title={scopePath}>
        {scopePath}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-neutral-200" title={type}>
        {type}
      </span>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-neutral-400">{count}</span>
    </div>
  );
}
