import { toDisposable } from '#/_base/di/lifecycle';
import type { IAgentLoopService, LoopErrorHandler, LoopErrorHandlerRegistrationOptions, LoopNotify, LoopNotifyEntry, PromptHandle, PromptPayload, Turn, TurnResult } from '#/agent/loop/loop';
import type { LoopHooks } from '#/agent/loop/core/contract/hook';
import { ToolExecutor } from '#/tool/executor';
import type { HistoryMessage, UserEntry } from '#human/agent/turn';
import { contextFromHistoryEntry, historyFromContext } from '#/agent/loop/history';
import { UNKNOWN_CAPABILITY } from '#/llm-adapter/contract/capability';

export function submitPromptTurn(
  loop: IAgentLoopService,
  input: UserEntry,
): { readonly turn: Turn } {
  void loop.start();
  const { id } = loop.submit(input);
  const handle = loop.promptHandle(id);
  if (handle === undefined) throw new Error(`missing prompt handle for ${id}`);
  let backing: Turn | undefined;
  let settledCancelled = false;
  void handle.launched.then((turn) => {
    backing = turn;
  });
  void handle.completion.then((completion) => {
    settledCancelled = completion.state === 'cancelled';
  });
  const controller = new AbortController();
  const result: Promise<TurnResult> = handle.launched.then(
    (turn) =>
      turn?.result ??
      handle.completion.then((completion) => {
        if (completion.result !== undefined) return completion.result;
        if (completion.state === 'cancelled') {
          return { type: 'cancelled', steps: 0, reason: undefined } as TurnResult;
        }
        return new Promise<TurnResult>(() => {});
      }),
  );
  return {
    turn: {
      get id() {
        return backing?.id;
      },
      get state() {
        return backing?.state ?? (settledCancelled ? 'cancelled' : 'queued');
      },
      signal: controller.signal,
      ready: handle.launched.then(async (turn) => {
        await turn?.ready;
      }),
      result,
      cancel: (reason) => loop.cancel({ promptId: id }, reason),
    },
  };
}
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent, ToolDidExecuteContext, WillExecuteToolEvent } from '#/agent/toolExecutor/toolHooks';
import { OrderedHookSlot } from '#/hooks';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { createHooks } from '#/hooks';
import type { IWireService } from '#/wire/wire';

import { stubAgentWire } from '../../wire/stubs';

export interface StubLoopOptions { readonly hasActiveTurn?: boolean; readonly currentId?: string | number; readonly pendingTurnResult?: boolean; readonly manualTurnResult?: boolean }
export type StubTurn = Turn & { readonly id: number };
export type StubLoop = IAgentLoopService & {
  readonly launches: readonly number[];
  readonly cancels: readonly { readonly turnId?: number; readonly reason?: unknown }[];
  readonly queue: { hasPendingRequests(): boolean };
  readonly batchStartingHooks: Array<LoopHooks['tool.batch-starting']>;
  startTurn(): StubTurn;
  resetLoop(): Promise<void>;
  settleActive(result?: TurnResult): void;
  drainNextBatch(context?: IAgentLoopService, kinds?: readonly string[]): { readonly driver: { readonly kind: string } } | undefined;
  flushReminders(): void;
};
const turnControllers = new WeakMap<Turn, AbortController>();
export function makeTurn(id: number): StubTurn {
  const controller = new AbortController();
  const turn: StubTurn = { id, signal: controller.signal, ready: Promise.resolve(), result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }), cancel: (reason) => { controller.abort(reason); return true; } };
  turnControllers.set(turn, controller);
  return turn;
}
interface PendingEntry { readonly kind: string; readonly message?: ContextMessage; readonly onConsume?: () => void }
function registry(): { handlers: LoopErrorHandler[]; register: IAgentLoopService['registerLoopErrorHandler'] } {
  const handlers: LoopErrorHandler[] = [];
  const remove = (id: string) => { const i = handlers.findIndex((h) => h.id === id); if (i >= 0) handlers.splice(i, 1); };
  const register = (handler: LoopErrorHandler, options: LoopErrorHandlerRegistrationOptions = {}) => {
    remove(handler.id); const target = options.before ?? options.after;
    if (target === undefined) handlers.push(handler); else { const i = handlers.findIndex((h) => h.id === target); if (i < 0) throw new Error(`Loop error handler target "${target}" is not registered`); handlers.splice(options.before !== undefined ? i : i + 1, 0, handler); }
    return toDisposable(() => remove(handler.id));
  };
  return { handlers, register };
}
export class StubEffectiveProfileReader {
  async applyProfile(): Promise<void> {}
  useProfile(): void {}
  update(): void {}
  setThinking(): void {}
  data() { return { modelCapabilities: UNKNOWN_CAPABILITY, thinkingLevel: 'off', systemPrompt: '' }; }
  getEffectiveThinkingLevel() { return 'off' as const; }
  resolveModelContext(): never { throw new Error('model is not configured'); }
  resolveRequestParams() { return {}; }
  getModelCapabilities() { return UNKNOWN_CAPABILITY; }
  getModelProviderType() { return undefined; }
  getMaxOutputSize() { return undefined; }
  hasModel() { return false; }
  isRunnable() { return false; }
  hasProvider() { return false; }
  getModel() { return ''; }
  getSystemPrompt() { return ''; }
  getActiveToolNames() { return undefined; }
  getAgentsMdWarning() { return undefined; }
  republishStatus(): void {}
  addActiveTool(): void {}
  removeActiveTool(): void {}
}

export function stubLoopWithHooks(options: StubLoopOptions = {}): StubLoop {
  const hooks = createHooks(['onWillBeginStep', 'onDidFinishStep', 'onBeforeSubmitPrompt']) as IAgentLoopService['hooks'];
  const errorHandlers = registry(); const launches: number[] = []; const cancels: { turnId?: number; reason?: unknown }[] = [];
  const pending: PendingEntry[] = [];
  const batchStartingHooks: Array<LoopHooks['tool.batch-starting']> = [];
  const handles = new Map<string, PromptHandle>();
  let active: Turn | undefined; let nextId = typeof options.currentId === 'number' ? options.currentId : 0;
  let releaseActiveResult: ((result: TurnResult) => void) | undefined;
  const startTurn = () => {
    const turn = makeTurn(nextId++);
    const result = options.manualTurnResult === true
      ? new Promise<TurnResult>((resolve) => { releaseActiveResult = resolve; })
      : options.pendingTurnResult === true ? new Promise<never>(() => {}) : turn.result;
    const configured = { ...turn, result };
    launches.push(configured.id); active = configured; return configured;
  };
  const hasPending = () => pending.length > 0;
  const messages: ContextMessage[] = [];
  const stub: StubLoop = {
    _serviceBrand: undefined, hooks, launches, cancels, startTurn, batchStartingHooks,
    requester: {} as IAgentLoopService['requester'],
    registerToolBatchStarting(hook) {
      batchStartingHooks.push(hook);
      return toDisposable(() => {
        const index = batchStartingHooks.indexOf(hook);
        if (index >= 0) batchStartingHooks.splice(index, 1);
      });
    },
    start: async () => {},
    baselineTools: () => [],
    setProfile: async () => {},
    bindProfile: async () => {},
    applyBindingSnapshot: async () => {},
    setModel: async (model) => ({ model }),
    applyProfile: async () => {},
    useProfile: () => {},
    update: () => {},
    setThinking: () => {},
    data: () => ({ modelCapabilities: UNKNOWN_CAPABILITY, thinkingLevel: 'off', systemPrompt: '' }),
    getEffectiveThinkingLevel: () => 'off',
    resolveModelContext: () => { throw new Error('model is not configured'); },
    resolveRequestParams: () => ({}),
    getModelCapabilities: () => UNKNOWN_CAPABILITY,
    getModelProviderType: () => undefined,
    getMaxOutputSize: () => undefined,
    hasModel: () => false,
    isRunnable: () => false,
    hasProvider: () => false,
    getModel: () => '',
    getSystemPrompt: () => '',
    getActiveToolNames: () => undefined,
    getAgentsMdWarning: () => undefined,
    republishStatus: () => {},
    addActiveTool: () => {},
    removeActiveTool: () => {},
    history: () => messages,
    historyRevision: () => 0,
    replaceHistory(next, _reason, onAccepted) {
      messages.splice(0, messages.length, ...next.map((entry) => contextFromHistoryEntry(entry)));
      onAccepted?.();
      return true;
    },
    initializeHistory: async (next) => { stub.replaceHistory(next); },
    queue: { hasPendingRequests: hasPending },
    settleActive(result = { type: 'completed', steps: 0, truncated: false }) { releaseActiveResult?.(result); },
    submit: ((input: UserEntry | PromptPayload) => {
      if ('input' in input) throw new Error('client submit is not supported by this stub');
      const turn = startTurn();
      const id = input.meta?.promptId ?? 'p';
      const message: ContextMessage = {
        ...input.message,
        origin: input.meta?.origin as PromptOrigin | undefined,
      };
      pending.push({ kind: 'prompt', message });
      handles.set(id, {
        id,
        userMessageId: id,
        createdAt: '',
        state: 'running',
        message,
        launched: Promise.resolve(turn),
        completion: new Promise(() => {}),
      });
      return { id };
    }) as StubLoop['submit'],
    steer: async () => {},
    remind(...entries: readonly HistoryMessage[]): void {
      for (const entry of entries) {
        pending.push({ kind: 'message', message: contextFromHistoryEntry(entry) });
      }
    },
    notifyClient: async (input: LoopNotifyEntry) => {
      const { id } = stub.notify(input);
      const handle = stub.promptHandle(id);
      const turn = await handle?.launched;
      await turn?.ready;
      if (turn?.id === undefined) {
        return {
          prompt_id: id,
          created_at: handle?.createdAt ?? '',
          state: handle?.state === 'blocked' ? 'blocked' : 'queued',
          steered: false,
        };
      }
      return {
        turn_id: turn.id,
        prompt_id: id,
        created_at: handle?.createdAt ?? '',
        state: 'running',
        steered: true,
      };
    },
    notify: ((note: LoopNotify | LoopNotifyEntry = {}) => {
      if ('meta' in note) {
        const { id } = stub.submit(note);
        return { id, dropped: false, drop: () => {} };
      }
      const entry: PendingEntry = {
        kind: note.bypassMaxSteps === true ? 'handoff' : note.message !== undefined ? 'message' : 'continuation',
        message: note.message,
        onConsume: note.onConsume,
      };
      pending.push(entry);
      let dropped = false;
      return {
        id: note.message?.id ?? 'n',
        get dropped() { return dropped; },
        drop: () => {
          if (dropped) return;
          dropped = true;
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          note.onDrop?.();
        },
      };
    }) as unknown as StubLoop['notify'],
    sendNow: ((input: LoopNotifyEntry | readonly string[]) => {
      if (Array.isArray(input)) return Promise.resolve();
      return stub.submit(input as LoopNotifyEntry);
    }) as unknown as StubLoop['sendNow'],
    snapshot() {
      return {
        state: active !== undefined ? 'running' : 'idle',
        activeTurnId: active?.id,
        activePromptId: undefined,
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: hasPending(),
        turn: undefined,
        activeTraceId: undefined,
      };
    },
    promptHandle: (id) => handles.get(id),
    cancel(target, reason) { cancels.push({ turnId: target?.turnId, reason }); if (target?.promptId !== undefined) return true; if (active === undefined || (target?.turnId !== undefined && active.id !== target.turnId)) return false; active.cancel(reason); return true; },
    detachTool: () => {},
    abortTool: () => {},
    tryAcquireQuiescence: () => toDisposable(() => {}),
    tryAcquireHistorySnapshot: () => toDisposable(() => {}),
    resetLoop: () => Promise.resolve(),
    registerLoopErrorHandler: errorHandlers.register,
    settled: () => Promise.resolve(),
    retry: async () => { throw new Error('retry is not supported by this stub'); },
    close: () => Promise.resolve(),
    drainNextBatch(context, kinds) {
      const batch = kinds === undefined
        ? pending.splice(0)
        : pending.filter((entry) => {
            if (!kinds.includes(entry.kind)) return false;
            const index = pending.indexOf(entry);
            if (index >= 0) pending.splice(index, 1);
            return true;
          });
      if (batch.length === 0) return undefined;
      for (const entry of batch) {
        entry.onConsume?.();
        if (context !== undefined && entry.message !== undefined && entry.message.content.length > 0) {
          context.replaceHistory(historyFromContext([...context.history(), entry.message]), 'fork');
        }
      }
      return { driver: { kind: batch[0]!.kind } };
    },
    flushReminders() {
      stub.drainNextBatch(stub, ['message']);
    },
  };
  return stub;
}
export async function runWillBeginStepHooks(
  loop: IAgentLoopService,
  firstStepOfTurn = false,
): Promise<void> {
  await loop.hooks.onWillBeginStep.run({
    turnId: 0,
    step: 0,
    firstStepOfTurn,
    signal: new AbortController().signal,
  });
  if ('flushReminders' in loop && typeof loop.flushReminders === 'function') loop.flushReminders();
  else if ('drainNextBatch' in loop && typeof loop.drainNextBatch === 'function') loop.drainNextBatch(loop);
}
export function stubWire(): IWireService { return stubAgentWire(); }
export function stubToolExecutor(): IAgentToolExecutorService {
  return {
    _serviceBrand: undefined,
    executor: new ToolExecutor([]),
    registerHook: () => toDisposable(() => {}),
    registerLegacyStarting: () => toDisposable(() => {}),
    handlers: () => [],
    handler: () => undefined,
    handlerForCall: () => undefined,
    release: () => {},
    recordDupType: () => {},
  };
}
