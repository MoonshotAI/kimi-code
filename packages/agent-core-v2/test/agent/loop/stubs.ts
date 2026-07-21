/**
 * `loop` test stubs — shared loop and wire doubles for unit tests.
 */
import { toDisposable } from '#/_base/di/lifecycle';
import type { IAgentLoopService, LoopErrorHandler, LoopErrorHandlerRegistrationOptions, Step, Turn } from '#/agent/loop/loop';
import type { StepRequest } from '#/agent/loop/stepRequest';
import { StepRequestQueue, type StepRequestBatch } from '#/agent/loop/stepRequestQueue';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ContentPart } from '#/kosong/contract/message';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { createHooks } from '#/hooks';
import type { Op } from '#/wire/op';
import type { IWireService } from '#/wire/wire';

export interface StubLoopOptions { readonly hasActiveTurn?: boolean; readonly currentId?: string | number; readonly pendingTurnResult?: boolean }
export type StubLoop = IAgentLoopService & {
  readonly queue: StepRequestQueue;
  readonly launches: readonly number[];
  readonly cancels: readonly { readonly turnId?: number; readonly reason?: unknown }[];
  startTurn(): Turn;
  drainNextBatch(context: { append(...messages: ContextMessage[]): void }): StepRequestBatch | undefined;
};
const turnControllers = new WeakMap<Turn, AbortController>();
export function makeTurn(id: number): Turn {
  const controller = new AbortController();
  const turn: Turn = { id, signal: controller.signal, ready: Promise.resolve(), result: Promise.resolve({ type: 'completed', steps: 0, truncated: false }), cancel: (reason) => { controller.abort(reason); return true; } };
  turnControllers.set(turn, controller);
  return turn;
}
function makeStep(turn: Turn, request: StepRequest, queue: StepRequestQueue, at: 'head' | 'tail' = 'tail'): Step {
  queue.enqueue(request, at);
  return { id: request.id, turnId: turn.id, state: 'queued', signal: new AbortController().signal, result: Promise.resolve({ type: 'completed' }), cancel: () => request.abort() };
}
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
function materialize(request: StepRequest, context: { append(...messages: ContextMessage[]): void }): void { if (request.state !== 'pending') return; request.onWillMaterialize(); const messages = request.resolveContextMessages(); if (messages.length) context.append(...messages); request.markMaterialized(); }
export function stubLoopWithHooks(options: StubLoopOptions = {}): StubLoop {
  const hooks = createHooks(['onWillBeginStep', 'onDidFinishStep']) as IAgentLoopService['hooks'];
  const queue = new StepRequestQueue(); const errorHandlers = registry(); const launches: number[] = []; const cancels: { turnId?: number; reason?: unknown }[] = [];
  let active: Turn | undefined; let nextId = typeof options.currentId === 'number' ? options.currentId : 0;
  const startTurn = () => {
    const turn = makeTurn(nextId++);
    const result = options.pendingTurnResult === true ? new Promise<never>(() => {}) : turn.result;
    const configured = { ...turn, result };
    launches.push(configured.id); active = configured; return configured;
  };
  const stub: StubLoop = {
    _serviceBrand: undefined, hooks, queue, launches, cancels, startTurn,
    enqueue(request, enqueueOptions) {
      let turn = active;
      if (request.admission === 'newTurn' || (request.admission === 'activeOrNewTurn' && turn === undefined)) turn = startTurn();
      if (request.admission === 'activeTurnOnly' && turn === undefined) throw new Error('active turn required');
      if (turn === undefined) {
        queue.enqueue(request, enqueueOptions?.at ?? 'tail');
        const assigned = new Promise<never>(() => {}); void assigned.catch(() => undefined);
        return { assigned, abort: () => request.abort() };
      }
      const step = makeStep(turn, request, queue, enqueueOptions?.at ?? 'tail');
      return { assigned: Promise.resolve({ turn, step }), abort: (reason) => step.cancel(reason) };
    },
    async run() { return { type: 'completed', steps: 0, truncated: false }; },
    status() { return { state: active !== undefined ? 'running' : 'idle', activeTurnId: active?.id, pendingTurnIds: [], hasPendingRequests: queue.hasPendingRequests() }; },
    cancel(turnId, reason) { cancels.push({ turnId, reason }); if (active === undefined || (turnId !== undefined && active.id !== turnId)) return false; active.cancel(reason); return true; },
    hasPendingRequests: () => queue.hasPendingRequests(), registerLoopErrorHandler: errorHandlers.register,
    settled: () => Promise.resolve(),
    drainNextBatch(context) { const batch = queue.takeNextBatch(); if (!batch) return undefined; materialize(batch.driver, context); for (const r of batch.merged) materialize(r, context); return batch; },
  };
  return stub;
}
export type StubWire = IWireService & { readonly ops: readonly Op[]; readonly steered: readonly { readonly input: readonly ContentPart[]; readonly origin?: PromptOrigin }[] };
export function stubWire(): StubWire { const ops: Op[] = []; const steered: { input: readonly ContentPart[]; origin?: PromptOrigin }[] = []; return { _serviceBrand: undefined, hooks: createHooks(['onDidRestore']), ops, steered, dispatch: (...incoming: Op[]) => { for (const op of incoming) { ops.push(op); if (op.type === 'turn.steer') steered.push(op.payload as never); } }, replay: async () => {}, signal: () => {}, flush: async () => {}, getModel: () => ({}), subscribe: () => toDisposable(() => {}), onEmission: () => toDisposable(() => {}) } as unknown as StubWire; }
export function stubToolExecutor(): IAgentToolExecutorService { return { _serviceBrand: undefined, execute: async function* () {}, hooks: createHooks(['onBeforeExecuteTool', 'onDidExecuteTool']) as IAgentToolExecutorService['hooks'], recordDupType: () => {}, registerToolCallGuard: () => ({ dispose() {} }), registerUnavailableToolDescriber: () => ({ dispose() {} }), registerMissingToolDescriber: () => ({ dispose() {} }) }; }
