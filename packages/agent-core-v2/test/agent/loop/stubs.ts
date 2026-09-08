import { toDisposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import type { IAgentLoopService, LoopErrorHandler, LoopErrorHandlerRegistrationOptions, LoopNotify, LoopNotifyHandle, LoopPromptSubmit, Turn, TurnResult } from '#/agent/loop/loop';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent, ToolDidExecuteContext, WillExecuteToolEvent } from '#/agent/toolExecutor/toolHooks';
import { OrderedHookSlot } from '#/hooks';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { createHooks } from '#/hooks';
import type { IWireService } from '#/wire/wire';

export interface StubLoopOptions { readonly hasActiveTurn?: boolean; readonly currentId?: string | number; readonly pendingTurnResult?: boolean; readonly manualTurnResult?: boolean }
export type StubLoop = IAgentLoopService & {
  readonly launches: readonly number[];
  readonly cancels: readonly { readonly turnId?: number; readonly reason?: unknown }[];
  readonly queue: { hasPendingRequests(): boolean };
  startTurn(): Turn;
  settleActive(result?: TurnResult): void;
  drainNextBatch(context: { append(...messages: ContextMessage[]): void }): { readonly driver: { readonly kind: string } } | undefined;
};
const turnControllers = new WeakMap<Turn, AbortController>();
export function makeTurn(id: number): Turn {
  const controller = new AbortController();
  const turn: Turn = { id, signal: controller.signal, ready: Promise.resolve(), result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }), cancel: (reason) => { controller.abort(reason); return true; } };
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
export function stubLoopWithHooks(options: StubLoopOptions = {}): StubLoop {
  const hooks = createHooks(['onWillBeginStep', 'onDidFinishStep']) as IAgentLoopService['hooks'];
  const errorHandlers = registry(); const launches: number[] = []; const cancels: { turnId?: number; reason?: unknown }[] = [];
  const pending: PendingEntry[] = [];
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
  const stub: StubLoop = {
    _serviceBrand: undefined, hooks, launches, cancels, startTurn,
    queue: { hasPendingRequests: hasPending },
    settleActive(result = { type: 'completed', steps: 0, truncated: false }) { releaseActiveResult?.(result); },
    submit(prompt: LoopPromptSubmit) {
      const turn = startTurn();
      pending.push({ kind: 'prompt', message: prompt.message, onConsume: prompt.onMaterialize });
      return { turn };
    },
    steer(prompt: LoopPromptSubmit) {
      if (active === undefined) return undefined;
      pending.push({ kind: 'steer', message: prompt.message, onConsume: prompt.onMaterialize });
      return active;
    },
    notify(note: LoopNotify = {}): LoopNotifyHandle {
      const entry: PendingEntry = {
        kind: note.bypassMaxSteps === true ? 'handoff' : note.message !== undefined ? 'message' : 'continuation',
        message: note.message,
        onConsume: note.onConsume,
      };
      pending.push(entry);
      let dropped = false;
      return {
        get dropped() { return dropped; },
        drop: () => {
          if (dropped) return;
          dropped = true;
          const index = pending.indexOf(entry);
          if (index >= 0) pending.splice(index, 1);
          note.onDrop?.();
        },
      };
    },
    status() { return { state: active !== undefined ? 'running' : 'idle', activeTurnId: active?.id, pendingTurnIds: [], hasPendingRequests: hasPending() }; },
    cancel(turnId, reason) { cancels.push({ turnId, reason }); if (active === undefined || (turnId !== undefined && active.id !== turnId)) return false; active.cancel(reason); return true; },
    cancelFromUser(turnId) { stub.cancel(turnId); },
    tryAcquireQuiescence: () => toDisposable(() => {}),
    hasPendingRequests: hasPending,
    registerLoopErrorHandler: errorHandlers.register,
    settled: () => Promise.resolve(),
    drainNextBatch(context) {
      const batch = pending.splice(0);
      if (batch.length === 0) return undefined;
      for (const entry of batch) {
        entry.onConsume?.();
        if (entry.message !== undefined && entry.message.content.length > 0) context.append(entry.message);
      }
      return { driver: { kind: batch[0]!.kind } };
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
}
export function stubWire(): IWireService { return { _serviceBrand: undefined, seal: async () => {}, appendRecord: () => {}, readJournal: async function* () {}, flush: async () => {}, drainPersisted: async () => {}, lineCount: () => 0, lastContextClearLine: () => undefined, journalPath: () => undefined }; }
export function stubToolExecutor(): IAgentToolExecutorService { return { _serviceBrand: undefined, execute: async function* () {}, onBeforeExecuteTool: Event.None as Event<BeforeToolExecuteEvent>, onWillExecuteTool: Event.None as Event<WillExecuteToolEvent>, hooks: { onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>() }, recordDupType: () => {}, registerToolCallGuard: () => ({ dispose() {} }), registerUnavailableToolDescriber: () => ({ dispose() {} }), registerMissingToolDescriber: () => ({ dispose() {} }) }; }
