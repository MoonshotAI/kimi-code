import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import {
  type QuestionItem,
  type QuestionRequest,
} from '@moonshot-ai/agent-core-v2/agent/interaction/question';
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

import { AuditTrail } from '../audit/trail';
import { useConnection } from '../connection';
import {
  answerQuestion,
  decideApproval,
  dismissQuestion,
  type QuestionAnswerWire,
} from '../interactions/api';
import type { SearchHit } from '../search/api';
import {
  fetchTranscriptAttachment,
  fetchTranscriptOps,
  fetchTranscriptPage,
  TRANSCRIPT_PAGE_SIZE,
} from '../transcript/api';
import {
  createCoalescedRunner,
  hasTurnId,
  oldestTurnId,
  recoverLoadedWindow,
  TranscriptChatStore,
} from '../transcript/store';
import { TranscriptWs } from '../transcript/ws';
import { ActionButton, Badge, ErrorLine, JsonView, relTime } from '../ui';
import { ChatSearchBar } from './ChatSearchBar';

const noopSubscribe = () => () => {};

const SessionContext = createContext<string>('');

export interface ChatJump {
  readonly turnId?: string | undefined;
  readonly stepId?: string | undefined;
  readonly nonce: number;
}

interface TranscriptChannel {
  readonly store: TranscriptChatStore | null;
  readonly state: AgentState;
  readonly trail: AuditTrail | null;
  readonly loaded: boolean;
  readonly loadError: unknown;
}

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
    let fetching = true;
    let buffer: TranscriptOperation[] = [];
    let bufferedSeq: number | undefined;
    let lastSeq: number | undefined;
    let recoverBefore: string | undefined;
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

    const reloadPages = async (): Promise<void> => {
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
  onTrailChange,
  jump,
  onJumpHandled,
  onOpenSearchHit,
}: {
  sessionId: string | null;
  agentId: string;
  ready: boolean;
  onTrailChange?: (trail: AuditTrail | null) => void;
  jump?: ChatJump | null | undefined;
  onJumpHandled?: (() => void) | undefined;
  onOpenSearchHit?: ((hit: SearchHit) => void) | undefined;
}) {
  const { klient, baseUrl, config } = useConnection();
  const [sendError, setSendError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<number | null>(null);
  const stickBottomRef = useRef(true);
  const [flash, setFlash] = useState<{ turnId: string; stepId?: string | undefined } | null>(null);

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

  useEffect(() => {
    onTrailChange?.(trail);
  }, [onTrailChange, trail]);

  useEffect(() => {
    if (jump === null || jump === undefined || !loaded || store === null || sessionId === null) {
      return;
    }
    if (jump.turnId === undefined) {
      onJumpHandled?.();
      return;
    }
    let cancelled = false;
    const turnId = jump.turnId;
    const stepId = jump.stepId;
    void (async () => {
      stickBottomRef.current = false;
      const token = config.token.trim();
      let recoverBefore: string | undefined;
      await recoverLoadedWindow(
        store,
        turnId,
        (beforeTurn) => {
          recoverBefore = beforeTurn;
          return fetchTranscriptPage({
            baseUrl,
            token: token === '' ? undefined : token,
            sessionId,
            agentId,
            beforeTurn,
            pageSize: TRANSCRIPT_PAGE_SIZE,
          });
        },
        () => cancelled,
        (page) => {
          trail?.recordRest(
            { beforeTurn: recoverBefore, pageSize: TRANSCRIPT_PAGE_SIZE },
            'prepend',
            page,
            store.getState(),
          );
        },
      );
      if (cancelled) return;
      if (!hasTurnId(store.getState().items, turnId)) {
        onJumpHandled?.();
        return;
      }
      setFlash({ turnId, stepId });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;
          const root = scrollRef.current;
          const stepEl =
            stepId !== undefined
              ? root?.querySelector(`[data-step-id="${CSS.escape(stepId)}"]`)
              : undefined;
          const target = stepEl ?? root?.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
          target?.scrollIntoView({ block: 'start' });
        });
      });
      onJumpHandled?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [jump, loaded, store, sessionId, agentId, baseUrl, config, trail, onJumpHandled]);

  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(timer);
  }, [flash]);

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

  const anchoredToolCallIds = collectToolCallIds(items);
  const unanchoredInteractions = [...state.interactions.values()].filter(
    (interaction) =>
      interaction.toolCallId === undefined || !anchoredToolCallIds.has(interaction.toolCallId),
  );
  const latestTodo = [...state.todos.values()].at(-1);

  const cancel = async () => {
    if (sessionId === null) return;
    try {
      await klient.session(sessionId).agent(agentId).service(IAgentLoopService).cancel(undefined);
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
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
          <span className="font-mono text-[11px] text-neutral-400">{sessionId}</span>
          <Badge tone="sky">agent: {agentId}</Badge>
          {running ? <Badge tone="amber">turn running</Badge> : <Badge tone="green">idle</Badge>}
          {state.pendingInteractions.size > 0 ? (
            <Badge tone="amber">{state.pendingInteractions.size} pending</Badge>
          ) : null}
        </div>

        <ChatSearchBar sessionId={sessionId} onOpenHit={onOpenSearchHit} />

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
              {loaded ? 'Empty transcript.' : 'Loading transcript…'}
            </div>
          ) : null}
          {latestTodo !== undefined && latestTodo.items.length > 0 ? (
            <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px]">
              <div className="mb-1 text-neutral-500">todo (latest)</div>
              {latestTodo.items.map((entry, i) => (
                <div key={i} className="flex gap-2">
                  <span
                    className={
                      entry.status === 'done'
                        ? 'text-green-500'
                        : entry.status === 'in_progress'
                          ? 'text-sky-400'
                          : 'text-neutral-600'
                    }
                  >
                    {entry.status === 'done' ? '✔' : entry.status === 'in_progress' ? '◐' : '□'}
                  </span>
                  <span
                    className={
                      entry.status === 'done' ? 'text-neutral-600 line-through' : 'text-neutral-300'
                    }
                  >
                    {entry.title}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {items.map((item) => (
            <div
              key={itemId(item)}
              style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
            >
              <ItemView
                item={item}
                tasks={state.tasks}
                interactions={state.interactions}
                attachments={state.attachments}
                flash={flash}
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
          <div className="flex justify-end">
            <ActionButton onClick={() => void cancel()} danger disabled={!running}>
              Cancel
            </ActionButton>
          </div>
        </div>
      </div>
    </SessionContext.Provider>
  );
}

function ItemView({
  item,
  tasks,
  interactions,
  attachments,
  flash,
}: {
  item: TranscriptItem;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
  flash?: { turnId: string; stepId?: string | undefined } | null | undefined;
}) {
  switch (item.kind) {
    case 'turn':
      return (
        <TurnView
          turn={item}
          tasks={tasks}
          interactions={interactions}
          attachments={attachments}
          flash={flash}
        />
      );
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
  flash,
}: {
  turn: TranscriptTurn;
  tasks: ReadonlyMap<string, TranscriptTask>;
  interactions: ReadonlyMap<string, TranscriptInteraction>;
  attachments: ReadonlyMap<string, TranscriptAttachment>;
  flash?: { turnId: string; stepId?: string | undefined } | null | undefined;
}) {
  const turnFlashed = flash?.turnId === turn.turnId && flash.stepId === undefined;
  return (
    <div
      data-turn-id={turn.turnId}
      className={`mb-3 rounded-lg border bg-neutral-900/30 ${
        turnFlashed ? 'border-sky-600' : 'border-neutral-800'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-neutral-800/60 px-3 py-1.5">
        <span className="font-mono text-[10px] text-neutral-500">{turn.turnId}</span>
        <Badge tone={turn.origin.kind === 'user' ? 'sky' : 'neutral'}>{turn.origin.kind}</Badge>
        <Badge tone={turnStateTone(turn.state)}>{turn.state}</Badge>
        {turn.startedAt !== undefined ? (
          <span className="text-[10px] text-neutral-600">
            {relTime(Date.parse(turn.startedAt))}
          </span>
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
          <div
            key={step.stepId}
            data-step-id={step.stepId}
            className={flash?.stepId === step.stepId ? 'rounded bg-sky-900/20' : undefined}
          >
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
    task !== undefined &&
    (task.state === 'failed' || task.state === 'timed_out' || task.state === 'lost');
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
        return (
          <span
            key={id}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-400"
            title={attachment?.mediaType}
          >
            📎{' '}
            <AttachmentLink attachment={attachment} label={label} />
          </span>
        );
      })}
    </div>
  );
}

function AttachmentLink({
  attachment,
  label,
}: {
  attachment: TranscriptAttachment | undefined;
  label: string;
}) {
  const sessionId = useContext(SessionContext);
  const { baseUrl, config } = useConnection();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = attachment?.source;
  if (source === undefined) return label;
  if (source.kind === 'url') {
    return (
      <a href={source.url} target="_blank" rel="noreferrer" className="underline">
        {label}
      </a>
    );
  }
  const download = async (): Promise<void> => {
    setDownloading(true);
    setError(null);
    try {
      const blob = await fetchTranscriptAttachment({
        baseUrl,
        token: config.token.trim() || undefined,
        sessionId,
        source,
      });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = attachment?.name ?? source.fileId;
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(href);
      }, 0);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <button
      type="button"
      className="underline disabled:cursor-wait disabled:opacity-60"
      disabled={downloading}
      title={error ?? undefined}
      onClick={() => void download()}
    >
      {downloading ? 'Downloading…' : label}
    </button>
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
  const linked = [...interactions.values()].filter(
    (interaction) =>
      interaction.interactionId === frame.approvalId || interaction.toolCallId === frame.toolCallId,
  );
  return (
    <div className="mb-2 max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2 font-mono text-[11px]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge
          tone={frame.state === 'error' ? 'red' : frame.state === 'running' ? 'amber' : 'neutral'}
        >
          tool
        </Badge>
        <span className="text-neutral-300">{frame.name}</span>
        <span className="text-neutral-600 select-all">{frame.toolCallId}</span>
        {frame.view !== undefined && frame.view !== frame.name ? (
          <span className="text-neutral-600">view: {frame.view}</span>
        ) : null}
        {frame.agentRefs?.map((ref) => (
          <Badge key={ref.agentId} tone="sky">
            agent: {ref.agentId}
          </Badge>
        ))}
        {task !== undefined ? <span className="text-neutral-600">task: {task.state}</span> : null}
        {frame.todoId !== undefined ? (
          <span className="text-neutral-600">todo: {frame.todoId}</span>
        ) : null}
      </div>
      {frame.input !== undefined ? (
        typeof frame.input === 'string' ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">
            {frame.input}
          </pre>
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
  const { baseUrl, config } = useConnection();
  const sessionId = useContext(SessionContext);
  const [busy, setBusy] = useState(false);
  const [respondError, setRespondError] = useState<unknown>(null);
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [others, setOthers] = useState<Readonly<Record<string, string>>>({});

  const pending = interaction.state === 'pending';
  const questionRequest =
    interaction.interactionKind === 'question'
      ? (interaction.request as QuestionRequest | undefined)
      : undefined;
  const api = { baseUrl, token: config.token, sessionId };

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
    run(() => decideApproval(api, interaction.interactionId, decision));
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
    const answers: Record<string, QuestionAnswerWire> = {};
    for (const [index, question] of (questionRequest?.questions ?? []).entries()) {
      const selected = selections[question.question] ?? [];
      const optionIds = selected.flatMap((label) => {
        const optionIndex = question.options.findIndex((option) => option.label === label);
        return optionIndex < 0 ? [] : [`opt_${index}_${optionIndex}`];
      });
      const other = (others[question.question] ?? '').trim();
      if (other !== '' && optionIds.length > 0) {
        answers[`q_${index}`] = { kind: 'multi_with_other', option_ids: optionIds, other_text: other };
      } else if (other !== '') {
        answers[`q_${index}`] = { kind: 'other', text: other };
      } else if (optionIds.length > 1 || (question.multiSelect === true && optionIds.length > 0)) {
        answers[`q_${index}`] = { kind: 'multi', option_ids: optionIds };
      } else if (optionIds.length === 1) {
        answers[`q_${index}`] = { kind: 'single', option_id: optionIds[0]! };
      }
    }
    if (Object.keys(answers).length === 0) {
      dismiss();
      return;
    }
    run(() => answerQuestion(api, interaction.interactionId, answers, 'enter'));
  };

  const dismiss = (): void => {
    run(() => dismissQuestion(api, interaction.interactionId));
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
      {frame.source !== undefined ? (
        <span className="text-neutral-500">[{frame.source}] </span>
      ) : null}
      {frame.message}
      {frame.detail !== undefined ? <JsonView data={frame.detail} /> : null}
    </div>
  );
}
