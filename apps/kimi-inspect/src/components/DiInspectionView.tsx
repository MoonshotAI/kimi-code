/**
 * DI view — the engine's "Service × Effect × DI" debug surface (the App-scope
 * `debug` domain, exposed like every other Service over `/api/v1/debug`):
 *
 *   - Units: the unit tree = ledger tree (`IDebugLedgerService.tree`) — one
 *     collapsible card per scope container, its units with the five-state
 *     cascade badge and the unprovide / update / dispose triggers
 *     (`IDebugCascadeService`), its ledger entries as a nested subtree;
 *   - Deps: the persistent dependency DAG (`IDebugGraphService.graph`) as
 *     root-based Miller columns (`di/DiGraphPanel.tsx`) — column 0 lists the
 *     roots (services nothing consumes), each click opens the next column
 *     with that service's direct dependencies; rows carry path-scoped
 *     relation bars (one per path ancestor with a direct edge) and a
 *     path-root background highlight;
 *   - Events: event subscriptions (`IDebugEventsService.subscriptions`) —
 *     unit-book ledger entries labeled `on:<name>` /
 *     `disposable:EventSubscription` per scope, plus per-bus listener counts
 *     as the fallback side (`di/DiEventsPanel.tsx`);
 *   - Cascade: the cross-scope cascade history rings
 *     (`IDebugCascadeService.history`), newest first;
 *   - Pending: the waiting area + sticky failures per scope
 *     (`IDebugCascadeService.pending`), with an `update` retry per failure.
 *
 * All five panels poll on a short interval and refresh eagerly when the
 * global `event.di.unit_changed` WS frame fires (`useDiQueryInvalidation`
 * invalidates the `['di']` query prefix).
 */

import type { UnitState } from '@moonshot-ai/agent-core-v2/_base/di/cascadeEngine';
import type { LedgerEntryInfo } from '@moonshot-ai/agent-core-v2/_base/lifecycle/ledger';
import {
  IDebugCascadeService,
  type DebugCascadeEntry,
  type DebugPendingGroup,
} from '@moonshot-ai/agent-core-v2/debug/debugCascade';
import { IDebugGraphService, type DebugGraph } from '@moonshot-ai/agent-core-v2/debug/debugGraph';
import {
  IDebugEventsService,
  type DebugEventSubscriptions,
} from '@moonshot-ai/agent-core-v2/features/debugEvents/debugEvents';
import {
  IDebugLedgerService,
  type DebugLedgerNode,
  type DebugUnit,
} from '@moonshot-ai/agent-core-v2/debug/debugLedger';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { useDiQueryInvalidation } from '../activity/di';
import type { InspectClient } from '../channel';
import { useConnection } from '../connection';
import { ActionButton, Badge, ErrorLine } from '../ui';
import { DiEventsPanel } from './di/DiEventsPanel';
import { DiGraphPanel } from './di/DiGraphPanel';

type DiPanel = 'units' | 'graph' | 'events' | 'cascade' | 'pending';

const PANELS: readonly { id: DiPanel; title: string }[] = [
  { id: 'units', title: 'Units' },
  { id: 'graph', title: 'Deps' },
  { id: 'events', title: 'Events' },
  { id: 'cascade', title: 'Cascade' },
  { id: 'pending', title: 'Pending' },
];

const REFETCH_INTERVAL_MS = 3000;

export function DiInspectionView() {
  useDiQueryInvalidation();
  const [panel, setPanel] = useState<DiPanel>('units');
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <nav className="w-32 shrink-0 border-r border-neutral-800 py-2">
        <div className="px-3 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          DI
        </div>
        {PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setPanel(p.id);
            }}
            className={`block w-full px-3 py-1 text-left text-[11px] transition-colors ${
              panel === p.id
                ? 'bg-neutral-800 text-sky-400'
                : 'text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300'
            }`}
          >
            {p.title}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto px-4 py-3">
        {panel === 'units' ? (
          <UnitsPanel />
        ) : panel === 'graph' ? (
          <GraphPanel />
        ) : panel === 'events' ? (
          <EventsPanel />
        ) : panel === 'cascade' ? (
          <CascadePanel />
        ) : (
          <PendingPanel />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared data plumbing
// ---------------------------------------------------------------------------

function useDiQuery<T>(panel: string, fetcher: (klient: InspectClient) => Promise<T>) {
  const { klient } = useConnection();
  return useQuery({
    queryKey: ['di', klient.baseUrl, panel],
    queryFn: () => fetcher(klient),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
}

/** The loading / error gate shared by every panel. Returns null when data is ready. */
function panelGate(query: { isError: boolean; error: unknown; data: unknown }): ReactNode | null {
  if (query.isError) return <ErrorLine error={query.error} />;
  if (query.data === undefined) {
    return <div className="text-[11px] text-neutral-600 italic">loading…</div>;
  }
  return null;
}

type DiTriggerAction = 'unprovide' | 'update' | 'dispose';

interface DiTrigger {
  /** `${action}:${scopePath}:${token}` of the in-flight trigger, if any. */
  readonly busy: string | null;
  readonly error: unknown;
  readonly run: (action: DiTriggerAction, scopePath: string, token: string) => Promise<void>;
}

function triggerKey(action: DiTriggerAction, scopePath: string, token: string): string {
  return `${action}:${scopePath}:${token}`;
}

/**
 * The destructive unit triggers (`IDebugCascadeService.unprovide` / `update`
 * / `dispose`), confirm-gated like the ServiceCard danger actions; a settled
 * trigger invalidates the `['di']` prefix so every panel converges.
 */
function useDiTrigger(): DiTrigger {
  const { klient } = useConnection();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = async (action: DiTriggerAction, scopePath: string, token: string): Promise<void> => {
    if (!window.confirm(`${action} '${token}' @ ${scopePath}?`)) return;
    setBusy(triggerKey(action, scopePath, token));
    setError(null);
    try {
      const svc = klient.core(IDebugCascadeService);
      if (action === 'unprovide') await svc.unprovide(scopePath, token);
      else if (action === 'update') await svc.update(scopePath, token);
      else await svc.dispose(scopePath, token);
      await queryClient.invalidateQueries({ queryKey: ['di'] });
    } catch (error) {
      setError(error);
    } finally {
      setBusy(null);
    }
  };

  return { busy, error, run };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Units panel — the unit tree = ledger tree
// ---------------------------------------------------------------------------

const STATE_TONES: Record<UnitState, 'neutral' | 'sky' | 'green' | 'amber' | 'red'> = {
  Pending: 'neutral',
  Activating: 'sky',
  Active: 'green',
  Unloading: 'amber',
  Failed: 'red',
};

function UnitStateBadge({ state }: { state?: UnitState }) {
  if (state === undefined) return <Badge tone="neutral">unseen</Badge>;
  return <Badge tone={STATE_TONES[state]}>{state}</Badge>;
}

function UnitsPanel() {
  const query = useDiQuery('units', (klient) => klient.core(IDebugLedgerService).tree());
  const trigger = useDiTrigger();
  const gate = panelGate(query);
  if (gate !== null) return gate;
  const tree = query.data as DebugLedgerNode;
  return (
    <div>
      {trigger.error !== null ? (
        <div className="mb-2">
          <ErrorLine error={trigger.error} />
        </div>
      ) : null}
      <ScopeNodeCard node={tree} depth={0} trigger={trigger} />
    </div>
  );
}

function ScopeNodeCard({
  node,
  depth,
  trigger,
}: {
  node: DebugLedgerNode;
  depth: number;
  trigger: DiTrigger;
}) {
  const [open, setOpen] = useState(depth < 2);
  const counts = new Map<UnitState, number>();
  for (const unit of node.units) {
    if (unit.state === undefined) continue;
    counts.set(unit.state, (counts.get(unit.state) ?? 0) + 1);
  }
  return (
    <div className={depth === 0 ? '' : 'ml-3 border-l border-neutral-800/60 pl-2'}>
      <div className="mb-2 rounded-lg border border-neutral-800 bg-neutral-900/60">
        <div
          className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none"
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          <span className="shrink-0 text-[10px] text-neutral-600">{open ? '▾' : '▸'}</span>
          <span className="shrink-0 text-[12px] font-medium text-neutral-200">{node.label}</span>
          <span
            className="min-w-0 truncate font-mono text-[10px] text-neutral-600"
            title={node.path}
          >
            {node.path}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <span className="text-[10px] text-neutral-600">{node.units.length} units</span>
            {[...counts.entries()].map(([state, count]) => (
              <Badge key={state} tone={STATE_TONES[state]}>
                {count} {state}
              </Badge>
            ))}
          </span>
        </div>
        {open ? (
          <div className="border-t border-neutral-800/60 px-3 py-2">
            {node.units.length === 0 ? (
              <div className="text-[11px] text-neutral-600 italic">no units</div>
            ) : (
              node.units.map((unit) => (
                <UnitRow key={unit.token} scopePath={node.path} unit={unit} trigger={trigger} />
              ))
            )}
            <LedgerSection entries={node.ledger} />
          </div>
        ) : null}
      </div>
      {open
        ? node.children.map((child) => (
            <ScopeNodeCard key={child.path} node={child} depth={depth + 1} trigger={trigger} />
          ))
        : null}
    </div>
  );
}

function UnitRow({
  scopePath,
  unit,
  trigger,
}: {
  scopePath: string;
  unit: DebugUnit;
  trigger: DiTrigger;
}) {
  const [errorOpen, setErrorOpen] = useState(false);
  const actions: readonly DiTriggerAction[] = ['unprovide', 'update', 'dispose'];
  return (
    <div className="mb-1 rounded border border-neutral-800/70 bg-neutral-950/40 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 truncate font-mono text-[11px] text-neutral-200"
          title={unit.token}
        >
          {unit.token}
        </span>
        <span title={unit.everActive === undefined ? '' : `everActive: ${unit.everActive}`}>
          <UnitStateBadge state={unit.state} />
        </span>
        {unit.inFlight === true ? <Badge tone="sky">in-flight</Badge> : null}
        <span className="shrink-0 text-[10px] text-neutral-600">#{unit.uid}</span>
        {unit.error !== undefined ? (
          <button
            type="button"
            className="shrink-0 text-[10px] text-red-400 hover:text-red-300"
            onClick={() => {
              setErrorOpen((v) => !v);
            }}
          >
            error {errorOpen ? '▾' : '▸'}
          </button>
        ) : null}
        <span className="ml-auto flex shrink-0 gap-1">
          {actions.map((action) => (
            <ActionButton
              key={action}
              danger
              disabled={trigger.busy !== null}
              onClick={() => void trigger.run(action, scopePath, unit.token)}
            >
              {trigger.busy === triggerKey(action, scopePath, unit.token) ? '…' : action}
            </ActionButton>
          ))}
        </span>
      </div>
      {errorOpen && unit.error !== undefined ? (
        <pre className="mt-1 overflow-auto rounded bg-red-950/40 p-1.5 font-mono text-[10px] break-words whitespace-pre-wrap text-red-300">
          {unit.error}
        </pre>
      ) : null}
    </div>
  );
}

const LEDGER_KIND_TONES: Record<LedgerEntryInfo['kind'], 'neutral' | 'sky' | 'violet'> = {
  disposer: 'neutral',
  effect: 'sky',
  ledger: 'violet',
};

function LedgerSection({ entries }: { entries: readonly LedgerEntryInfo[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        className="text-[10px] text-neutral-500 select-none hover:text-neutral-300"
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        {open ? '▾' : '▸'} ledger ({entries.length})
      </button>
      {open ? (
        <div className="mt-1 border-l border-neutral-800/60 pl-2">
          {entries.map((entry, i) => (
            <LedgerEntryRow key={i} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LedgerEntryRow({ entry }: { entry: LedgerEntryInfo }) {
  return (
    <div className="py-0.5">
      <span className="font-mono text-[10px] text-neutral-400" title={entry.stack}>
        {entry.label}
      </span>
      <span className="ml-1.5">
        <Badge tone={LEDGER_KIND_TONES[entry.kind]}>{entry.kind}</Badge>
      </span>
      {entry.children !== undefined && entry.children.length > 0 ? (
        <div className="ml-2 border-l border-neutral-800/60 pl-2">
          {entry.children.map((child, i) => (
            <LedgerEntryRow key={i} entry={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph panel — the dependency DAG; rendering lives in di/DiGraphPanel.tsx
// ---------------------------------------------------------------------------

function GraphPanel() {
  const query = useDiQuery('graph', (klient) => klient.core(IDebugGraphService).graph());
  const gate = panelGate(query);
  if (gate !== null) return gate;
  return <DiGraphPanel graph={query.data as DebugGraph} />;
}

// ---------------------------------------------------------------------------
// Events panel — event subscriptions; rendering lives in di/DiEventsPanel.tsx
// ---------------------------------------------------------------------------

function EventsPanel() {
  const query = useDiQuery('events', (klient) =>
    klient.core(IDebugEventsService).subscriptions(),
  );
  const gate = panelGate(query);
  if (gate !== null) return gate;
  return <DiEventsPanel data={query.data as DebugEventSubscriptions} />;
}

// ---------------------------------------------------------------------------
// Cascade panel — the cross-scope cascade history rings, newest first
// ---------------------------------------------------------------------------

function CascadePanel() {
  const query = useDiQuery('cascade', (klient) => klient.core(IDebugCascadeService).history());
  const gate = panelGate(query);
  if (gate !== null) return gate;
  // seq is a per-engine ring sequence; cross-scope ordering is approximate.
  const entries = (query.data as DebugCascadeEntry[]).toReversed();
  if (entries.length === 0) {
    return <div className="text-[11px] text-neutral-600 italic">no cascade transactions yet</div>;
  }
  return (
    <div>
      {entries.map((entry, i) => (
        <CascadeEntryCard key={`${entry.scopePath}:${entry.seq}:${i}`} entry={entry} />
      ))}
    </div>
  );
}

function CascadeEntryCard({ entry }: { entry: DebugCascadeEntry }) {
  const [open, setOpen] = useState(false);
  const expandable =
    entry.failed.length > 0 || entry.affected.length > 0 || entry.tornDown.length > 0;
  return (
    <div className="mb-2 rounded border border-neutral-800 bg-neutral-900/60">
      <div
        className={`flex items-center gap-2 px-2 py-1.5 ${expandable ? 'cursor-pointer select-none' : ''}`}
        onClick={
          expandable
            ? () => {
                setOpen((v) => !v);
              }
            : undefined
        }
      >
        <span className="shrink-0 font-mono text-[11px] text-neutral-200">#{entry.seq}</span>
        <span className="shrink-0 font-mono text-[10px] text-neutral-500" title={entry.scopePath}>
          {truncate(entry.scopePath, 40)}
        </span>
        {entry.abortWaited ? <Badge tone="amber">abort waited</Badge> : null}
        {entry.abortTimedOut ? <Badge tone="red">abort timed out</Badge> : null}
        {entry.failed.length > 0 ? <Badge tone="red">{entry.failed.length} failed</Badge> : null}
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-400" title={entry.reason}>
          {entry.reason}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-600">{entry.durationMs}ms</span>
        {expandable ? (
          <span className="shrink-0 text-[10px] text-neutral-600">{open ? '▾' : '▸'}</span>
        ) : null}
      </div>
      <div className="border-t border-neutral-800/60 px-2 py-1.5">
        <div className="flex flex-wrap gap-1">
          {entry.changes.map((change, i) => (
            <span
              key={i}
              className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300"
              title={change.token}
            >
              {change.action} {truncate(change.token, 48)}
            </span>
          ))}
        </div>
        <div className="mt-1 text-[10px] text-neutral-500">
          affected {entry.affected.length} · torn down {entry.tornDown.length} · rebuilt{' '}
          {entry.rebuilt.length} · failed {entry.failed.length}
        </div>
        {open ? (
          <div className="mt-1.5 space-y-1">
            {entry.affected.length > 0 ? (
              <TokenList label="affected" tokens={entry.affected} />
            ) : null}
            {entry.tornDown.length > 0 ? (
              <TokenList label="torn down" tokens={entry.tornDown} />
            ) : null}
            {entry.failed.length > 0 ? (
              <TokenList label="failed" tokens={entry.failed} danger />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TokenList({
  label,
  tokens,
  danger,
}: {
  label: string;
  tokens: readonly string[];
  danger?: boolean;
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {tokens.map((token, i) => (
          <span
            key={i}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
              danger === true ? 'bg-red-950/60 text-red-300' : 'bg-neutral-800 text-neutral-300'
            }`}
            title={token}
          >
            {truncate(token, 64)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending panel — the waiting area + sticky failures per scope
// ---------------------------------------------------------------------------

function PendingPanel() {
  const query = useDiQuery('pending', (klient) => klient.core(IDebugCascadeService).pending());
  const trigger = useDiTrigger();
  const gate = panelGate(query);
  if (gate !== null) return gate;
  const groups = query.data as DebugPendingGroup[];
  return (
    <div>
      {trigger.error !== null ? (
        <div className="mb-2">
          <ErrorLine error={trigger.error} />
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div className="text-[11px] text-neutral-600 italic">no waiting or failed units</div>
      ) : (
        groups.map((group) => (
          <div
            key={group.scopePath}
            className="mb-2 rounded-lg border border-neutral-800 bg-neutral-900/60"
          >
            <div className="border-b border-neutral-800/60 px-3 py-2">
              <span className="font-mono text-[11px] text-neutral-200">{group.scopePath}</span>
            </div>
            <div className="px-3 py-2">
              {group.waiting.length > 0 ? (
                <div className="mb-2">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                    waiting ({group.waiting.length})
                  </div>
                  {group.waiting.map((unit) => (
                    <div
                      key={unit.token}
                      className="mb-1 flex items-center gap-2 rounded border border-neutral-800/70 bg-neutral-950/40 px-2 py-1.5"
                    >
                      <span
                        className="min-w-0 truncate font-mono text-[11px] text-neutral-200"
                        title={unit.token}
                      >
                        {unit.token}
                      </span>
                      <span className="shrink-0 text-[10px] text-neutral-600">missing:</span>
                      <span className="flex min-w-0 flex-wrap gap-1">
                        {unit.missing.map((dep, i) => (
                          <span
                            key={i}
                            className="rounded bg-amber-950/60 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
                            title={dep}
                          >
                            {truncate(dep, 48)}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {group.failed.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                    failed ({group.failed.length})
                  </div>
                  {group.failed.map((unit) => (
                    <div
                      key={unit.token}
                      className="mb-1 rounded border border-red-900/50 bg-red-950/20 px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="min-w-0 truncate font-mono text-[11px] text-neutral-200"
                          title={unit.token}
                        >
                          {unit.token}
                        </span>
                        <span className="ml-auto shrink-0">
                          <ActionButton
                            danger
                            disabled={trigger.busy !== null}
                            onClick={() => void trigger.run('update', group.scopePath, unit.token)}
                          >
                            {trigger.busy === triggerKey('update', group.scopePath, unit.token)
                              ? '…'
                              : 'retry update'}
                          </ActionButton>
                        </span>
                      </div>
                      {unit.error !== undefined ? (
                        <pre className="mt-1 overflow-auto rounded bg-red-950/40 p-1.5 font-mono text-[10px] break-words whitespace-pre-wrap text-red-300">
                          {unit.error}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
