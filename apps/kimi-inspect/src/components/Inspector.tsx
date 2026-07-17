/**
 * Right sidebar — access point for the Services of the server (app scope),
 * the active session, and the active agent. Hosts the agent switcher, four
 * tabs (app / session / agent / events), the live pending-interaction card
 * (driven by the session `interactions` stream), and the Service panels.
 *
 * The panel list is dynamic: `GET /api/v2/channels` describes every
 * wire-exposed Service with its methods, rendered by `DynamicServiceCard`;
 * the handwritten descriptors in `panels.ts` override individual Services
 * with curated cards (`ServiceCard`).
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';

import {
  fetchChannelDescriptors,
  serviceByName,
  type ChannelDescriptor,
} from '../channel';
import { useConnection } from '../connection';
import { eventType, payloadField, useLiveEvent, useRecentEvents, type LiveEvent } from '../live';
import {
  AGENT_PANELS,
  CORE_PANELS,
  SESSION_PANELS,
  call,
  type AnyService,
  type ServicePanelDef,
} from '../panels';
import { ActionButton, Badge, ErrorLine, JsonView, relTime } from '../ui';

type Tab = 'app' | 'session' | 'agent' | 'events';
type Scope = 'app' | 'session' | 'agent';

const PANEL_OVERRIDES: ReadonlyMap<string, ServicePanelDef> = new Map(
  [...CORE_PANELS, ...SESSION_PANELS, ...AGENT_PANELS].map((def) => [def.id, def]),
);

/** Load the full protocol list once per connection (every channel, 1:1). */
function useChannels() {
  const { klient } = useConnection();
  return useQuery({
    queryKey: ['channels', klient.baseUrl, klient.rpcBasePath],
    queryFn: () => fetchChannelDescriptors(klient),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function Inspector({
  sessionId,
  agentId,
  onAgentChange,
  ready,
}: {
  sessionId: string | null;
  agentId: string;
  onAgentChange: (agentId: string) => void;
  ready: boolean;
}) {
  const { klient } = useConnection();
  const [tab, setTab] = useState<Tab>('session');
  const channels = useChannels();

  const meta = useQuery({
    queryKey: ['sessionMeta', sessionId],
    queryFn: () => klient.session(sessionId as string).service(ISessionMetadata).read(),
    enabled: sessionId !== null && ready,
  });

  const agentIds = useMemo(() => {
    const ids = Object.keys(meta.data?.agents ?? {});
    if (ids.length === 0) return ['main'];
    return ['main', ...ids.filter((id) => id !== 'main')].filter(
      (id, i, all) => all.indexOf(id) === i,
    );
  }, [meta.data]);

  // Keep the selected agent valid as the registry changes.
  const effectiveAgent = agentIds.includes(agentId) ? agentId : agentIds[0]!;
  useEffect(() => {
    if (effectiveAgent !== agentId) onAgentChange(effectiveAgent);
  }, [effectiveAgent, agentId, onAgentChange]);

  // Subagents stay in the metadata registry even when their scope is not
  // materialized in this process (created before a restart, or disposed on
  // session close), so the switcher lists entries that cannot be called.
  // Mark one as "not loaded" when an agent-scope call comes back with
  // `agent.not_found` (message names the agent).
  const [stoppedAgents, setStoppedAgents] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setStoppedAgents(new Set()), [sessionId]);
  const noteAgentError = (agent: string, error: unknown) => {
    if (error instanceof Error && error.message.includes('not found in session')) {
      setStoppedAgents((prev) => (prev.has(agent) ? prev : new Set(prev).add(agent)));
    }
  };

  // Resolve a Service proxy by channel name + scope, 1:1 with the channel
  // descriptor from `/api/v2/channels`. Returns null when the scope needs a
  // session that isn't selected/ready.
  const serviceProxy = useMemo(() => {
    return (name: string, scope: Scope): AnyService | null => {
      return serviceByName<AnyService>(klient, name, {
        scope,
        sessionId: sessionId !== null && ready ? sessionId : undefined,
        agentId: effectiveAgent,
      }) ?? null;
    };
  }, [klient, sessionId, effectiveAgent, ready]);

  // Panels for one scope: the dynamic channel list merged with the handwritten
  // overrides. When the channels endpoint is unavailable (older server), fall
  // back to the handwritten panels only.
  const renderPanels = (scope: Scope) => {
    const byName = new Map<string, ChannelDescriptor | undefined>();
    if (channels.data !== undefined) {
      for (const c of channels.data) {
        if (c.scope === scope) byName.set(c.name, c);
      }
      // Keep overrides the introspection missed (e.g. server drift).
      for (const def of PANEL_OVERRIDES.values()) {
        if (def.scope === scope && !byName.has(def.id)) byName.set(def.id, undefined);
      }
    } else {
      for (const def of PANEL_OVERRIDES.values()) {
        if (def.scope === scope) byName.set(def.id, undefined);
      }
    }
    const list = [...byName.entries()];
    return (
      <>
        {channels.isError ? (
          <div className="mb-2">
            <ErrorLine error={channels.error} />
            <div className="mt-1 text-[10px] text-neutral-600">
              dynamic channel list unavailable — showing handwritten panels only
            </div>
          </div>
        ) : null}
        {list.map(([name, channel]) => {
          const def = PANEL_OVERRIDES.get(name);
          const onError =
            scope === 'agent' ? (error: unknown) => noteAgentError(effectiveAgent, error) : undefined;
          if (def !== undefined) {
            return (
              <ServiceCard
                key={name}
                def={def}
                svc={serviceProxy(name, scope)}
                onError={onError}
              />
            );
          }
          if (channel === undefined) return null;
          return (
            <DynamicServiceCard
              key={name}
              channel={channel}
              svc={serviceProxy(name, scope)}
              onError={onError}
            />
          );
        })}
      </>
    );
  };

  const sessionBlocked = sessionId === null || !ready;

  return (
    <div className="flex h-full w-[420px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-900/30">
      {/* Agent switcher */}
      {sessionId !== null ? (
        <div className="border-b border-neutral-800 px-3 py-2">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Active agent
          </label>
          <select
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-[12px] text-neutral-100 outline-none focus:border-sky-600"
            value={effectiveAgent}
            onChange={(e) => onAgentChange(e.target.value)}
          >
            {agentIds.map((id) => (
              <option key={id} value={id}>
                {stoppedAgents.has(id) ? `${id} (not loaded)` : id}
              </option>
            ))}
          </select>
          {stoppedAgents.has(effectiveAgent) ? (
            <div className="mt-1 text-[10px] text-neutral-600">
              this agent is not materialized in the running server (e.g. created before a
              restart) — calls will fail; its persisted records remain on disk
            </div>
          ) : null}
          {meta.isError ? <div className="mt-1"><ErrorLine error={meta.error} /></div> : null}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex border-b border-neutral-800 text-[11px]">
        {(['app', 'session', 'agent', 'events'] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 px-2 py-2 font-medium uppercase tracking-wider ${
              tab === t ? 'bg-neutral-800 text-sky-400' : 'text-neutral-500 hover:text-neutral-300'
            }`}
            onClick={() => setTab(t)}
          >
            {t === 'app' ? 'App' : t === 'session' ? 'Session' : t === 'agent' ? 'Agent' : 'Events'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'app' ? (
          renderPanels('app')
        ) : tab === 'events' ? (
          <EventLog />
        ) : sessionBlocked ? (
          <div className="text-[12px] text-neutral-600">
            {sessionId === null ? 'No session selected.' : 'Loading session…'}
          </div>
        ) : tab === 'session' ? (
          <>
            <InteractionsCard sessionId={sessionId} />
            {renderPanels('session')}
          </>
        ) : (
          renderPanels('agent')
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic service card
// ---------------------------------------------------------------------------

function ServiceCard({
  def,
  svc,
  onError,
}: {
  def: ServicePanelDef;
  svc: AnyService | null;
  onError?: (error: unknown) => void;
}) {
  const [data, setData] = useState<unknown>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    if (svc === null || def.fetch === undefined) return;
    try {
      setError(null);
      const result = await def.fetch(svc);
      setData(result);
      setLoaded(true);
    } catch (error) {
      setError(error);
      onError?.(error);
    }
  };

  // Refetch on matching live events (app-scope panels ride the `core` stream).
  useLiveEvent((event: LiveEvent) => {
    if (def.refreshOn === undefined || svc === null) return;
    const source = def.scope === 'app' ? 'core' : def.scope;
    if (event.source !== source) return;
    const type = eventType(event);
    if (def.refreshOn.some((prefix) => type.startsWith(prefix))) void refresh();
  });

  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/60">
      <div className="flex items-center justify-between border-b border-neutral-800/60 px-3 py-2">
        <div>
          <span className="text-[12px] font-medium text-neutral-200">{def.label}</span>
          <span className="ml-2 font-mono text-[10px] text-neutral-600">{def.id}</span>
        </div>
        {def.fetch !== undefined ? (
          <ActionButton onClick={() => void refresh()} disabled={svc === null}>
            {loaded ? 'Refresh' : 'Load'}
          </ActionButton>
        ) : null}
      </div>
      <div className="px-3 py-2">
        {error !== null ? <div className="mb-2"><ErrorLine error={error} /></div> : null}
        {def.fetch !== undefined ? (
          loaded ? (
            <JsonView data={data} />
          ) : (
            <div className="text-[11px] text-neutral-600 italic">click Load to read this Service</div>
          )
        ) : null}
        {def.actions !== undefined && def.actions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {def.actions.map((action) => (
              <ActionButton
                key={action.label}
                danger={action.danger}
                disabled={svc === null || busy !== null}
                onClick={async () => {
                  if (svc === null) return;
                  let input: string | undefined;
                  if (action.input !== undefined) {
                    const raw = window.prompt(action.input);
                    if (raw === null) return;
                    input = raw;
                  }
                  setBusy(action.label);
                  setError(null);
                  try {
                    const result = await action.run(svc, input);
                    if (result !== undefined && def.fetch === undefined) setData(result);
                    if (def.fetch !== undefined) await refresh();
                  } catch (error) {
                    setError(error);
                    onError?.(error);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === action.label ? '…' : action.label}
              </ActionButton>
            ))}
          </div>
        ) : null}
        {def.fetch === undefined && data !== undefined ? (
          <div className="mt-2"><JsonView data={data} /></div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dynamic service card — generic renderer for channels without a handwritten
// override. Every method gets a call button labeled with its declared
// signature (JSON arg input when it takes parameters); getters become read
// buttons. Results render inline.
// ---------------------------------------------------------------------------

function DynamicServiceCard({
  channel,
  svc,
  onError,
}: {
  channel: ChannelDescriptor;
  svc: AnyService | null;
  onError?: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const invoke = async (method: ChannelDescriptor['methods'][number]) => {
    if (svc === null) return;
    let arg: unknown;
    if (method.kind === 'method' && method.params !== '') {
      const raw = (args[method.name] ?? '').trim();
      if (raw !== '') {
        try {
          arg = JSON.parse(raw);
        } catch {
          setErrors((prev) => ({ ...prev, [method.name]: new Error('arg is not valid JSON') }));
          return;
        }
      }
    }
    setBusy(method.name);
    setErrors((prev) => ({ ...prev, [method.name]: null }));
    try {
      const result = await call(svc, method.name, arg);
      setResults((prev) => ({ ...prev, [method.name]: result ?? '(no result)' }));
    } catch (error) {
      setErrors((prev) => ({ ...prev, [method.name]: error }));
      onError?.(error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/60">
      <div
        className="flex cursor-pointer items-center justify-between px-3 py-2 select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <span className="text-[12px] font-medium text-neutral-300">{channel.name}</span>
          <span className="ml-2 text-[10px] text-neutral-600">
            {channel.methods.length} methods · {channel.domain}
          </span>
        </div>
        <span className="text-[10px] text-neutral-600">{open ? '▾' : '▸'}</span>
      </div>
      {open ? (
        <div className="border-t border-neutral-800/60 px-3 py-2">
          {channel.methods.length === 0 ? (
            <div className="text-[11px] text-neutral-600 italic">no callable members</div>
          ) : null}
          {channel.methods.map((m) => (
            <div key={m.name} className="mb-1.5 last:mb-0">
              <div className="flex items-center gap-1.5">
                <ActionButton
                  disabled={svc === null || busy !== null}
                  onClick={() => void invoke(m)}
                >
                  {busy === m.name ? '…' : `${m.name}(${m.params})`}
                </ActionButton>
                {m.kind === 'property' ? <Badge tone="neutral">get</Badge> : null}
                {m.kind === 'method' && m.params !== '' ? (
                  <input
                    className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
                    placeholder="arg (JSON)"
                    value={args[m.name] ?? ''}
                    onChange={(e) =>
                      setArgs((prev) => ({ ...prev, [m.name]: e.target.value }))
                    }
                  />
                ) : null}
              </div>
              {errors[m.name] ? (
                <div className="mt-1">
                  <ErrorLine error={errors[m.name]} />
                </div>
              ) : null}
              {results[m.name] !== undefined ? (
                <div className="mt-1">
                  <JsonView data={results[m.name]} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending interactions (approvals / questions), live via the session stream
// ---------------------------------------------------------------------------

interface PendingInteraction {
  readonly id: string;
  /** Known kinds: 'approval' | 'question' | 'user_tool'; other kinds may appear. */
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: number;
}

function InteractionsCard({ sessionId }: { sessionId: string }) {
  const { klient } = useConnection();
  const [pending, setPending] = useState<readonly PendingInteraction[]>([]);
  const [error, setError] = useState<unknown>(null);
  const interaction = klient.session(sessionId).service(ISessionInteractionService);
  const approval = klient.session(sessionId).service(ISessionApprovalService);
  const question = klient.session(sessionId).service(ISessionQuestionService);

  const reload = async () => {
    try {
      setError(null);
      setPending((await interaction.listPending()) as readonly PendingInteraction[]);
    } catch (error) {
      setError(error);
    }
  };

  // The `interactions` stream pushes the full pending set on every change.
  useLiveEvent((event) => {
    if (event.source !== 'session') return;
    if (Array.isArray(event.data)) setPending(event.data as readonly PendingInteraction[]);
  });

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await approval.decide(id, { decision });
    } catch (error) {
      setError(error);
    }
  };
  const answer = async (id: string, q: string, value: string) => {
    try {
      await question.answer(id, { answers: { [q]: value } });
    } catch (error) {
      setError(error);
    }
  };
  const dismiss = async (id: string) => {
    try {
      await question.dismiss(id);
    } catch (error) {
      setError(error);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-amber-900/50 bg-amber-950/20">
      <div className="flex items-center justify-between border-b border-amber-900/40 px-3 py-2">
        <span className="text-[12px] font-medium text-amber-200">
          Pending interactions {pending.length > 0 ? `(${pending.length})` : ''}
        </span>
        <ActionButton onClick={() => void reload()}>Load</ActionButton>
      </div>
      <div className="px-3 py-2">
        {error !== null ? <div className="mb-2"><ErrorLine error={error} /></div> : null}
        {pending.length === 0 ? (
          <div className="text-[11px] text-neutral-600 italic">nothing pending</div>
        ) : (
          pending.map((item) => (
            <div key={item.id} className="mb-2 rounded border border-neutral-800 bg-neutral-950/60 p-2">
              <div className="mb-1 flex items-center gap-2">
                <Badge tone="amber">{item.kind}</Badge>
                <span className="font-mono text-[10px] text-neutral-500">{item.id}</span>
                <span className="text-[10px] text-neutral-600">{relTime(item.createdAt)}</span>
              </div>
              {item.kind === 'approval' ? (
                <>
                  <div className="mb-1.5 text-[11px] text-neutral-300">
                    <span className="text-neutral-500">tool </span>
                    {payloadField(item.payload, 'toolName', '?')}
                    <span className="text-neutral-500"> · </span>
                    {payloadField(item.payload, 'action', '')}
                  </div>
                  <JsonView data={item.payload['display'] ?? item.payload} />
                  <div className="mt-2 flex gap-1.5">
                    <ActionButton onClick={() => void decide(item.id, 'approved')}>Approve</ActionButton>
                    <ActionButton danger onClick={() => void decide(item.id, 'rejected')}>Reject</ActionButton>
                  </div>
                </>
              ) : item.kind === 'question' ? (
                <QuestionView
                  payload={item.payload}
                  onAnswer={(q, v) => void answer(item.id, q, v)}
                  onDismiss={() => void dismiss(item.id)}
                />
              ) : (
                <JsonView data={item.payload} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function QuestionView({
  payload,
  onAnswer,
  onDismiss,
}: {
  payload: Record<string, unknown>;
  onAnswer: (question: string, value: string) => void;
  onDismiss: () => void;
}) {
  const questions = (payload['questions'] ?? []) as readonly {
    question: string;
    options?: readonly { label: string }[];
  }[];
  return (
    <>
      {questions.map((q) => (
        <div key={q.question} className="mb-1.5">
          <div className="mb-1 text-[11px] text-neutral-300">{q.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {(q.options ?? []).map((opt) => (
              <ActionButton key={opt.label} onClick={() => onAnswer(q.question, opt.label)}>
                {opt.label}
              </ActionButton>
            ))}
            <ActionButton
              onClick={() => {
                const raw = window.prompt(q.question);
                if (raw !== null) onAnswer(q.question, raw);
              }}
            >
              Other…
            </ActionButton>
          </div>
        </div>
      ))}
      {questions.length === 0 ? <JsonView data={payload} /> : null}
      <div className="mt-1.5">
        <ActionButton danger onClick={onDismiss}>
          Dismiss
        </ActionButton>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Event log — merged core/session/agent stream
// ---------------------------------------------------------------------------

function EventLog() {
  const recent = useRecentEvents();
  const [events, setEvents] = useState<readonly LiveEvent[]>(() => recent);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const pausedRef = useRefState(paused);

  useLiveEvent((event) => {
    if (pausedRef.current) return;
    setEvents((prev) => [...prev.slice(-500), event]);
  });

  const filtered = filter.trim() === ''
    ? events
    : events.filter((e) => JSON.stringify(e.data).toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5">
        <input
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-sky-600"
          placeholder="filter JSON…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ActionButton onClick={() => setPaused((v) => !v)}>{paused ? 'Resume' : 'Pause'}</ActionButton>
        <ActionButton onClick={() => setEvents([])}>Clear</ActionButton>
      </div>
      <div className="text-[10px] text-neutral-600">{filtered.length} events (newest first)</div>
      <div className="mt-2">
        {filtered.toReversed().map((event, i) => (
          <div key={`${event.at}-${i}`} className="mb-1.5 rounded border border-neutral-800/70 bg-neutral-950/50 p-2">
            <div className="mb-1 flex items-center gap-1.5">
              <Badge tone={event.source === 'core' ? 'sky' : event.source === 'session' ? 'amber' : 'green'}>
                {event.source}
              </Badge>
              <span className="font-mono text-[10px] text-neutral-400">{eventType(event) || '(payload)'}</span>
              <span className="text-[10px] text-neutral-600">{new Date(event.at).toLocaleTimeString()}</span>
            </div>
            <JsonView data={event.data} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Mirror a state value into a ref so event handlers see the latest without re-subscribing. */
function useRefState<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
