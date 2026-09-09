/**
 * Model Catalog view — providers with their models and the default marker:
 *
 *   left:   every configured model (provider-grouped), its highlight synced
 *           both ways with the center column — scrolling the center moves the
 *           highlight (scrollspy), clicking an entry jumps the center to that
 *           model;
 *   center: one section per model with ping and session creation actions.
 *
 * All data goes through the channel layer — `IModelCatalog` +
 * `IModelService` for the list — over the `/api/v1/debug` RPC surface.
 * There is no live event push; the queries refresh on a slow poll.
 */

import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import type { TokenUsage } from '@moonshot-ai/agent-core-v2/human/llm/usage';
import {
  IModelCatalog,
  type ModelCatalogItem,
  type ModelPingResult,
  type ProviderCatalogItem,
} from '@moonshot-ai/agent-core-v2/llm-adapter/model/catalog';
import { IModelService } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useConnection } from '../connection';
import { ActionButton, Badge, ErrorLine, errorMessage } from '../ui';

interface FlatEntry {
  readonly item: ModelCatalogItem;
  readonly provider?: ProviderCatalogItem;
}

export function ModelCatalogView({
  onOpenSession,
}: {
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const { klient } = useConnection();
  const queryClient = useQueryClient();

  const providers = useQuery({
    queryKey: ['modelCatalog', 'providers'],
    queryFn: () => klient.core(IModelCatalog).listProviders(),
    refetchInterval: 15_000,
  });
  const models = useQuery({
    queryKey: ['modelCatalog', 'models'],
    queryFn: () => klient.core(IModelCatalog).listModels(),
    refetchInterval: 15_000,
  });
  // Raw records carry the structured `providerId` grouping fallback.
  const records = useQuery({
    queryKey: ['modelCatalog', 'records'],
    queryFn: () => klient.core(IModelService).list(),
    refetchInterval: 15_000,
  });

  const providerList = providers.data ?? [];
  const items = models.data ?? [];
  const recordMap = records.data ?? {};

  // Flatten the provider grouping into one ordered model list (listed
  // providers first, then models whose group matches no listed provider).
  const groupKeyOf = (item: ModelCatalogItem): string => {
    const record = recordMap[item.model];
    return record?.providerId ?? record?.provider ?? item.provider;
  };
  const byGroup = new Map<string, ModelCatalogItem[]>();
  for (const item of items) {
    const key = groupKeyOf(item);
    const group = byGroup.get(key) ?? [];
    group.push(item);
    byGroup.set(key, group);
  }
  const listedIds = new Set(providerList.map((p) => p.id));
  const extraGroups = [...byGroup.keys()].filter((key) => !listedIds.has(key));
  const flatEntries: FlatEntry[] = [
    ...providerList.flatMap((provider) =>
      (byGroup.get(provider.id) ?? []).map((item) => ({ item, provider }) as const),
    ),
    ...extraGroups.flatMap((key) => (byGroup.get(key) ?? []).map((item) => ({ item }) as const)),
  ];

  // --- two-way sync between the left list and the center scroll ----------
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const itemRefs = useRef(new Map<string, HTMLElement>());

  // Default the highlight to the first model once data arrives, and follow
  // the list when the highlighted model disappears (config changed).
  useEffect(() => {
    if (flatEntries.length === 0) return;
    if (activeId === null || !flatEntries.some((entry) => entry.item.model === activeId)) {
      setActiveId(flatEntries[0]!.item.model);
    }
  }, [activeId, flatEntries]);

  // Center scroll → left highlight (scrollspy). Computed synchronously — a
  // rAF throttle would stall in background tabs and lag real scrolling; the
  // walk over the entry list is trivial at this scale.
  const handleCenterScroll = () => {
    const container = scrollRef.current;
    if (container === null) return;
    const top = container.scrollTop + 12;
    let current: string | null = null;
    for (const entry of flatEntries) {
      const el = sectionRefs.current.get(entry.item.model);
      if (el === undefined) continue;
      if (el.offsetTop <= top) current = entry.item.model;
      else break;
    }
    if (current !== null) setActiveId((prev) => (prev === current ? prev : current));
  };

  // Left highlight → keep the highlighted entry visible inside the left list
  // (manual scroll: scrollIntoView would also move the center column).
  useEffect(() => {
    if (activeId === null) return;
    const list = listRef.current;
    const el = itemRefs.current.get(activeId);
    if (list === null || el === undefined) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeId]);

  const jumpTo = (modelId: string) => {
    setActiveId(modelId);
    // 'instant', not 'smooth': smooth scrolling is frame-driven and stalls in
    // occluded tabs, leaving the center column stranded mid-jump.
    sectionRefs.current.get(modelId)?.scrollIntoView({ behavior: 'instant', block: 'start' });
  };

  const loading = providers.isLoading || models.isLoading || records.isLoading;
  const error = providers.error ?? models.error ?? records.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-neutral-400">
          Model Catalog
        </span>
        <span className="text-[11px] text-neutral-600">
          {providerList.length} providers · {items.length} models
        </span>
        <div className="flex-1" />
        <ActionButton onClick={() => queryClient.invalidateQueries({ queryKey: ['modelCatalog'] })}>
          Refresh
        </ActionButton>
      </div>
      {error !== null ? (
        <div className="px-4 py-2">
          <ErrorLine error={error} />
        </div>
      ) : null}
      {loading ? <div className="px-4 py-2 text-[11px] text-neutral-600">loading…</div> : null}
      {!loading && flatEntries.length === 0 ? (
        <div className="px-4 py-2 text-[11px] text-neutral-600">
          no providers or models configured
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {/* left: the model list */}
        <div
          ref={listRef}
          className="relative w-72 shrink-0 overflow-y-auto border-r border-neutral-800"
        >
          <LeftList entries={flatEntries} activeId={activeId} onJump={jumpTo} itemRefs={itemRefs} />
        </div>
        {/* center: one section per model */}
        <div
          ref={scrollRef}
          className="relative min-w-0 flex-1 overflow-y-auto"
          onScroll={handleCenterScroll}
        >
          {flatEntries.map((entry) => (
            <ModelSection
              key={entry.item.model}
              entry={entry}
              onOpenSession={onOpenSession}
              registerRef={(el) => {
                if (el === null) sectionRefs.current.delete(entry.item.model);
                else sectionRefs.current.set(entry.item.model, el);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// left column
// ---------------------------------------------------------------------------

function LeftList({
  entries,
  activeId,
  onJump,
  itemRefs,
}: {
  readonly entries: readonly FlatEntry[];
  readonly activeId: string | null;
  readonly onJump: (modelId: string) => void;
  readonly itemRefs: React.RefObject<Map<string, HTMLElement>>;
}) {
  let lastGroup: string | undefined;
  return (
    <div className="py-1">
      {entries.map((entry) => {
        const groupId = entry.provider?.id ?? '(no provider)';
        const header = groupId !== lastGroup ? groupId : undefined;
        lastGroup = groupId;
        const isDefault = entry.provider?.default_model === entry.item.model;
        const active = entry.item.model === activeId;
        return (
          <div key={entry.item.model}>
            {header !== undefined ? (
              <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
                <span className="truncate">{header}</span>
                {entry.provider !== undefined ? (
                  <Badge
                    tone={
                      entry.provider.status === 'connected'
                        ? 'green'
                        : entry.provider.status === 'error'
                          ? 'red'
                          : 'amber'
                    }
                  >
                    {entry.provider.status}
                  </Badge>
                ) : null}
              </div>
            ) : null}
            <div
              ref={(el) => {
                if (el === null) itemRefs.current.delete(entry.item.model);
                else itemRefs.current.set(entry.item.model, el);
              }}
              className={`cursor-pointer px-3 py-1.5 ${
                active ? 'bg-sky-950/60' : 'hover:bg-neutral-800/60'
              }`}
              onClick={() => {
                onJump(entry.item.model);
              }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                    active ? 'text-neutral-100' : 'text-neutral-300'
                  }`}
                  title={entry.item.model}
                >
                  {entry.item.model}
                </span>
                {isDefault ? <Badge tone="sky">default</Badge> : null}
              </div>
              {entry.item.display_name !== undefined &&
              entry.item.display_name !== entry.item.model ? (
                <div className="truncate text-[10px] text-neutral-600">
                  {entry.item.display_name}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// center column
// ---------------------------------------------------------------------------

function ModelSection({
  entry,
  onOpenSession,
  registerRef,
}: {
  readonly entry: FlatEntry;
  readonly onOpenSession: (sessionId: string) => void;
  readonly registerRef: (el: HTMLElement | null) => void;
}) {
  const { klient, baseUrl, config } = useConnection();
  const { item, provider } = entry;
  const [ping, setPing] = useState<
    | { readonly status: 'idle' | 'running' }
    | { readonly status: 'done'; readonly result: ModelPingResult }
  >({ status: 'idle' });
  const [creating, setCreating] = useState(false);
  const [sessionError, setSessionError] = useState<unknown>(null);

  const runPing = async () => {
    setPing({ status: 'running' });
    try {
      const result = await klient.core(IModelCatalog).ping(item.model);
      setPing({ status: 'done', result });
    } catch (error) {
      setPing({
        status: 'done',
        result: { ok: false, durationMs: 0, error: errorMessage(error) },
      });
    }
  };

  // Session creation itself is v1 REST (klient is v2-only); resume + model
  // selection then go through the channel layer before opening the chat tab.
  const createSession = async () => {
    const cwd = window.prompt('Working directory for the new session:', '');
    if (cwd === null || cwd.trim() === '') return;
    setCreating(true);
    setSessionError(null);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.token.trim() !== '') headers['authorization'] = `Bearer ${config.token.trim()}`;
      const res = await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ metadata: { cwd: cwd.trim() } }),
      });
      const envelope = (await res.json()) as { code: number; msg: string; data: { id: string } };
      if (envelope.code !== 0) throw new Error(envelope.msg);
      const sessionId = envelope.data.id;
      await klient.core(ISessionManager).resume(sessionId);
      await klient
        .session(sessionId)
        .agent('main')
        .service(IAgentProfileService)
        .setModel(item.model);
      onOpenSession(sessionId);
    } catch (error) {
      setSessionError(error);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section ref={registerRef} className="border-b border-neutral-800 px-4 py-3">
      <header className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-semibold text-neutral-100">{item.model}</span>
        {provider?.default_model === item.model ? <Badge tone="sky">default</Badge> : null}
        <span className="text-[10px] text-neutral-600">{provider?.id ?? '(no provider)'}</span>
        <ActionButton disabled={ping.status === 'running'} onClick={runPing}>
          {ping.status === 'running' ? 'pinging…' : 'Ping'}
        </ActionButton>
        <ActionButton disabled={creating} onClick={createSession}>
          {creating ? 'creating…' : '+ Session'}
        </ActionButton>
        <div className="flex-1" />
        {(item.capabilities ?? []).map((capability) => (
          <Badge key={capability}>{capability}</Badge>
        ))}
        {item.default_effort !== undefined ? (
          <Badge tone="neutral">effort: {item.default_effort}</Badge>
        ) : null}
        <span className="shrink-0 font-mono text-[11px] text-neutral-500">
          {formatContextSize(item.max_context_size)}
        </span>
      </header>
      {ping.status === 'done' ? (
        <div className="mb-1 flex flex-wrap items-center gap-2 border border-neutral-800/60 bg-neutral-900/50 px-2 py-1">
          {ping.result.ok ? (
            <>
              <Badge tone="green">pong · {ping.result.durationMs}ms</Badge>
              {ping.result.text !== undefined && ping.result.text !== '' ? (
                <span className="text-[11px] text-neutral-300">{ping.result.text}</span>
              ) : null}
              {ping.result.usage !== undefined ? (
                <span className="text-[10px] text-neutral-600">{usageLine(ping.result.usage)}</span>
              ) : null}
              {ping.result.finishReason !== undefined ? (
                <span className="text-[10px] text-neutral-600">{ping.result.finishReason}</span>
              ) : null}
            </>
          ) : (
            <>
              <Badge tone="red">ping failed · {ping.result.durationMs}ms</Badge>
              <span className="text-[11px] text-red-400">{ping.result.error}</span>
            </>
          )}
        </div>
      ) : null}
      {sessionError !== null ? <ErrorLine error={sessionError} /> : null}
    </section>
  );
}

function usageLine(usage: TokenUsage): string {
  const input = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  return `in ${input} · out ${usage.output}`;
}

function formatContextSize(size: number): string {
  if (size <= 0) return '—';
  if (size >= 1_000_000) {
    const millions = size / 1_000_000;
    return `${millions.toFixed(Number.isInteger(millions) ? 0 : 1)}M ctx`;
  }
  if (size >= 1_000) return `${Math.round(size / 1_000)}k ctx`;
  return `${size} ctx`;
}
