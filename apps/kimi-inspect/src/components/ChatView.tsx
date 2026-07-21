/**
 * Main view — the conversation of the active session + agent, rendered from
 * the transcript surface (`/api/v1`):
 *
 *  - FULL state comes from the REST transcript API only: the initial load
 *    reads the newest page, a full refresh re-reads from the tail backwards
 *    until the previously loaded window is re-covered, and "Load earlier
 *    turns" pages further with a `before_turn` cursor.
 *  - The WS channel (`/api/v1/ws`) is a DELTA channel only: `transcript.ops`
 *    at `delta` grade; `transcript.reset` snapshots are ignored. Ops are
 *    buffered while a REST refresh is in flight and flushed onto the fresh
 *    pages — idempotent upserts and offset-placed appends make that converge.
 *  - Loss signals (`resync_required`, append gap, socket reconnect) trigger
 *    a full REST refresh; nothing is resynced from the socket itself.
 *
 * Rendering is turn-granular (turn → step → frame) and typed entirely by the
 * transcript data model. Prompts/cancels go through the `IAgentRPCService`
 * over the debug RPC surface (`/api/v1/debug`); the running indicator
 * derives from transcript state (`meta.activity` / running turns).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import {
  ISessionQuestionService,
  type QuestionItem,
  type QuestionRequest,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import {
  EMPTY_AGENT_STATE,
  itemId,
  type AgentState,
  type NoticeFrame,
  type ToolCallFrame,
  type TranscriptAttachment,
  type TranscriptFrame,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTaskRef,
  type TranscriptTurn,
  type TranscriptUsage,
  type TurnOrigin,
  type TurnState,
} from '@moonshot-ai/transcript';

import { useConnection } from '../connection';
import { AuditTrail } from '../audit/trail';
import { fetchTranscriptOps, fetchTranscriptPage, TRANSCRIPT_PAGE_SIZE } from '../transcript/api';
import {
  createCoalescedRunner,
  oldestTurnId,
  recoverLoadedWindow,
  TranscriptChatStore,
} from '../transcript/store';
import { TranscriptWs } from '../transcript/ws';
import { ActionButton, Badge, ErrorLine, JsonView, relTime } from '../ui';
import { AuditPanel } from './audit/AuditPanel';

const noopSubscribe = () => () => {};

/** Active session id for deeply nested interaction views (approve/answer buttons). */
const SessionContext = createContext<string>('');

interface TranscriptChannel {
  /** Null until the effect has created the store (pre-ready / no session). */
  readonly store: TranscriptChatStore | null;
  readonly state: AgentState;
  /** Records every step that built the store (audit panel data source). */
  readonly trail: AuditTrail | null;
  /** True once the initial REST page load succeeded. */
  readonly loaded: boolean;
  /** Set when the initial/refresh load failed (e.g. server without transcript). */
  readonly loadError: unknown;
}

/**
 * Owns the store, the REST load/refresh pipeline, and the WS delta
 * subscription for one (sessionId, agentId) pair.
 */
function useTranscriptChannel(
  sessionId: string | null,
  agentId: string,
  ready: boolean,
  captureAnchor: () => void,
): TranscriptChannel {
  const { baseUrl, config } = useConnection();
  const token = config.token.trim();
  const [channel, setChannel] = useState<{ store: TranscriptChatStore; trail: AuditTrail } | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    if (!ready || sessionId === null) return;
    const store = new TranscriptChatStore();
    const trail = new AuditTrail();
    const authToken = token === '' ? undefined : token;
    let disposed = false;
    /** While a REST reload / catch-up is in flight, WS ops are buffered, then flushed. */
    let fetching = true;
    let buffer: TranscriptOperation[] = [];
    /** Max batch seq seen while buffering (folded into the watermark on flush). */
    let bufferedSeq: number | undefined;
    /**
     * Op-batch watermark: the store is known to include every batch with
     * seq <= lastSeq. Sourced from REST page watermarks and applied batch
     * seqs; `undefined` until a sequenced server provides one (legacy
     * servers never do — every recovery then falls back to full refreshes).
     */
    let lastSeq: number | undefined;
    /** Cursor of the in-flight recover fetch, paired with `onPageApplied`. */
    let recoverBefore: string | undefined;
    /** True once the initial page load succeeded (gates reset-driven catch-up). */
    let seeded = false;

    const noteSeq = (seq: number | undefined): void => {
      if (seq === undefined) return;
      lastSeq = lastSeq === undefined ? seq : Math.max(lastSeq, seq);
    };

    const flushBuffer = (): void => {
      fetching = false;
      if (buffer.length > 0) {
        const flushed = buffer;
        store.applyOps(flushed);
        trail.recordOps(flushed, 'flushed', undefined, store.getState());
        noteSeq(bufferedSeq);
      }
      buffer = [];
      bufferedSeq = undefined;
    };

    /** Page (re)load body shared by the full refresh and the catch-up fallback. */
    const reloadPages = async (): Promise<void> => {
      // The window's oldest turn is the re-cover anchor: after a refresh the
      // server window may have shifted, and only re-loading up to THIS turn
      // preserves the previously loaded history.
      const prevOldest = oldestTurnId(store.getState().items);
      if (prevOldest !== undefined) captureAnchor();
      const newest = await fetchTranscriptPage({
        baseUrl,
        token: authToken,
        sessionId,
        agentId,
        pageSize: TRANSCRIPT_PAGE_SIZE,
      });
      if (disposed) return;
      store.applyPage(newest, { replace: true });
      trail.recordRest({ pageSize: TRANSCRIPT_PAGE_SIZE }, 'replace', newest, store.getState());
      lastSeq = newest.seq;
      // Re-cover the previously loaded window for refreshes (a no-op on the
      // initial load, where there is no previous oldest turn).
      await recoverLoadedWindow(
        store,
        prevOldest,
        (beforeTurn) => {
          recoverBefore = beforeTurn;
          return fetchTranscriptPage({
            baseUrl,
            token: authToken,
            sessionId,
            agentId,
            beforeTurn,
            pageSize: TRANSCRIPT_PAGE_SIZE,
          });
        },
        () => disposed,
        (page) => {
          trail.recordRest(
            { beforeTurn: recoverBefore, pageSize: TRANSCRIPT_PAGE_SIZE },
            'prepend',
            page,
            store.getState(),
          );
        },
      );
      if (!disposed) {
        seeded = true;
        setLoaded(true);
        setLoadError(null);
      }
    };

    /** Full-state (re)load: the legacy recovery path and the initial load. */
    const refresh = createCoalescedRunner(async (): Promise<void> => {
      fetching = true;
      buffer = [];
      bufferedSeq = undefined;
      try {
        await reloadPages();
      } catch (error) {
        if (!disposed) setLoadError(error);
      } finally {
        flushBuffer();
      }
    });

    /**
     * Targeted catch-up: fetch exactly the op batches after our watermark
     * (`GET .../transcript/ops?since_seq=`). Falls back to a full page
     * reload on a legacy server (no seq / endpoint missing), a journal that
     * no longer covers the gap (`complete: false`), or a fetch failure.
     */
    const catchUp = createCoalescedRunner(async (): Promise<void> => {
      if (lastSeq === undefined) {
        refresh();
        return;
      }
      fetching = true;
      buffer = [];
      bufferedSeq = undefined;
      try {
        const res = await fetchTranscriptOps({
          baseUrl,
          token: authToken,
          sessionId,
          agentId,
          sinceSeq: lastSeq,
        });
        if (disposed) return;
        if (!res.complete) {
          await reloadPages();
        } else {
          for (const batch of res.batches) {
            store.applyOps(batch.ops);
            trail.recordOps(batch.ops, 'catchup', undefined, store.getState());
          }
          noteSeq(res.latestSeq);
        }
      } catch {
        try {
          await reloadPages();
        } catch (error) {
          if (!disposed) setLoadError(error);
        }
      } finally {
        flushBuffer();
      }
    });

    const ws = new TranscriptWs({
      url: baseUrl,
      token: authToken,
      sessionId,
      agentId,
      getSince: () => lastSeq,
      handlers: {
        onOps: (aid, ops, meta) => {
          if (aid !== agentId) return;
          if (fetching) {
            buffer.push(...ops);
            if (meta?.seq !== undefined) {
              bufferedSeq = Math.max(bufferedSeq ?? 0, meta.seq);
            }
            trail.recordOps(ops, 'buffered', meta?.at, store.getState());
            return;
          }
          // Seq gap: the store is behind by at least one batch. Catch up
          // point-to-point instead of applying on a stale base (appends are
          // offset-placed and would surface a gap anyway).
          if (meta?.seq !== undefined && lastSeq !== undefined && meta.seq > lastSeq + 1) {
            catchUp();
            return;
          }
          store.applyOps(ops);
          trail.recordOps(ops, 'live', meta?.at, store.getState());
          noteSeq(meta?.seq);
        },
        onReset: (_aid, snapshot, hasMoreOlder, meta) => {
          trail.recordReset(snapshot, hasMoreOlder, meta?.at, store.getState());
          // Sequenced mode only: a reset after seeding means the server could
          // not replay from our `transcript_since` cursor (journal truncated)
          // — catch up, which itself falls back to a full reload when the seq
          // window is gone. On legacy servers (no watermark) resets are
          // routine per-subscribe noise and stay ignored, as before.
          if (seeded && lastSeq !== undefined) catchUp();
        },
        onResyncRequired: () => {
          trail.recordEvent('resync', undefined, store.getState());
          catchUp();
        },
        onReconnected: () => {
          trail.recordEvent('ack-refresh', undefined, store.getState());
          catchUp();
        },
      },
    });
    store.onGap = () => {
      trail.recordEvent('gap', undefined, store.getState());
      catchUp();
    };
    setChannel({ store, trail });
    setLoaded(false);
    setLoadError(null);
    refresh();
    return () => {
      disposed = true;
      ws.close();
      setChannel(null);
    };
  }, [sessionId, agentId, ready, baseUrl, token, captureAnchor]);

  const state = useSyncExternalStore(
    channel?.store.subscribe ?? noopSubscribe,
    () => channel?.store.getState() ?? EMPTY_AGENT_STATE,
  );
  return { store: channel?.store ?? null, state, trail: channel?.trail ?? null, loaded, loadError };
}

export function ChatView({
  sessionId,
  agentId,
  ready,
}: {
  sessionId: string | null;
  agentId: string;
  ready: boolean;
}) {
  const { klient, baseUrl, config } = useConnection();
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Distance from the scroll bottom captured before a prepend (restore anchor). */
  const anchorRef = useRef<number | null>(null);
  /** Whether the viewport was pinned to the bottom before the last update. */
  const stickBottomRef = useRef(true);

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (el !== null) anchorRef.current = el.scrollHeight - el.scrollTop;
  }, []);

  const { store, state, trail, loaded, loadError } = useTranscriptChannel(
    sessionId,
    agentId,
    ready,
    captureAnchor,
  );
  const items = state.items;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (anchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
      return;
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    if (sessionId === null || loadingOlder || store === null) return;
    const oldest = oldestTurnId(items);
    if (oldest === undefined) return;
    captureAnchor();
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const token = config.token.trim();
      const page = await fetchTranscriptPage({
        baseUrl,
        token: token === '' ? undefined : token,
        sessionId,
        agentId,
        beforeTurn: oldest,
        pageSize: TRANSCRIPT_PAGE_SIZE,
      });
      store.applyPage(page);
      trail?.recordRest(
        { beforeTurn: oldest, pageSize: TRANSCRIPT_PAGE_SIZE },
        'prepend',
        page,
        store.getState(),
      );
    } catch (error) {
      anchorRef.current = null;
      setOlderError(error);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Auto-paging: the top sentinel auto-loads the previous REST page when it
  // approaches the viewport (paused while a previous load failed — the retry
  // button re-arms it). This replaces any manual "load earlier" action.
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const hasMoreOlder = state.hasMoreOlder;
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (sentinel === null || root === null || olderError !== null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlderRef.current();
      },
      { root, rootMargin: '400px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [hasMoreOlder, loaded, olderError, loadingOlder]);

  const running =
    state.meta.activity === 'turn' ||
    items.some((item) => item.kind === 'turn' && item.state === 'running');

  // Interactions render inline at their anchor tool frame; entities without
  // an anchor (or whose anchor frame is outside the loaded window) collect
  // here and render floating at the bottom.
  const anchoredToolCallIds = collectToolCallIds(items);
  const unanchoredInteractions = [...state.interactions.values()].filter(
    (interaction) =>
      interaction.toolCallId === undefined || !anchoredToolCallIds.has(interaction.toolCallId),
  );
  const latestTodo = [...state.todos.values()].at(-1);

  const send = async () => {
    if (sessionId === null || input.trim() === '' || running) return;
    const text = input.trim();
    setInput('');
    setSendError(null);
    try {
      await klient
        .session(sessionId)
        .agent(agentId)
        .service(IAgentRPCService)
        .prompt({ input: [{ type: 'text', text }] });
      trail?.recordEvent('prompt', text, state);
    } catch (error) {
      setSendError(error);
    }
  };

  const cancel = async () => {
    if (sessionId === null) return;
    try {
      await klient.session(sessionId).agent(agentId).service(IAgentRPCService).cancel({});
      trail?.recordEvent('cancel', undefined, state);
    } catch (error) {
      setSendError(error);
    }
  };

  if (sessionId === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Select a session on the left to open its conversation.
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
        Loading session…
      </div>
    );
  }

  return (
    <SessionContext.Provider value={sessionId}>
      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
            <span className="font-mono text-[11px] text-neutral-400">{sessionId}</span>
            <Badge tone="sky">agent: {agentId}</Badge>
            {running ? <Badge tone="amber">turn running</Badge> : <Badge tone="green">idle</Badge>}
            {state.pendingInteractions.size > 0 ? (
              <Badge tone="amber">{state.pendingInteractions.size} pending</Badge>
            ) : null}
          </div>
    
          <div className="flex-1 overflow-y-auto px-4 py-3" ref={scrollRef} onScroll={onScroll}>
            {state.hasMoreOlder ? (
              <div ref={topSentinelRef} className="mb-3 flex justify-center">
                <span className="text-[11px] text-neutral-600">
                  {loadingOlder ? 'Loading earlier turns…' : ''}
                </span>
              </div>
            ) : null}
            {olderError !== null ? (
              <div className="mb-2">
                <ErrorLine error={olderError} />
                <div className="mt-1 flex justify-center">
                  <ActionButton
                    onClick={() => {
                      setOlderError(null);
                      void loadOlder();
                    }}
                  >
                    Retry loading earlier turns
                  </ActionButton>
                </div>
              </div>
            ) : null}
            {loadError !== null ? (
              <div className="mb-2">
                <ErrorLine error={loadError} />
                <div className="mt-1 text-[11px] text-neutral-600">
                  Failed to load the transcript — the server may be too old to expose the transcript
                  API.
                </div>
              </div>
            ) : null}
            {items.length === 0 && loadError === null ? (
              <div className="text-[12px] text-neutral-600 italic">
                {loaded ? 'Empty transcript — send a prompt below.' : 'Loading transcript…'}
              </div>
            ) : null}
            {latestTodo !== undefined && latestTodo.items.length > 0 ? (
              <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px]">
                <div className="mb-1 text-neutral-500">todo (latest)</div>
                {latestTodo.items.map((entry, i) => (
                  <div key={i} className="flex gap-2">
                    <span className={entry.status === 'done' ? 'text-green-500' : entry.status === 'in_progress' ? 'text-sky-400' : 'text-neutral-600'}>
                      {entry.status === 'done' ? '✔' : entry.status === 'in_progress' ? '◐' : '□'}
                    </span>
                    <span className={entry.status === 'done' ? 'text-neutral-600 line-through' : 'text-neutral-300'}>
                      {entry.title}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {items.map((item) => (
              // Native virtual screen: the browser skips layout/paint for
              // off-screen items and remembers their last rendered size
              // (`auto` in contain-intrinsic-size), so long transcripts stay
              // cheap without a windowing library.
              <div
                key={itemId(item)}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
              >
                <ItemView
                  item={item}
                  tasks={state.tasks}
                  interactions={state.interactions}
                  attachments={state.attachments}
                />
              </div>
            ))}
            {unanchoredInteractions.map((interaction) => (
              <InteractionEntityView key={interaction.interactionId} interaction={interaction} />
            ))}
          </div>
    
          <div className="border-t border-neutral-800 p-3">
            {sendError !== null ? (
              <div className="mb-2">
                <ErrorLine error={sendError} />
              </div>
            ) : null}
            <div className="flex gap-2">
              <textarea
                className="min-h-[40px] flex-1 resize-y rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-[13px] text-neutral-100 outline-none focus:border-sky-600"
                placeholder="Send a prompt to the active agent… (Enter to send, Shift+Enter for newline)"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="flex flex-col gap-2">
                <ActionButton onClick={() => void send()} disabled={running || input.trim() === ''}>
                  Send
                </ActionButton>
                <ActionButton onClick={() => void cancel()} danger disabled={!running}>
                  Cancel
                </ActionButton>
              </div>
            </div>
          </div>
        </div>
        {trail !== null ? <AuditPanel trail={trail} /> : null}
      </div>
    </SessionContext.Provider>
  );
}

// ---------------------------------------------------------------- items

function ItemView({
  item,
  tasks,
  interactions,
  attachments,
}: {
  item: TranscriptItem;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  switch (item.kind) {
    case 'turn':
      return <TurnView turn={item} tasks={tasks} interactions={interactions} attachments={attachments} />;
    case 'marker':
      return <MarkerView marker={item} />;
    case 'taskref':
      return <TaskRefView item={item} task={tasks.get(item.taskId)} />;
  }
}

function collectToolCallIds(items: readonly TranscriptItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') ids.add(frame.toolCallId);
      }
    }
  }
  return ids;
}

function turnStateTone(state: TurnState): 'neutral' | 'green' | 'amber' | 'red' {
  switch (state) {
    case 'running':
      return 'amber';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    default:
      return 'neutral';
  }
}

function usageText(usage: TranscriptUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
  if (usage.cachedTokens !== undefined) parts.push(`cached ${usage.cachedTokens}`);
  if (usage.cost !== undefined) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(' / ');
}

function TurnView({
  turn,
  tasks,
  interactions,
  attachments,
}: {
  turn: TranscriptTurn;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/30">
      <div className="flex items-center gap-2 border-b border-neutral-800/60 px-3 py-1.5">
        <span className="font-mono text-[10px] text-neutral-500">{turn.turnId}</span>
        <Badge tone={turn.origin.kind === 'user' ? 'sky' : 'neutral'}>{turn.origin.kind}</Badge>
        <Badge tone={turnStateTone(turn.state)}>{turn.state}</Badge>
        {turn.startedAt !== undefined ? (
          <span className="text-[10px] text-neutral-600">{relTime(Date.parse(turn.startedAt))}</span>
        ) : null}
        {turn.usage !== undefined ? (
          <span className="ml-auto text-[10px] text-neutral-600">{usageText(turn.usage)}</span>
        ) : null}
      </div>
      <div className="px-3 py-2">
        {turn.prompt !== undefined && turn.prompt !== '' ? (
          <TurnPrompt origin={turn.origin} prompt={turn.prompt} />
        ) : null}
        {turn.attachmentIds !== undefined && turn.attachmentIds.length > 0 ? (
          <AttachmentChips ids={turn.attachmentIds} attachments={attachments} />
        ) : null}
        {turn.steps.map((step) => (
          <div key={step.stepId}>
            {step.frames.map((frame) => (
              <FrameView
                key={frame.frameId}
                frame={frame}
                tasks={tasks}
                interactions={interactions}
                attachments={attachments}
              />
            ))}
            {step.state === 'interrupted' ? (
              <div className="mb-2 text-[10px] text-neutral-600 italic">step interrupted</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function TurnPrompt({ origin, prompt }: { origin: TurnOrigin; prompt: string }) {
  if (origin.kind === 'user') {
    return (
      <div className="mb-2 flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] text-neutral-100">
          {prompt}
        </div>
      </div>
    );
  }
  return (
    <div className="mb-2 whitespace-pre-wrap rounded-lg border border-neutral-800 px-3 py-2 text-[12px] text-neutral-400">
      {prompt}
    </div>
  );
}

function MarkerView({ marker }: { marker: TranscriptMarker }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-[10px] text-neutral-600">
        <div className="h-px flex-1 bg-neutral-800" />
        <span className="font-mono">{marker.marker}</span>
        {marker.at !== undefined ? <span>{relTime(Date.parse(marker.at))}</span> : null}
        <div className="h-px flex-1 bg-neutral-800" />
      </div>
      {marker.payload !== undefined ? <JsonView data={marker.payload} /> : null}
    </div>
  );
}

function TaskRefView({
  item,
  task,
}: {
  item: TranscriptTaskRef;
  task: TranscriptTask | undefined;
}) {
  const failed =
    task !== undefined && (task.state === 'failed' || task.state === 'timed_out' || task.state === 'lost');
  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <Badge tone={task?.state === 'running' ? 'amber' : failed ? 'red' : 'neutral'}>
          task{task !== undefined ? `: ${task.kind}` : ''}
        </Badge>
        <span className="text-neutral-300">{task?.description ?? item.taskId}</span>
        {task !== undefined ? (
          <span className="text-neutral-600">
            {task.state}
            {task.detached ? ' (detached)' : ''}
          </span>
        ) : null}
      </div>
      {task !== undefined && task.outputTail !== '' ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">
          {task.outputTail}
        </pre>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- frames

function AttachmentChips({
  ids,
  attachments,
}: {
  ids: readonly string[];
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {ids.map((id) => {
        const attachment = attachments.get(id);
        const label = attachment?.name ?? attachment?.mediaType ?? id;
        const href =
          attachment?.source?.kind === 'url' ? attachment.source.url : undefined;
        return (
          <span
            key={id}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-400"
            title={attachment?.mediaType}
          >
            📎 {href !== undefined ? <a href={href} className="underline">{label}</a> : label}
          </span>
        );
      })}
    </div>
  );
}

function FrameView({
  frame,
  tasks,
  interactions,
  attachments,
}: {
  frame: TranscriptFrame;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  switch (frame.kind) {
    case 'text': {
      const chips =
        frame.attachmentIds !== undefined && frame.attachmentIds.length > 0 ? (
          <AttachmentChips ids={frame.attachmentIds} attachments={attachments} />
        ) : null;
      const taskBadge =
        frame.taskId !== undefined ? (
          <div className="mb-1">
            <Badge tone={tasks.get(frame.taskId)?.state === 'running' ? 'amber' : 'neutral'}>
              task: {frame.taskId}
              {tasks.get(frame.taskId) !== undefined ? ` (${tasks.get(frame.taskId)!.state})` : ''}
            </Badge>
          </div>
        ) : null;
      const bubble =
        frame.role === 'user' ? (
          <div className="mb-2 flex justify-end">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] text-neutral-100">
              {frame.text}
            </div>
          </div>
        ) : (
          <div className="mb-2 max-w-[85%] whitespace-pre-wrap rounded-lg bg-neutral-800/60 px-3 py-2 text-[13px] text-neutral-100">
            {frame.text}
          </div>
        );
      return (
        <>
          {taskBadge}
          {chips}
          {bubble}
        </>
      );
    }
    case 'thinking':
      return (
        <div className="mb-2 max-w-[85%] whitespace-pre-wrap rounded-lg border border-dashed border-neutral-700 px-3 py-2 font-mono text-[11px] text-neutral-500">
          {frame.text}
        </div>
      );
    case 'tool':
      return <ToolFrameView frame={frame} tasks={tasks} interactions={interactions} />;
    case 'notice':
      return <NoticeFrameView frame={frame} />;
  }
}

function ToolFrameView({
  frame,
  tasks,
  interactions,
}: {
  frame: ToolCallFrame;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
}) {
  const task = frame.taskId !== undefined ? tasks.get(frame.taskId) : undefined;
  // The interaction anchored at this call (via approvalId, or by scanning the
  // entity's toolCallId for requests that predate the back-link).
  const linked = [...interactions.values()].filter(
    (interaction) =>
      interaction.interactionId === frame.approvalId || interaction.toolCallId === frame.toolCallId,
  );
  return (
    <div className="mb-2 max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2 font-mono text-[11px]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge tone={frame.state === 'error' ? 'red' : frame.state === 'running' ? 'amber' : 'neutral'}>
          tool
        </Badge>
        <span className="text-neutral-300">{frame.name}</span>
        {frame.view !== undefined && frame.view !== frame.name ? (
          <span className="text-neutral-600">view: {frame.view}</span>
        ) : null}
        {frame.agentRefs?.map((ref) => (
          <Badge key={ref.agentId} tone="sky">
            agent: {ref.agentId}
          </Badge>
        ))}
        {task !== undefined ? <span className="text-neutral-600">task: {task.state}</span> : null}
        {frame.todoId !== undefined ? <span className="text-neutral-600">todo: {frame.todoId}</span> : null}
      </div>
      {frame.input !== undefined ? (
        typeof frame.input === 'string' ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">{frame.input}</pre>
        ) : (
          <JsonView data={frame.input} />
        )
      ) : null}
      {frame.output !== undefined ? (
        typeof frame.output === 'string' ? (
          <pre
            className={`max-h-40 overflow-auto whitespace-pre-wrap ${
              frame.state === 'error' ? 'text-red-400' : 'text-neutral-400'
            }`}
          >
            {frame.output}
          </pre>
        ) : (
          <JsonView data={frame.output} />
        )
      ) : task !== undefined && task.outputTail !== '' ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-neutral-400">
          {task.outputTail}
        </pre>
      ) : null}
      {frame.error !== undefined && frame.error !== frame.output ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-red-400">{frame.error}</pre>
      ) : null}
      {linked.map((interaction) => (
        <InteractionEntityView key={interaction.interactionId} interaction={interaction} nested />
      ))}
    </div>
  );
}

function InteractionEntityView({
  interaction,
  nested,
}: {
  interaction: TranscriptInteraction;
  nested?: boolean;
}) {
  const { klient } = useConnection();
  const sessionId = useContext(SessionContext);
  const [busy, setBusy] = useState(false);
  const [respondError, setRespondError] = useState<unknown>(null);
  /** Question answers in progress: question text → selected option labels. */
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>({});
  /** Question free-text ("Other") input: question text → draft. */
  const [others, setOthers] = useState<Readonly<Record<string, string>>>({});

  const pending = interaction.state === 'pending';
  const questionRequest =
    interaction.interactionKind === 'question'
      ? (interaction.request as QuestionRequest | undefined)
      : undefined;

  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setRespondError(null);
    void fn()
      .catch((error: unknown) => {
        setRespondError(error);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const decide = (decision: 'approved' | 'rejected'): void => {
    run(() =>
      klient
        .session(sessionId)
        .service(ISessionApprovalService)
        .decide(interaction.interactionId, { decision }),
    );
  };

  const toggleOption = (question: QuestionItem, label: string): void => {
    setSelections((prev) => {
      const current = prev[question.question] ?? [];
      const next =
        question.multiSelect === true
          ? current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label]
          : current.includes(label)
            ? []
            : [label];
      return { ...prev, [question.question]: next };
    });
  };

  const submitAnswers = (): void => {
    const answers: Record<string, string> = {};
    for (const question of questionRequest?.questions ?? []) {
      const parts = [...(selections[question.question] ?? [])];
      const other = (others[question.question] ?? '').trim();
      if (other !== '') parts.push(other);
      if (parts.length > 0) answers[question.question] = parts.join(', ');
    }
    // Mirror the TUI adapter: no answers at all resolves with null.
    const result =
      Object.keys(answers).length > 0 ? { answers, method: 'enter' as const } : null;
    run(() =>
      klient.session(sessionId).service(ISessionQuestionService).answer(interaction.interactionId, result),
    );
  };

  const dismiss = (): void => {
    run(() =>
      klient.session(sessionId).service(ISessionQuestionService).dismiss(interaction.interactionId),
    );
  };

  return (
    <div
      className={`mb-2 max-w-[85%] rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-[11px] ${
        nested === true ? 'mt-2 max-w-full' : ''
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Badge tone={pending ? 'amber' : 'neutral'}>{interaction.interactionKind}</Badge>
        <span className="text-neutral-400">{interaction.state}</span>
        <span className="text-neutral-600">tool: {interaction.toolCallId}</span>
      </div>
      {interaction.request !== undefined ? <JsonView data={interaction.request} /> : null}
      {interaction.response !== undefined ? <JsonView data={interaction.response} /> : null}
      {pending && interaction.interactionKind === 'approval' ? (
        <div className="mt-2 flex gap-2">
          <ActionButton onClick={() => decide('approved')} disabled={busy}>
            Approve
          </ActionButton>
          <ActionButton onClick={() => decide('rejected')} danger disabled={busy}>
            Reject
          </ActionButton>
        </div>
      ) : null}
      {pending && questionRequest !== undefined ? (
        <div className="mt-2">
          {questionRequest.questions.map((question) => (
            <div key={question.question} className="mb-2">
              <div className="text-neutral-300">{question.header ?? question.question}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {question.options.map((option) => {
                  const selected = (selections[question.question] ?? []).includes(option.label);
                  return (
                    <button
                      key={option.label}
                      className={`rounded border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-40 ${
                        selected
                          ? 'border-sky-600 bg-sky-900/50 text-sky-200'
                          : 'border-neutral-700 text-neutral-400 hover:bg-neutral-800'
                      }`}
                      title={option.description}
                      disabled={busy}
                      onClick={() => toggleOption(question, option.label)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <input
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-sky-600"
                placeholder={question.otherLabel ?? 'Other…'}
                value={others[question.question] ?? ''}
                disabled={busy}
                onChange={(e) => {
                  setOthers((prev) => ({ ...prev, [question.question]: e.target.value }));
                }}
              />
            </div>
          ))}
          <div className="flex gap-2">
            <ActionButton onClick={submitAnswers} disabled={busy}>
              Answer
            </ActionButton>
            <ActionButton onClick={dismiss} danger disabled={busy}>
              Dismiss
            </ActionButton>
          </div>
        </div>
      ) : null}
      {respondError !== null ? (
        <div className="mt-2">
          <ErrorLine error={respondError} />
        </div>
      ) : null}
    </div>
  );
}

function NoticeFrameView({ frame }: { frame: NoticeFrame }) {
  const tone =
    frame.level === 'error'
      ? 'bg-red-950/50 text-red-400'
      : frame.level === 'warning'
        ? 'bg-amber-950/40 text-amber-300'
        : 'bg-neutral-900/60 text-neutral-400';
  return (
    <div className={`mb-2 max-w-[85%] rounded px-3 py-1.5 text-[11px] ${tone}`}>
      {frame.source !== undefined ? <span className="text-neutral-500">[{frame.source}] </span> : null}
      {frame.message}
      {frame.detail !== undefined ? <JsonView data={frame.detail} /> : null}
    </div>
  );
}
