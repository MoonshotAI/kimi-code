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
 * transcript data model. Prompts/cancels still go through the v2
 * `IAgentRPCService`; the running indicator derives from transcript state
 * (`meta.activity` / running turns).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import {
  EMPTY_AGENT_STATE,
  itemId,
  type AgentState,
  type InteractionFrame,
  type NoticeFrame,
  type ToolCallFrame,
  type TranscriptFrame,
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
import { fetchTranscriptPage, TRANSCRIPT_PAGE_SIZE } from '../transcript/api';
import { TranscriptChatStore } from '../transcript/store';
import { TranscriptWs } from '../transcript/ws';
import { ActionButton, Badge, ErrorLine, JsonView, relTime } from '../ui';

const noopSubscribe = () => () => {};

function countTurns(items: readonly TranscriptItem[]): number {
  let count = 0;
  for (const item of items) if (item.kind === 'turn') count += 1;
  return count;
}

function oldestTurnId(items: readonly TranscriptItem[]): string | undefined {
  for (const item of items) if (item.kind === 'turn') return item.turnId;
  return undefined;
}

interface TranscriptChannel {
  /** Null until the effect has created the store (pre-ready / no session). */
  readonly store: TranscriptChatStore | null;
  readonly state: AgentState;
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
  const [channel, setChannel] = useState<{ store: TranscriptChatStore } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    if (!ready || sessionId === null) return;
    const store = new TranscriptChatStore();
    const authToken = token === '' ? undefined : token;
    let disposed = false;
    /** While a REST refresh is in flight, WS ops are buffered, then flushed. */
    let fetching = true;
    let buffer: TranscriptOperation[] = [];
    let refreshing = false;

    /** Full-state (re)load: newest page first, then backwards over `before_turn`. */
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      fetching = true;
      buffer = [];
      const prevTurnCount = countTurns(store.getState().items);
      if (prevTurnCount > 0) captureAnchor();
      try {
        const newest = await fetchTranscriptPage({
          baseUrl,
          token: authToken,
          sessionId,
          agentId,
          pageSize: TRANSCRIPT_PAGE_SIZE,
        });
        if (disposed) return;
        store.applyPage(newest, { replace: true });
        // Re-cover the previously loaded window for refreshes (a no-op loop
        // on the initial load, where prevTurnCount === page size at most).
        while (countTurns(store.getState().items) < prevTurnCount && store.getState().hasMoreOlder) {
          const oldest = oldestTurnId(store.getState().items);
          if (oldest === undefined) break;
          const before = countTurns(store.getState().items);
          const page = await fetchTranscriptPage({
            baseUrl,
            token: authToken,
            sessionId,
            agentId,
            beforeTurn: oldest,
            pageSize: TRANSCRIPT_PAGE_SIZE,
          });
          if (disposed) return;
          store.applyPage(page);
          if (countTurns(store.getState().items) === before) break;
        }
        if (!disposed) {
          setLoaded(true);
          setLoadError(null);
        }
      } catch (error) {
        if (!disposed) setLoadError(error);
      } finally {
        fetching = false;
        refreshing = false;
        if (buffer.length > 0) store.applyOps(buffer);
        buffer = [];
      }
    };

    const ws = new TranscriptWs({
      url: baseUrl,
      token: authToken,
      sessionId,
      agentId,
      handlers: {
        onOps: (aid, ops) => {
          if (aid !== agentId) return;
          if (fetching) buffer.push(...ops);
          else store.applyOps(ops);
        },
        onResyncRequired: () => void refresh(),
        onReconnected: () => void refresh(),
      },
    });
    store.onGap = () => void refresh();
    setChannel({ store });
    setLoaded(false);
    setLoadError(null);
    void refresh();
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
  return { store: channel?.store ?? null, state, loaded, loadError };
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

  const { store, state, loaded, loadError } = useTranscriptChannel(
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
    } catch (error) {
      anchorRef.current = null;
      setOlderError(error);
    } finally {
      setLoadingOlder(false);
    }
  };

  const running =
    state.meta.activity === 'turn' ||
    items.some((item) => item.kind === 'turn' && item.state === 'running');

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
    } catch (error) {
      setSendError(error);
    }
  };

  const cancel = async () => {
    if (sessionId === null) return;
    try {
      await klient.session(sessionId).agent(agentId).service(IAgentRPCService).cancel({});
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
          <div className="mb-3 flex justify-center">
            <ActionButton onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : 'Load earlier turns'}
            </ActionButton>
          </div>
        ) : null}
        {olderError !== null ? (
          <div className="mb-2">
            <ErrorLine error={olderError} />
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
        {items.map((item) => (
          <ItemView key={itemId(item)} item={item} tasks={state.tasks} />
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
  );
}

// ---------------------------------------------------------------- items

function ItemView({
  item,
  tasks,
}: {
  item: TranscriptItem;
  tasks: ReadonlyMap<string, TranscriptTask>;
}) {
  switch (item.kind) {
    case 'turn':
      return <TurnView turn={item} tasks={tasks} />;
    case 'marker':
      return <MarkerView marker={item} />;
    case 'taskref':
      return <TaskRefView item={item} task={tasks.get(item.taskId)} />;
  }
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
}: {
  turn: TranscriptTurn;
  tasks: ReadonlyMap<string, TranscriptTask>;
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
        {turn.steps.map((step) => (
          <div key={step.stepId}>
            {step.frames.map((frame) => (
              <FrameView key={frame.frameId} frame={frame} tasks={tasks} />
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

function FrameView({
  frame,
  tasks,
}: {
  frame: TranscriptFrame;
  tasks: ReadonlyMap<string, TranscriptTask>;
}) {
  switch (frame.kind) {
    case 'text':
      if (frame.role === 'user') {
        return (
          <div className="mb-2 flex justify-end">
            <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] text-neutral-100">
              {frame.text}
            </div>
          </div>
        );
      }
      return (
        <div className="mb-2 max-w-[85%] whitespace-pre-wrap rounded-lg bg-neutral-800/60 px-3 py-2 text-[13px] text-neutral-100">
          {frame.text}
        </div>
      );
    case 'thinking':
      return (
        <div className="mb-2 max-w-[85%] whitespace-pre-wrap rounded-lg border border-dashed border-neutral-700 px-3 py-2 font-mono text-[11px] text-neutral-500">
          {frame.text}
        </div>
      );
    case 'tool':
      return <ToolFrameView frame={frame} tasks={tasks} />;
    case 'interaction':
      return <InteractionFrameView frame={frame} />;
    case 'notice':
      return <NoticeFrameView frame={frame} />;
  }
}

function ToolFrameView({
  frame,
  tasks,
}: {
  frame: ToolCallFrame;
  tasks: ReadonlyMap<string, TranscriptTask>;
}) {
  const task = frame.taskId !== undefined ? tasks.get(frame.taskId) : undefined;
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
      {frame.error !== undefined ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-red-400">{frame.error}</pre>
      ) : null}
    </div>
  );
}

function InteractionFrameView({ frame }: { frame: InteractionFrame }) {
  return (
    <div className="mb-2 max-w-[85%] rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-[11px]">
      <div className="mb-1 flex items-center gap-2">
        <Badge tone={frame.state === 'pending' ? 'amber' : 'neutral'}>{frame.interactionKind}</Badge>
        <span className="text-neutral-400">{frame.state}</span>
      </div>
      {frame.request !== undefined ? <JsonView data={frame.request} /> : null}
      {frame.response !== undefined ? <JsonView data={frame.response} /> : null}
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
