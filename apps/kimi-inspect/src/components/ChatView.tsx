/**
 * Main view — the conversation of the active session + agent, rendered from
 * the message protocol (`/api/v3/ws` + `GET /api/v1/sessions/{id}/history`):
 *
 *  - Persisted state comes from the REST history endpoint only: the initial
 *    load reads the newest page, a full refresh re-reads it and re-covers
 *    the previously loaded window, and "load earlier" pages further with a
 *    `before_turn` cursor.
 *  - The WS channel carries the recovery payload and all live traffic; both
 *    are applied to the store through the same idempotent replace-by-id
 *    path (delta family appended by id, entity content authoritative), so
 *    there is no reset/buffer/cursor machinery.
 *  - Every subscribe ack (initial and reconnect) triggers an `after_step`
 *    catch-up from the newest terminal step; an empty catch-up whose
 *    anchor vanished (undo/clear while away) falls back to a full refresh.
 *
 * Rendering groups the flat timeline by turn (system markers stay
 * standalone) and is typed entirely by the protocol schemas
 * (`@moonshot-ai/kap-server/protocol`). Prompts/cancels go through the
 * `IAgentPromptService` / `IAgentLoopService` channels over the debug RPC
 * surface (`/api/v1/debug`); the running indicator derives from
 * `session.state`.
 */

import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { IAgentPromptService } from '@moonshot-ai/agent-core-v2/agent/prompt/prompt';
import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  AssistantMessage,
  InteractionMessage,
  InteractionQuestionItem,
  SessionStateMessage,
  StepMessage,
  SystemMessage,
  TaskMessage,
  ThinkingMessage,
  TodoMessage,
  ToolCallMessage,
  TurnMessage,
  UserMessage,
} from '@moonshot-ai/kap-server/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { AuditTrail } from '../audit/trail';
import { useConnection } from '../connection';
import type { SearchHit } from '../search/api';
import { ChatChannel } from '../transcript/channel';
import {
  EMPTY_CHAT_STATE,
  hasTurnId,
  type ChatState,
  type TimelineEntry,
} from '../transcript/store';
import { ActionButton, Badge, ErrorLine, JsonView, relTime } from '../ui';
import { ChatSearchBar } from './ChatSearchBar';

const noopSubscribe = () => () => {};

/** Active session id for deeply nested interaction views (approve/answer buttons). */
const SessionContext = createContext<string>('');

/**
 * A navigation request into the chat timeline (e.g. from a search hit). The
 * channel pages backwards until the turn enters the loaded window, then
 * scrolls it into view and flashes it briefly.
 */
export interface ChatJump {
  /** Turn to locate (`t<N>`); omitted = switch session/agent only, no scroll. */
  readonly turnId?: string | undefined;
  /** Step within the turn (`t<N>.<M>`); falls back to the turn card. */
  readonly stepId?: string | undefined;
  /** Changes on every request so re-clicking the same hit re-triggers. */
  readonly nonce: number;
}

interface ChatChannelState {
  /** Null until the effect has created the channel (pre-ready / no session). */
  readonly channel: ChatChannel | null;
  readonly state: ChatState;
  /** Records every step that built the store (audit panel data source). */
  readonly trail: AuditTrail | null;
  /** True once the initial REST page load succeeded. */
  readonly loaded: boolean;
  /** Set when the initial/refresh load failed. */
  readonly loadError: unknown;
}

/**
 * Owns the channel (store + REST + WS) for one (sessionId, agentId) pair.
 */
function useChatChannel(
  sessionId: string | null,
  agentId: string,
  ready: boolean,
  captureAnchor: () => void,
): ChatChannelState {
  const { baseUrl, config } = useConnection();
  const token = config.token.trim();
  const [channel, setChannel] = useState<ChatChannel | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    if (!ready || sessionId === null) return;
    const authToken = token === '' ? undefined : token;
    const next = new ChatChannel({
      baseUrl,
      token: authToken,
      sessionId,
      agentId,
      onWillReplace: captureAnchor,
      onLoaded: () => {
        setLoaded(true);
        setLoadError(null);
      },
      onLoadError: (error) => {
        setLoadError(error);
      },
    });
    setChannel(next);
    setLoaded(false);
    setLoadError(null);
    next.start();
    return () => {
      next.close();
      setChannel(null);
    };
  }, [sessionId, agentId, ready, baseUrl, token, captureAnchor]);

  const state = useSyncExternalStore(
    channel?.store.subscribe ?? noopSubscribe,
    () => channel?.store.getState() ?? EMPTY_CHAT_STATE,
  );
  return {
    channel,
    state,
    trail: channel?.trail ?? null,
    loaded,
    loadError,
  };
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
  /** Hands the audit trail of the current channel up to the app shell (the audit panel lives in the right dock, not inside this view). */
  onTrailChange?: (trail: AuditTrail | null) => void;
  /** Pending navigation into the timeline (search result click). */
  jump?: ChatJump | null | undefined;
  /** Called once the jump has been processed (or found un-actionable). */
  onJumpHandled?: (() => void) | undefined;
  /** Hands an in-chat search hit up to the app shell (agent switch + jump). */
  onOpenSearchHit?: ((hit: SearchHit) => void) | undefined;
}) {
  const { klient } = useConnection();
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Distance from the scroll bottom captured before a prepend (restore anchor). */
  const anchorRef = useRef<number | null>(null);
  /** Whether the viewport was pinned to the bottom before the last update. */
  const stickBottomRef = useRef(true);
  /** The jump target being flashed (cleared on a timer). */
  const [flash, setFlash] = useState<{ turnId: string; stepId?: string | undefined } | null>(null);

  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (el !== null) anchorRef.current = el.scrollHeight - el.scrollTop;
  }, []);

  const { channel, state, trail, loaded, loadError } = useChatChannel(
    sessionId,
    agentId,
    ready,
    captureAnchor,
  );
  const entries = state.entries;

  // The audit panel is rendered by the app shell's right dock; report the
  // trail (null while no channel exists) so it can subscribe to it there.
  useEffect(() => {
    onTrailChange?.(trail);
  }, [onTrailChange, trail]);

  // Jump navigation (search result click): once the channel has loaded, page
  // backwards until the target turn enters the window, then scroll to the
  // step (or the turn card) and flash it briefly. A turn that never appears
  // (cut by an undo) degrades to no scroll.
  useEffect(() => {
    if (jump === null || jump === undefined || !loaded || channel === null || sessionId === null) {
      return;
    }
    if (jump.turnId === undefined) {
      onJumpHandled?.();
      return;
    }
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    const turnId = jump.turnId;
    const stepId = jump.stepId;
    void (async () => {
      stickBottomRef.current = false;
      const store = channel.store;
      try {
        while (
          !hasTurnId(store.getState().entries, turnId) &&
          store.getState().hasMoreOlder &&
          !isCancelled()
        ) {
          const before = store.getState().entries.length;
          await channel.loadOlder();
          if (store.getState().entries.length === before) break;
        }
      } catch {
        // A failed older-page load leaves the window as-is; degrade to no scroll.
      }
      if (cancelled) return;
      if (!hasTurnId(store.getState().entries, turnId)) {
        onJumpHandled?.();
        return;
      }
      setFlash({ turnId, stepId });
      // The prepend renders asynchronously; wait two frames before scrolling.
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
  }, [jump, loaded, channel, sessionId, onJumpHandled]);

  // The flash highlight clears itself after a short moment.
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
  }, [entries]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadOlder = async () => {
    if (channel === null || loadingOlder) return;
    captureAnchor();
    setLoadingOlder(true);
    setOlderError(null);
    try {
      await channel.loadOlder();
    } catch (error) {
      anchorRef.current = null;
      setOlderError(error);
      trail?.recordEvent(
        'older-error',
        error instanceof Error ? error.message : String(error),
        channel.store.getState(),
      );
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
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) void loadOlderRef.current();
      },
      { root, rootMargin: '400px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [hasMoreOlder, loaded, olderError, loadingOlder]);

  const running = state.sessionState?.busy === true || isAnyTurnRunning(entries);
  const pendingCount = [...state.interactions.values()].filter(
    (interaction) => interaction.state === 'pending',
  ).length;

  // Interactions render inline at their anchor tool call; entities without
  // an anchor (or whose anchor is outside the loaded window) collect here
  // and render floating at the bottom. Unanchored tasks (no tool call
  // references them, e.g. shell-command tasks) do the same.
  const anchoredToolCallIds = useMemo(() => collectToolCallIds(entries), [entries]);
  const unanchoredInteractions = [...state.interactions.values()].filter(
    (interaction) =>
      interaction.tool_call_id === undefined || !anchoredToolCallIds.has(interaction.tool_call_id),
  );
  const anchoredTaskIds = useMemo(() => collectTaskIds(entries), [entries]);
  const unanchoredTasks = [...state.tasks.values()].filter(
    (task) => !anchoredTaskIds.has(task.task_id),
  );
  const latestTodo = latestTodoOf(state.todos);

  const send = async () => {
    if (sessionId === null || input.trim() === '' || running) return;
    const text = input.trim();
    setInput('');
    setSendError(null);
    try {
      await klient
        .session(sessionId)
        .agent(agentId)
        .service(IAgentPromptService)
        .submit({ input: [{ type: 'text', text }] });
      trail?.recordEvent('prompt', text, state);
    } catch (error) {
      setSendError(error);
    }
  };

  const cancel = async () => {
    if (sessionId === null) return;
    try {
      await klient.session(sessionId).agent(agentId).service(IAgentLoopService).cancelFromUser();
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
          {pendingCount > 0 ? <Badge tone="amber">{pendingCount} pending</Badge> : null}
          {state.sessionState !== undefined ? (
            <SessionStateBadges sessionState={state.sessionState} />
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
                Failed to load the session history — the server may be too old to expose the
                history API.
              </div>
            </div>
          ) : null}
          {entries.length === 0 && loadError === null ? (
            <div className="text-[12px] text-neutral-600 italic">
              {loaded ? 'Empty transcript — send a prompt below.' : 'Loading transcript…'}
            </div>
          ) : null}
          {latestTodo !== undefined && latestTodo.items.length > 0 ? (
            <TodoCard todo={latestTodo} />
          ) : null}
          <Timeline items={entries} interactions={state.interactions} tasks={state.tasks} flash={flash} />
          {unanchoredInteractions.map((interaction) => (
            <InteractionEntityView key={interaction.interaction_id} interaction={interaction} />
          ))}
          {unanchoredTasks.map((task) => (
            <TaskCard key={task.task_id} task={task} />
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
    </SessionContext.Provider>
  );
}

// ---------------------------------------------------------------- timeline

type RenderItem =
  | {
      readonly kind: 'group';
      readonly turnId: string;
      readonly turn: TurnMessage | undefined;
      readonly items: readonly TimelineEntry[];
    }
  | { readonly kind: 'system'; readonly key: string; readonly message: SystemMessage };

function groupTimeline(entries: readonly TimelineEntry[]): RenderItem[] {
  interface GroupDraft {
    turn?: TurnMessage;
    items: TimelineEntry[];
  }
  const drafts = new Map<string, GroupDraft>();
  const order: (
    | { kind: 'group'; turnId: string }
    | { kind: 'system'; key: string; message: SystemMessage }
  )[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (message.type === 'system') {
      order.push({ kind: 'system', key: entry.key, message });
      continue;
    }
    let draft = drafts.get(message.turn_id);
    if (draft === undefined) {
      draft = { items: [] };
      drafts.set(message.turn_id, draft);
      order.push({ kind: 'group', turnId: message.turn_id });
    }
    if (message.type === 'turn') draft.turn = message;
    draft.items.push(entry);
  }
  return order.map((item) =>
    item.kind === 'system'
      ? item
      : {
          kind: 'group',
          turnId: item.turnId,
          turn: drafts.get(item.turnId)?.turn,
          items: drafts.get(item.turnId)?.items ?? [],
        },
  );
}

function Timeline({
  items,
  interactions,
  tasks,
  flash,
}: {
  items: readonly TimelineEntry[];
  interactions: ReadonlyMap<string, InteractionMessage>;
  tasks: ReadonlyMap<string, TaskMessage>;
  flash?: { turnId: string; stepId?: string | undefined } | null | undefined;
}) {
  const renderItems = useMemo(() => groupTimeline(items), [items]);
  return (
    <>
      {renderItems.map((item) =>
        item.kind === 'system' ? (
          // Native virtual screen: the browser skips layout/paint for
          // off-screen items and remembers their last rendered size.
          <div
            key={item.key}
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 60px' }}
          >
            <SystemMarkerView message={item.message} />
          </div>
        ) : (
          <div
            key={`turn:${item.turnId}`}
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 200px' }}
          >
            <TurnGroupView
              turnId={item.turnId}
              turn={item.turn}
              items={item.items}
              interactions={interactions}
              tasks={tasks}
              flash={flash}
            />
          </div>
        ),
      )}
    </>
  );
}

function isAnyTurnRunning(entries: readonly TimelineEntry[]): boolean {
  return entries.some(
    (entry) => entry.message.type === 'turn' && entry.message.state === 'running',
  );
}

function collectToolCallIds(entries: readonly TimelineEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.message.type === 'tool_call') ids.add(entry.message.tool_call_id);
  }
  return ids;
}

function collectTaskIds(entries: readonly TimelineEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.message.type === 'tool_call' && entry.message.task_id !== undefined) {
      ids.add(entry.message.task_id);
    }
  }
  return ids;
}

function latestTodoOf(todos: ReadonlyMap<string, TodoMessage>): TodoMessage | undefined {
  let latest: TodoMessage | undefined;
  for (const todo of todos.values()) {
    if (latest === undefined || todo.timestamp > latest.timestamp) latest = todo;
  }
  return latest;
}

// ---------------------------------------------------------------- turn group

function TurnGroupView({
  turnId,
  turn,
  items,
  interactions,
  tasks,
  flash,
}: {
  turnId: string;
  turn: TurnMessage | undefined;
  items: readonly TimelineEntry[];
  interactions: ReadonlyMap<string, InteractionMessage>;
  tasks: ReadonlyMap<string, TaskMessage>;
  flash?: { turnId: string; stepId?: string | undefined } | null | undefined;
}) {
  const turnFlashed = flash?.turnId === turnId && flash.stepId === undefined;
  return (
    <div
      data-turn-id={turnId}
      className={`mb-3 rounded-lg border bg-neutral-900/30 ${
        turnFlashed ? 'border-sky-600' : 'border-neutral-800'
      }`}
    >
      <div className="flex items-center gap-2 border-b border-neutral-800/60 px-3 py-1.5">
        <span className="font-mono text-[10px] text-neutral-500">{turnId}</span>
        {turn !== undefined ? (
          <>
            <Badge tone={turn.origin.kind === 'user' ? 'sky' : 'neutral'}>{turn.origin.kind}</Badge>
            <Badge tone={turn.state === 'running' ? 'amber' : 'green'}>{turn.state}</Badge>
            {turn.started_at !== undefined ? (
              <span className="text-[10px] text-neutral-600">
                {relTime(Date.parse(turn.started_at))}
              </span>
            ) : null}
            {turn.usage !== undefined ? (
              <span className="ml-auto text-[10px] text-neutral-600">
                {turnUsageText(turn.usage)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-[10px] text-neutral-700 italic">turn header outside the window</span>
        )}
      </div>
      <div className="px-3 py-2">
        {turn?.attachment_ids !== undefined && turn.attachment_ids.length > 0 ? (
          <AttachmentChips ids={turn.attachment_ids} />
        ) : null}
        {items.map((entry) => (
          <TimelineEntryView
            key={entry.key}
            entry={entry}
            interactions={interactions}
            tasks={tasks}
            flash={flash}
          />
        ))}
      </div>
    </div>
  );
}

function turnUsageText(usage: NonNullable<TurnMessage['usage']>): string {
  const parts: string[] = [];
  if (usage.input_tokens !== undefined) parts.push(`in ${usage.input_tokens}`);
  if (usage.output_tokens !== undefined) parts.push(`out ${usage.output_tokens}`);
  if (usage.cached_tokens !== undefined) parts.push(`cached ${usage.cached_tokens}`);
  if (usage.cost !== undefined) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(' / ');
}

function TimelineEntryView({
  entry,
  interactions,
  tasks,
  flash,
}: {
  entry: TimelineEntry;
  interactions: ReadonlyMap<string, InteractionMessage>;
  tasks: ReadonlyMap<string, TaskMessage>;
  flash?: { turnId: string; stepId?: string | undefined } | null | undefined;
}) {
  const message = entry.message;
  switch (message.type) {
    case 'turn':
      return null;
    case 'step':
      return <StepRow step={message} flashed={flash?.stepId === message.step_id} />;
    case 'user':
      return <UserMessageView message={message} />;
    case 'assistant':
      return <AssistantMessageView message={message} />;
    case 'thinking':
      return <ThinkingMessageView message={message} />;
    case 'tool_call':
      return <ToolCallView call={message} interactions={interactions} tasks={tasks} />;
    case 'system':
      return <SystemMarkerView message={message} />;
  }
}

function StepRow({ step, flashed }: { step: StepMessage; flashed: boolean }) {
  return (
    <div
      data-step-id={step.step_id}
      className={`mb-2 flex flex-wrap items-center gap-2 rounded px-1 py-0.5 text-[10px] text-neutral-600 ${
        flashed ? 'bg-sky-900/20' : ''
      }`}
    >
      <span className="font-mono">{step.step_id}</span>
      <Badge
        tone={
          step.state === 'failed'
            ? 'red'
            : step.state === 'running'
              ? 'amber'
              : step.state === 'interrupted'
                ? 'neutral'
                : 'green'
        }
      >
        {step.state}
      </Badge>
      {step.retry !== undefined ? (
        <Badge tone="red">
          retry {step.retry.failed_attempt}→{step.retry.next_attempt}/{step.retry.max_attempts}:{' '}
          {step.retry.error_name}
        </Badge>
      ) : null}
      {step.finish_reason !== undefined ? <span>finish: {step.finish_reason}</span> : null}
      {step.usage !== undefined ? (
        <span>
          in {step.usage.input_other + step.usage.input_cache_read + step.usage.input_cache_creation}{' '}
          / out {step.usage.output}
        </span>
      ) : null}
      {step.end_reason !== undefined ? <span className="italic">{step.end_reason}</span> : null}
      {step.end_message !== undefined ? <span className="italic">{step.end_message}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- messages

function UserMessageView({ message }: { message: UserMessage }) {
  const isUserInput = message.origin === undefined;
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center gap-2 text-[10px] text-neutral-600">
        <span className="font-mono">{message.message_id}</span>
        {message.origin !== undefined ? (
          <Badge tone="neutral">
            {message.origin.kind === 'cron' ? `cron ${message.origin.cron_id}` : 'channel'}
          </Badge>
        ) : null}
        {message.steered_at !== undefined ? <Badge tone="amber">steered</Badge> : null}
        {message.status === 'running' ? <span className="italic">queued</span> : null}
      </div>
      {isUserInput ? (
        <div className="flex justify-end">
          <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-sky-900/40 px-3 py-2 text-[13px] text-neutral-100">
            {message.text}
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap rounded-lg border border-neutral-800 px-3 py-2 text-[12px] text-neutral-400">
          {message.text}
        </div>
      )}
      {message.attachment_ids !== undefined && message.attachment_ids.length > 0 ? (
        <AttachmentChips ids={message.attachment_ids} />
      ) : null}
      {message.skill_activations !== undefined && message.skill_activations.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {message.skill_activations.map((skill) => (
            <Badge key={skill.skill_name} tone="violet">
              skill: {skill.skill_name}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessageView({ message }: { message: AssistantMessage }) {
  return (
    <div className="mb-2 max-w-[85%]">
      <div className="whitespace-pre-wrap rounded-lg bg-neutral-800/60 px-3 py-2 text-[13px] text-neutral-100">
        {message.text}
        {message.status === 'streaming' ? <span className="text-neutral-500"> ▍</span> : null}
      </div>
    </div>
  );
}

function ThinkingMessageView({ message }: { message: ThinkingMessage }) {
  return (
    <div className="mb-2 max-w-[85%] whitespace-pre-wrap rounded-lg border border-dashed border-neutral-700 px-3 py-2 font-mono text-[11px] text-neutral-500">
      {message.text}
      {message.status === 'streaming' ? <span> ▍</span> : null}
    </div>
  );
}

function AttachmentChips({ ids }: { ids: readonly string[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {ids.map((id) => (
        <span
          key={id}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] text-neutral-400"
        >
          📎 {id}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- tool calls

function ToolCallView({
  call,
  interactions,
  tasks,
}: {
  call: ToolCallMessage;
  interactions: ReadonlyMap<string, InteractionMessage>;
  tasks: ReadonlyMap<string, TaskMessage>;
}) {
  const task = call.task_id !== undefined ? tasks.get(call.task_id) : undefined;
  const linked = [...interactions.values()].filter(
    (interaction) =>
      interaction.interaction_id === call.approval_id ||
      interaction.tool_call_id === call.tool_call_id,
  );
  return (
    <div className="mb-2 max-w-[85%] rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2 font-mono text-[11px]">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge
          tone={call.state === 'error' ? 'red' : call.state === 'running' ? 'amber' : 'neutral'}
        >
          tool
        </Badge>
        <span className="text-neutral-300">{call.name}</span>
        <span className="text-neutral-600 select-all">{call.tool_call_id}</span>
        {call.view !== undefined && call.view !== call.name ? (
          <span className="text-neutral-600">view: {call.view}</span>
        ) : null}
        {call.agent_refs?.map((ref) => (
          <Badge key={ref.agent_id} tone="sky">
            agent: {ref.agent_id}
          </Badge>
        ))}
        {task !== undefined ? <span className="text-neutral-600">task: {task.state}</span> : null}
        {call.todo_id !== undefined ? (
          <span className="text-neutral-600">todo: {call.todo_id}</span>
        ) : null}
      </div>
      {call.input !== undefined ? (
        typeof call.input === 'string' ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">
            {call.input}
          </pre>
        ) : (
          <JsonView data={call.input} />
        )
      ) : call.input_text !== undefined && call.input_text !== '' ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">
          {call.input_text}
        </pre>
      ) : null}
      {call.output !== undefined ? (
        typeof call.output === 'string' ? (
          <pre
            className={`max-h-40 overflow-auto whitespace-pre-wrap ${
              call.state === 'error' ? 'text-red-400' : 'text-neutral-400'
            }`}
          >
            {call.output}
          </pre>
        ) : (
          <JsonView data={call.output} />
        )
      ) : task !== undefined && task.output_tail !== '' ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-neutral-400">
          {task.output_tail}
        </pre>
      ) : null}
      {call.error !== undefined && call.error !== call.output ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-red-400">{call.error}</pre>
      ) : null}
      {call.progress !== undefined ? (
        <div className="mt-1 text-neutral-600">
          progress ({call.progress.kind}):{' '}
          {call.progress.text ?? (call.progress.percent !== undefined ? `${call.progress.percent}%` : call.progress.custom_kind ?? '')}
        </div>
      ) : null}
      {linked.map((interaction) => (
        <InteractionEntityView key={interaction.interaction_id} interaction={interaction} nested />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- interactions

function InteractionEntityView({
  interaction,
  nested,
}: {
  interaction: InteractionMessage;
  nested?: boolean;
}) {
  const { klient } = useConnection();
  const sessionId = useContext(SessionContext);
  const [busy, setBusy] = useState(false);
  const [respondError, setRespondError] = useState<unknown>(null);
  /** Question answers in progress: question id → selected option labels. */
  const [selections, setSelections] = useState<Readonly<Record<string, readonly string[]>>>({});
  /** Question free-text ("Other") input: question id → draft. */
  const [others, setOthers] = useState<Readonly<Record<string, string>>>({});

  const pending = interaction.state === 'pending';
  const questionRequest = interaction.kind === 'question' ? interaction.request : undefined;

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
        .decide(interaction.interaction_id, { decision }),
    );
  };

  const toggleOption = (question: InteractionQuestionItem, label: string): void => {
    setSelections((prev) => {
      const current = prev[question.id] ?? [];
      const next =
        question.multi_select === true
          ? current.includes(label)
            ? current.filter((item) => item !== label)
            : [...current, label]
          : current.includes(label)
            ? []
            : [label];
      return { ...prev, [question.id]: next };
    });
  };

  const submitAnswers = (): void => {
    const answers: Record<string, string> = {};
    for (const question of questionRequest?.questions ?? []) {
      const parts = [...(selections[question.id] ?? [])];
      const other = (others[question.id] ?? '').trim();
      if (other !== '') parts.push(other);
      if (parts.length > 0) answers[question.question] = parts.join(', ');
    }
    // Mirror the TUI adapter: no answers at all resolves with null.
    const result = Object.keys(answers).length > 0 ? { answers, method: 'enter' as const } : null;
    run(() =>
      klient
        .session(sessionId)
        .service(ISessionQuestionService)
        .answer(interaction.interaction_id, result),
    );
  };

  const dismiss = (): void => {
    run(() =>
      klient.session(sessionId).service(ISessionQuestionService).dismiss(interaction.interaction_id),
    );
  };

  return (
    <div
      className={`mb-2 max-w-[85%] rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-[11px] ${
        nested === true ? 'mt-2 max-w-full' : ''
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Badge tone={pending ? 'amber' : 'neutral'}>{interaction.kind}</Badge>
        <span className="text-neutral-400">{interaction.state}</span>
        <span className="text-neutral-600">tool: {interaction.tool_call_id}</span>
      </div>
      {interaction.request !== undefined && questionRequest === undefined ? (
        <JsonView data={interaction.request} />
      ) : null}
      {questionRequest !== undefined && !pending ? <JsonView data={questionRequest} /> : null}
      {interaction.response !== undefined ? <JsonView data={interaction.response} /> : null}
      {pending && interaction.kind === 'approval' ? (
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
            <div key={question.id} className="mb-2">
              <div className="text-neutral-300">{question.header ?? question.question}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {question.options.map((option) => {
                  const selected = (selections[question.id] ?? []).includes(option.label);
                  return (
                    <button
                      key={option.id}
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
                placeholder={question.other_label ?? 'Other…'}
                value={others[question.id] ?? ''}
                disabled={busy}
                onChange={(e) => {
                  setOthers((prev) => ({ ...prev, [question.id]: e.target.value }));
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

// ---------------------------------------------------------------- state entities

function SystemMarkerView({ message }: { message: SystemMessage }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-[10px] text-neutral-600">
        <div className="h-px flex-1 bg-neutral-800" />
        <span className="font-mono">system({message.subtype})</span>
        <span className="font-mono text-neutral-700">{message.system_id}</span>
        {message.at !== undefined ? <span>{relTime(Date.parse(message.at))}</span> : null}
        <div className="h-px flex-1 bg-neutral-800" />
      </div>
      {message.payload !== undefined ? <JsonView data={message.payload} /> : null}
    </div>
  );
}

function TaskCard({ task }: { task: TaskMessage }) {
  const failed =
    task.state === 'failed' || task.state === 'timed_out' || task.state === 'lost';
  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <Badge tone={task.state === 'running' ? 'amber' : failed ? 'red' : 'neutral'}>
          task: {task.kind}
        </Badge>
        <span className="text-neutral-300">{task.description ?? task.task_id}</span>
        <span className="text-neutral-600">
          {task.state}
          {task.detached ? ' (detached)' : ''}
        </span>
        {task.child_agent_id !== undefined ? (
          <Badge tone="sky">agent: {task.child_agent_id}</Badge>
        ) : null}
      </div>
      {task.output_tail !== '' ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-neutral-500">
          {task.output_tail}
        </pre>
      ) : null}
      {task.error !== undefined ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-red-400">
          {task.error}
        </pre>
      ) : null}
      {task.result_summary !== undefined ? (
        <div className="mt-1 text-neutral-500">{task.result_summary}</div>
      ) : null}
    </div>
  );
}

function TodoCard({ todo }: { todo: TodoMessage }) {
  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-[11px]">
      <div className="mb-1 text-neutral-500">todo (latest)</div>
      {todo.items.map((entry, i) => (
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
            className={entry.status === 'done' ? 'text-neutral-600 line-through' : 'text-neutral-300'}
          >
            {entry.title}
          </span>
        </div>
      ))}
    </div>
  );
}

function SessionStateBadges({ sessionState }: { sessionState: SessionStateMessage }) {
  return (
    <>
      {sessionState.pending_interaction !== undefined &&
      sessionState.pending_interaction !== 'none' ? (
        <Badge tone="amber">{sessionState.pending_interaction}</Badge>
      ) : null}
      {sessionState.model !== undefined ? <Badge tone="neutral">{sessionState.model}</Badge> : null}
      {sessionState.permission !== undefined ? (
        <Badge tone="neutral">perm: {sessionState.permission}</Badge>
      ) : null}
      {sessionState.modes?.plan !== undefined ? <Badge tone="violet">plan mode</Badge> : null}
      {sessionState.modes?.swarm !== undefined ? <Badge tone="violet">swarm</Badge> : null}
      {sessionState.goal !== undefined ? (
        <Badge tone={sessionState.goal.status === 'active' ? 'sky' : 'neutral'}>
          goal: {sessionState.goal.status}
        </Badge>
      ) : null}
      {sessionState.context_tokens !== undefined ? (
        <span className="text-[10px] text-neutral-600">
          ctx {sessionState.context_tokens}
          {sessionState.max_context_tokens !== undefined
            ? `/${sessionState.max_context_tokens}`
            : ''}
        </span>
      ) : null}
    </>
  );
}
