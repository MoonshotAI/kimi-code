/**
 * Scope panels — the merged Service list for one wire scope (`app` /
 * `session` / `agent`), shared by the chat inspector (session + agent tabs)
 * and the standalone App Services rail view. The baseline is the dynamic
 * channel list served by `GET /api/v1/debug/channels` (every wire-exposed
 * Service with its methods), rendered by `DynamicServiceCard`; the
 * handwritten descriptors in `panels.ts` override individual Services with
 * curated cards (`ServiceCard`).
 *
 * Two layouts consume the same merged list (`useScopePanels`):
 * - `ScopePanels`: a plain stacked card list (the chat inspector).
 * - `ScopePanelsScrollspy`: a Postman-style three-pane layout — Service
 *   list on the left with a fuzzy filter box, every Service's card
 *   expanded (no collapsing) in one continuously scrolling column in the
 *   middle (scroll position drives the left-side highlight, clicks scroll
 *   the middle), and a request/response call history on the right fed by
 *   recording proxies around every card. Card headers copy the Service
 *   name on click (`CopyableName`).
 *
 * Everything here is fetch-on-demand (Load / Refresh buttons): the v2 event
 * socket (`/api/v2/ws`) that used to push core/session/agent event streams
 * was removed server-side, so there is no live push to render.
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchChannelDescriptors,
  type ChannelDescriptor,
  type ChannelScope,
} from '../channel';
import { useConnection } from '../connection';
import {
  AGENT_PANELS,
  CORE_PANELS,
  SESSION_PANELS,
  call,
  type AnyService,
  type ServicePanelDef,
} from '../panels';
import { ActionButton, Badge, ErrorLine, JsonView, errorMessage, relTime } from '../ui';
import { buildArgs, fieldKey, parseParamFields, type ParamField } from './methodArgs';

const PANEL_OVERRIDES: ReadonlyMap<string, ServicePanelDef> = new Map(
  [...CORE_PANELS, ...SESSION_PANELS, ...AGENT_PANELS].map((def) => [def.id, def]),
);

/** One merged Service entry: the wire channel plus its curated override, if any. */
interface ScopeEntry {
  readonly name: string;
  readonly channel?: ChannelDescriptor;
  readonly def?: ServicePanelDef;
}

/** Load the full protocol list once per connection (every channel, 1:1). */
function useChannels() {
  const { klient } = useConnection();
  return useQuery({
    queryKey: ['channels', klient.baseUrl],
    queryFn: () => fetchChannelDescriptors(klient),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Merge the dynamic channel list with the handwritten overrides for one
 * scope. When the channels endpoint is unavailable, fall back to the
 * handwritten panels only.
 */
function useScopePanels(scope: ChannelScope) {
  const channels = useChannels();
  const entries = useMemo<readonly ScopeEntry[]>(() => {
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
    return [...byName.entries()].map(([name, channel]) => ({
      name,
      channel,
      def: PANEL_OVERRIDES.get(name),
    }));
  }, [channels.data, scope]);
  return { entries, channels };
}

/**
 * Render every Service of one scope as a plain stacked card list.
 * `proxyFor` materializes the Service proxy for a channel name (null when
 * the scope is not callable, e.g. no session selected); `onError` observes
 * call failures (the agent switcher uses it to mark unloaded agents).
 */
export function ScopePanels({
  scope,
  proxyFor,
  onError,
}: {
  readonly scope: ChannelScope;
  readonly proxyFor: (name: string) => AnyService | null;
  readonly onError?: (error: unknown) => void;
}) {
  const { entries, channels } = useScopePanels(scope);

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
      {entries.map(({ name, channel, def }) => {
        if (def !== undefined) {
          return (
            <ServiceCard key={name} def={def} svc={proxyFor(name)} onError={onError} />
          );
        }
        if (channel === undefined) return null;
        return (
          <DynamicServiceCard
            key={name}
            channel={channel}
            svc={proxyFor(name)}
            onError={onError}
          />
        );
      })}
    </>
  );
}

/**
 * Subsequence fuzzy match (case-insensitive): `ssm` matches
 * `sessionScopeMetadata`. An empty query matches everything.
 */
function fuzzyMatch(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const n = name.toLowerCase();
  let i = 0;
  for (const ch of n) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

/**
 * Three-pane scope browser: the Service list on the left (with a fuzzy
 * filter box), every Service's card expanded in one continuously scrolling
 * column in the middle, and a Postman-style call history on the right
 * (`HistoryPane`) recording every wire request/response the cards make.
 * The scroll position highlights the matching list item (and keeps it
 * visible); clicking a list item smooth-scrolls the middle column to that
 * Service. The list hides below the `md` breakpoint and the history below
 * `lg`.
 */
export function ScopePanelsScrollspy({
  scope,
  title,
  proxyFor,
  onError,
}: {
  readonly scope: ChannelScope;
  readonly title: string;
  readonly proxyFor: (name: string) => AnyService | null;
  readonly onError?: (error: unknown) => void;
}) {
  const { entries, channels } = useScopePanels(scope);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const navRefs = useRef(new Map<string, HTMLButtonElement>());

  // The filter narrows the left list only; the middle column keeps every
  // card mounted so in-flight inputs and results survive a search.
  const filtered = useMemo(
    () => entries.filter(({ name }) => fuzzyMatch(name, query)),
    [entries, query],
  );

  // Call history: every card proxy is wrapped (`makeRecordingProxy`), so
  // curated and dynamic cards record uniformly without per-card plumbing.
  const [records, setRecords] = useState<readonly CallRecord[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const recordId = useRef(0);
  const record = useCallback((entry: Omit<CallRecord, 'id'>) => {
    const id = ++recordId.current;
    setRecords((prev) => [{ ...entry, id }, ...prev].slice(0, 100));
    // Like Postman's response pane: the newest call is always open.
    setExpandedId(id);
  }, []);
  const recordingProxyFor = useCallback(
    (name: string): AnyService | null => {
      const svc = proxyFor(name);
      return svc === null ? null : makeRecordingProxy(name, svc, record);
    },
    [proxyFor, record],
  );

  // Highlight the section nearest the top of the scroll port. Driven by the
  // scroll event (not IntersectionObserver) so tall sections and the tail of
  // the list behave predictably. Section refs sit in DOM order in the map.
  const syncActive = useCallback(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const rootTop = root.getBoundingClientRect().top;
    let current: string | null = null;
    for (const [name, el] of sectionRefs.current) {
      if (el.getBoundingClientRect().top - rootTop <= 96) current = name;
      else break;
    }
    current ??= entries[0]?.name ?? null;
    setActive((prev) => (prev === current ? prev : current));
  }, [entries]);

  // Sections mount as the channel list resolves, so re-sync on list changes.
  useEffect(() => {
    syncActive();
  }, [syncActive]);

  // Keep the highlighted item inside the left list's viewport.
  useEffect(() => {
    if (active === null) return;
    navRefs.current.get(active)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const scrollTo = (name: string) => {
    setActive(name);
    sectionRefs.current.get(name)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-neutral-800 py-2 md:block">
        <div className="px-3 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          {title}
        </div>
        <div className="px-2 pb-2">
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
            placeholder="Filter services…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <div className="px-3 py-1 text-[11px] text-neutral-600 italic">no matches</div>
        ) : null}
        {filtered.map(({ name, def }) => (
          <button
            key={name}
            type="button"
            ref={(el) => {
              if (el === null) navRefs.current.delete(name);
              else navRefs.current.set(name, el);
            }}
            onClick={() => scrollTo(name)}
            className={`block w-full truncate px-3 py-1 text-left font-mono text-[11px] transition-colors ${
              active === name
                ? 'bg-neutral-800 text-sky-400'
                : 'text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-300'
            }`}
            title={def?.label ?? name}
          >
            {name}
          </button>
        ))}
      </nav>
      <div ref={scrollRef} onScroll={syncActive} className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
        {channels.isError ? (
          <div className="mb-2">
            <ErrorLine error={channels.error} />
            <div className="mt-1 text-[10px] text-neutral-600">
              dynamic channel list unavailable — showing handwritten panels only
            </div>
          </div>
        ) : null}
        {entries.map(({ name, channel, def }) => (
          <section
            key={name}
            ref={(el) => {
              if (el === null) sectionRefs.current.delete(name);
              else sectionRefs.current.set(name, el);
            }}
            className="scroll-mt-3"
          >
            {def !== undefined ? (
              <ServiceCard def={def} svc={recordingProxyFor(name)} onError={onError} />
            ) : channel !== undefined ? (
              <DynamicServiceCard
                channel={channel}
                svc={recordingProxyFor(name)}
                onError={onError}
                collapsible={false}
                inlineResults={false}
              />
            ) : null}
          </section>
        ))}
      </div>
      <HistoryPane
        records={records}
        expandedId={expandedId}
        onToggle={(id) => setExpandedId((prev) => (prev === id ? null : id))}
        onClear={() => {
          setRecords([]);
          setExpandedId(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Call history — one record per wire call, newest first, capped at 100.
// ---------------------------------------------------------------------------

interface CallRecord {
  readonly id: number;
  readonly service: string;
  readonly method: string;
  readonly args: readonly unknown[];
  readonly at: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

/**
 * Wrap a Service proxy so every method call is recorded (args, result or
 * error, duration) before its promise settles. Errors rethrow unchanged, so
 * the calling card's own error handling still runs.
 */
function makeRecordingProxy(
  service: string,
  svc: AnyService,
  record: (entry: Omit<CallRecord, 'id'>) => void,
): AnyService {
  return new Proxy(svc, {
    get(target, prop) {
      const member = target[prop as string];
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const at = Date.now();
        return Promise.resolve(member(...args)).then(
          (result) => {
            record({ service, method: String(prop), args, at, durationMs: Date.now() - at, ok: true, result });
            return result;
          },
          (error: unknown) => {
            record({
              service,
              method: String(prop),
              args,
              at,
              durationMs: Date.now() - at,
              ok: false,
              error: errorMessage(error),
            });
            throw error;
          },
        );
      };
    },
  });
}

function HistoryPane({
  records,
  expandedId,
  onToggle,
  onClear,
}: {
  readonly records: readonly CallRecord[];
  readonly expandedId: number | null;
  readonly onToggle: (id: number) => void;
  readonly onClear: () => void;
}) {
  return (
    <div className="hidden w-[360px] shrink-0 flex-col border-l border-neutral-800 bg-neutral-900/30 lg:flex">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          History {records.length > 0 ? `(${records.length})` : ''}
        </span>
        {records.length > 0 ? <ActionButton onClick={onClear}>Clear</ActionButton> : null}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {records.length === 0 ? (
          <div className="px-1 text-[11px] text-neutral-600 italic">
            call any method to see the request/response here
          </div>
        ) : null}
        {records.map((r) => {
          const open = r.id === expandedId;
          return (
            <div key={r.id} className="mb-2 rounded border border-neutral-800 bg-neutral-900/60">
              <div
                className="flex cursor-pointer items-center gap-2 px-2 py-1.5 select-none"
                onClick={() => onToggle(r.id)}
              >
                <span className={`shrink-0 text-[9px] ${r.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                  ●
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-200">
                  {r.service}.{r.method}
                </span>
                <span className="shrink-0 text-[10px] text-neutral-600">{r.durationMs}ms</span>
                <span className="shrink-0 text-[10px] text-neutral-600">{relTime(r.at)}</span>
                <span className="shrink-0 text-[10px] text-neutral-600">{open ? '▾' : '▸'}</span>
              </div>
              {open ? (
                <div className="border-t border-neutral-800/60 px-2 py-1.5">
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                    Request
                  </div>
                  <JsonView data={r.args} empty="(no args)" />
                  <div className="mt-1.5 mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                    {r.ok ? 'Response' : 'Error'}
                  </div>
                  {r.ok ? (
                    <JsonView data={r.result} empty="(no result)" />
                  ) : (
                    <div className="text-[11px] break-words text-red-400">{r.error}</div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic service card
// ---------------------------------------------------------------------------

/** Service name that copies itself to the clipboard on click. */
function CopyableName({ name, className }: { name: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`click to copy: ${name}`}
      className={className}
      onClick={(e) => {
        // Don't trigger the collapsible header toggle behind the name.
        e.stopPropagation();
        void navigator.clipboard.writeText(name).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'copied ✓' : name}
    </button>
  );
}

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

  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/60">
      <div className="flex items-center justify-between border-b border-neutral-800/60 px-3 py-2">
        <div>
          <span className="text-[12px] font-medium text-neutral-200">{def.label}</span>
          <CopyableName
            name={def.id}
            className="ml-2 font-mono text-[10px] text-neutral-600 hover:text-sky-400"
          />
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
// signature; parameters become structured inputs (`MethodArgInputs`: one
// field per parameter, one per key for destructured objects, smart-parsed —
// see `methodArgs.ts`). Getters become read buttons. Results render inline.
// ---------------------------------------------------------------------------

function DynamicServiceCard({
  channel,
  svc,
  onError,
  collapsible = true,
  inlineResults = true,
}: {
  channel: ChannelDescriptor;
  svc: AnyService | null;
  onError?: (error: unknown) => void;
  /**
   * Allow collapsing the method list behind the header. Off in the
   * scrollspy layout, where every card stays expanded and the header name
   * is a copy target instead of a toggle.
   */
  collapsible?: boolean;
  /**
   * Render call results inline under each method. Off in the scrollspy
   * layout, where results land in the right-side history pane instead.
   */
  inlineResults?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState<Record<string, Record<string, string>>>({});
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const invoke = async (method: ChannelDescriptor['methods'][number]) => {
    if (svc === null) return;
    let argv: unknown[];
    try {
      argv = buildArgs(parseParamFields(method.params), inputs[method.name] ?? {});
    } catch {
      setErrors((prev) => ({ ...prev, [method.name]: new Error('arg is not valid JSON') }));
      return;
    }
    setBusy(method.name);
    setErrors((prev) => ({ ...prev, [method.name]: null }));
    try {
      const result = await call(svc, method.name, ...argv);
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
        className={`flex items-center justify-between px-3 py-2 ${
          collapsible ? 'cursor-pointer select-none' : ''
        }`}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
      >
        <div>
          <CopyableName
            name={channel.name}
            className="text-[12px] font-medium text-neutral-300 hover:text-sky-400"
          />
          <span className="ml-2 text-[10px] text-neutral-600">
            {channel.methods.length} methods · {channel.domain}
          </span>
        </div>
        {collapsible ? (
          <span className="text-[10px] text-neutral-600">{open ? '▾' : '▸'}</span>
        ) : null}
      </div>
      {!collapsible || open ? (
        <div className="border-t border-neutral-800/60 px-3 py-2">
          {channel.methods.length === 0 ? (
            <div className="text-[11px] text-neutral-600 italic">no callable members</div>
          ) : null}
          {channel.methods.map((m) => {
            const fields = m.kind === 'method' ? parseParamFields(m.params) : [];
            return (
              <div key={m.name} className="mb-2 last:mb-0">
                <div className="flex items-center gap-1.5">
                  <ActionButton
                    disabled={svc === null || busy !== null}
                    onClick={() => void invoke(m)}
                  >
                    {busy === m.name ? '…' : `${m.name}(${m.params})`}
                  </ActionButton>
                  {m.kind === 'property' ? <Badge tone="neutral">get</Badge> : null}
                </div>
                {fields.length > 0 ? (
                  <MethodArgInputs
                    fields={fields}
                    values={inputs[m.name] ?? {}}
                    onChange={(key, value) =>
                      setInputs((prev) => ({
                        ...prev,
                        [m.name]: { ...prev[m.name], [key]: value },
                      }))
                    }
                  />
                ) : null}
                {errors[m.name] ? (
                  <div className="mt-1">
                    <ErrorLine error={errors[m.name]} />
                  </div>
                ) : null}
                {inlineResults && results[m.name] !== undefined ? (
                  <div className="mt-1">
                    <JsonView data={results[m.name]} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structured argument inputs — one labeled field per declared parameter.
// Values are smart-parsed on invoke (JSON when it parses, plain string
// otherwise), so simple strings need no quotes.
// ---------------------------------------------------------------------------

function MethodArgInputs({
  fields,
  values,
  onChange,
}: {
  fields: readonly ParamField[];
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {fields.map((f, i) => {
        if (f.kind === 'object') {
          return (
            <div key={i}>
              <div className="mb-0.5 font-mono text-[10px] text-neutral-600">{f.name}</div>
              <div className="flex flex-col gap-1 border-l border-neutral-800 pl-2">
                {f.keys.map((key) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <ArgLabel label={key} />
                    <ArgInput
                      placeholder="JSON or plain string"
                      value={values[fieldKey(i, key)] ?? ''}
                      onChange={(v) => onChange(fieldKey(i, key), v)}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (f.kind === 'value') {
          return (
            <div key={i} className="flex items-center gap-1.5">
              <ArgLabel label={f.name} />
              <ArgInput
                placeholder={
                  f.defaultValue !== undefined ? `default: ${f.defaultValue}` : 'JSON or plain string'
                }
                value={values[fieldKey(i)] ?? ''}
                onChange={(v) => onChange(fieldKey(i), v)}
              />
            </div>
          );
        }
        return (
          <div key={i} className="flex items-center gap-1.5">
            <ArgLabel label={f.label} />
            <ArgInput
              placeholder="arg (JSON)"
              value={values[fieldKey(i)] ?? ''}
              onChange={(v) => onChange(fieldKey(i), v)}
            />
          </div>
        );
      })}
    </div>
  );
}

function ArgLabel({ label }: { label: string }) {
  return (
    <span
      className="w-28 shrink-0 truncate text-right font-mono text-[10px] text-neutral-500"
      title={label}
    >
      {label}
    </span>
  );
}

function ArgInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
