import { assign, enqueueActions, fromCallback, setup, type Snapshot } from 'xstate';

import { OrderedHookSlot } from '#/hooks';
import type { AgentRuntimeRestoreEvent } from '#/actor/agentRuntime';
import { USER_PROMPT_ORIGIN } from '#/actor/contextMemory/types';
import { getLoopControl } from '#/actor/loop/internal/access';
import type { Turn, TurnResult } from '#/actor/loop/internal/loop';
import { activateToolExecutorWhenReady } from '#/actor/toolExecutor/internal/executorActivation';
import type { ToolDidExecuteContext } from '#/actor/toolExecutor/toolHooks';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { AgentFullCompaction } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import type { PromptState, PromptSubmitContext } from '../prompt';
import { PromptAborted, PromptCompleted, PromptQueued, PromptSteered } from '../promptEvents';
import {
  appendBlockedPrompt,
  extractCompressionCaptions,
  hostOf,
  injectMessage,
  launchGated,
  materializeDaemonRefs,
  reminderOf,
  type PromptRuntimeContext,
} from './promptIntake';
import {
  stripBundledSkillBlocks,
  type ActivePromptRecord,
  type PromptRecord,
} from './promptRecord';
import { PromptStepRequest } from './promptStepRequests';

export interface PromptHooks {
  readonly onBeforeSubmitPrompt: OrderedHookSlot<PromptSubmitContext>;
}

export interface PromptMachineContext {
  readonly runtime: PromptRuntimeContext;
  readonly hooks: PromptHooks;
  admitted: ReadonlySet<string>;
  reserved: ReadonlySet<string>;
  pending: readonly PromptRecord[];
  launching: PromptRecord | undefined;
  active: ActivePromptRecord | undefined;
  steering: number;
  steered: ReadonlyMap<string, readonly PromptRecord[]>;
}

export type PromptActorSnapshot = Snapshot<unknown> & {
  readonly context: PromptMachineContext;
};

export interface RemovedPromptEntry {
  readonly record: PromptRecord;
  readonly index: number;
}

export interface PromptCommitEvent {
  readonly type: 'prompt.commit';
  readonly admitted: ReadonlySet<string>;
}

export interface PromptReserveEvent {
  readonly type: 'prompt.reserve';
  readonly id: string;
}

export interface PromptReleaseEvent {
  readonly type: 'prompt.release';
  readonly id: string;
}

export interface PromptEnqueueEvent {
  readonly type: 'prompt.enqueue';
  readonly record: PromptRecord;
  readonly reply: { wait: boolean };
}

export interface PromptPumpEvent {
  readonly type: 'prompt.pump';
}

export interface PromptAbortEvent {
  readonly type: 'prompt.abort';
  readonly promptId: string;
  readonly reason: Error;
  readonly reply: { outcome: 'active' | 'pending' | 'missing' };
}

export interface PromptSteerBeginEvent {
  readonly type: 'prompt.steerBegin';
  readonly records: readonly PromptRecord[];
  readonly activeId: string;
  readonly reply: { ok: boolean; removed: readonly RemovedPromptEntry[] };
}

export interface PromptSteerSettleEvent {
  readonly type: 'prompt.steerSettle';
  readonly removed: readonly RemovedPromptEntry[];
  readonly activeId: string;
  readonly turn: Turn | undefined;
  readonly reply: { ok: boolean };
}

interface PromptLaunchStartedEvent {
  readonly type: 'prompt.launchStarted';
  readonly record: PromptRecord;
  readonly turn: Turn;
}

interface PromptLaunchBlockedEvent {
  readonly type: 'prompt.launchBlocked';
  readonly record: PromptRecord;
}

interface PromptLaunchFailedEvent {
  readonly type: 'prompt.launchFailed';
  readonly record: PromptRecord;
}

interface PromptLaunchDeferredEvent {
  readonly type: 'prompt.launchDeferred';
  readonly record: PromptRecord;
}

interface PromptTurnSettledEvent {
  readonly type: 'prompt.turnSettled';
  readonly record: PromptRecord;
  readonly result: TurnResult;
}

type PromptLaunchNotice =
  | PromptLaunchStartedEvent
  | PromptLaunchBlockedEvent
  | PromptLaunchFailedEvent
  | PromptLaunchDeferredEvent;

export type PromptMachineEvent =
  | PromptCommitEvent
  | PromptReserveEvent
  | PromptReleaseEvent
  | PromptEnqueueEvent
  | PromptPumpEvent
  | PromptAbortEvent
  | PromptSteerBeginEvent
  | PromptSteerSettleEvent
  | PromptLaunchNotice
  | PromptTurnSettledEvent
  | AgentRuntimeRestoreEvent;

export function machineContextOf(runtime: PromptRuntimeContext): PromptMachineContext {
  return runtime.getLogicState<PromptMachineContext>();
}

function publishQueued(context: PromptMachineContext, record: PromptRecord, queueLength: number): void {
  if ((record.message.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return;
  void context.runtime.dispatch(
    new PromptQueued({
      agentId: context.runtime.agent.agentId,
      promptId: record.id,
      content: stripBundledSkillBlocks(record.message),
      queueLength,
    }),
  );
}

function publishCompleted(
  context: PromptMachineContext,
  promptId: string,
  reason: 'completed' | 'failed' | 'blocked',
): void {
  void context.runtime.dispatch(
    new PromptCompleted({
      agentId: context.runtime.agent.agentId,
      promptId,
      finishedAt: new Date().toISOString(),
      reason,
    }),
  );
}

function publishAborted(context: PromptMachineContext, promptId: string): void {
  void context.runtime.dispatch(
    new PromptAborted({
      agentId: context.runtime.agent.agentId,
      promptId,
      abortedAt: new Date().toISOString(),
    }),
  );
}

function settledStateOf(result: TurnResult): Extract<PromptState, 'completed' | 'failed' | 'cancelled'> {
  return result.type === 'cancelled' ? 'cancelled' : result.type === 'failed' ? 'failed' : 'completed';
}

interface PromptLaunchInput {
  readonly runtime: PromptRuntimeContext;
  readonly hooks: PromptHooks;
  readonly record: PromptRecord;
}

async function runPromptLaunch(
  input: PromptLaunchInput,
  sendBack: (notice: PromptLaunchNotice) => void,
): Promise<void> {
  const { runtime, hooks, record } = input;
  try {
    if (launchGated(runtime)) {
      sendBack({ type: 'prompt.launchDeferred', record });
      return;
    }
    const { message, captions } = extractCompressionCaptions(record.message);
    await materializeDaemonRefs(runtime, message);
    const submitContext: PromptSubmitContext = { promptMessage: message, isSteer: false, block: false };
    await hooks.onBeforeSubmitPrompt.run(submitContext);
    if (submitContext.block) {
      appendBlockedPrompt(runtime, message, captions);
      sendBack({ type: 'prompt.launchBlocked', record });
      return;
    }
    const request = new PromptStepRequest(message, captions, reminderOf(runtime));
    const turn = (await getLoopControl(runtime.agent).enqueue(request).assigned).turn;
    if (turn === undefined) {
      sendBack({ type: 'prompt.launchDeferred', record });
      return;
    }
    sendBack({ type: 'prompt.launchStarted', record, turn });
  } catch {
    sendBack({ type: 'prompt.launchFailed', record });
  }
}

const promptLaunch = fromCallback(
  ({
    input,
    sendBack,
  }: {
    input: PromptLaunchInput;
    sendBack: (notice: PromptLaunchNotice) => void;
  }) => {
    void runPromptLaunch(input, sendBack);
  },
);

const promptSettlement = fromCallback(
  ({
    input,
    sendBack,
  }: {
    input: ActivePromptRecord;
    sendBack: (notice: PromptTurnSettledEvent) => void;
  }) => {
    void input.turn.result.then((result) => {
      sendBack({ type: 'prompt.turnSettled', record: input, result });
    });
  },
);

async function deliverToolResult(
  runtime: PromptRuntimeContext,
  ctx: ToolDidExecuteContext,
): Promise<void> {
  const delivery = ctx.result.delivery;
  if (delivery === undefined) return;
  const { delivery: _delivery, ...rest } = ctx.result;
  ctx.result = rest as ExecutableToolResult;
  if (delivery.kind === 'steer') await injectMessage(runtime, delivery.message as ContextMessage);
}

const promptEffects = fromCallback(({ input }: { input: PromptRuntimeContext }) => {
  const lifecycle = input.get(IAgentLifecycleService);
  const registration = activateToolExecutorWhenReady(
    lifecycle,
    hostOf(input).scopeContext,
    (executor) =>
      executor.registerDidExecuteHook('prompt-service-delivery', async (ctx, next) => {
        await deliverToolResult(input, ctx);
        await next();
      }),
    { deferToScopeCreated: true },
  );
  const compactionSubscription = lifecycle
    .resolve(input.agent, AgentFullCompaction)
    .onDidFinish(() => {
      input.send({ type: 'prompt.pump' } satisfies PromptPumpEvent);
    });
  return () => {
    registration.dispose();
    compactionSubscription.dispose();
  };
});

export const promptActorLogic = setup({
  types: {} as {
    context: PromptMachineContext;
    input: PromptRuntimeContext;
    events: PromptMachineEvent;
  },
  actors: { promptEffects, promptLaunch, promptSettlement },
  actions: {
    commitAdmitted: assign({
      admitted: ({ event }) => (event as PromptCommitEvent).admitted,
    }),
    reserveId: assign({
      reserved: ({ context, event }) =>
        new Set([...context.reserved, (event as PromptReserveEvent).id]),
    }),
    releaseId: assign({
      reserved: ({ context, event }) => {
        const next = new Set(context.reserved);
        next.delete((event as PromptReleaseEvent).id);
        return next;
      },
    }),
    handleEnqueue: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptEnqueueEvent;
      enqueue.assign({ pending: [...context.pending, e.record] });
      const idle = context.active === undefined && context.launching === undefined;
      e.reply.wait = idle && !launchGated(context.runtime);
      if (!e.reply.wait) publishQueued(context, e.record, context.pending.length + 1);
      enqueue.raise({ type: 'prompt.pump' });
    }),
    handleAbort: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptAbortEvent;
      if (context.active?.id === e.promptId) {
        getLoopControl(context.runtime.agent).cancel(context.active.turn.id, e.reason);
        e.reply.outcome = 'active';
        return;
      }
      const index = context.pending.findIndex((item) => item.id === e.promptId);
      if (index < 0) {
        e.reply.outcome = 'missing';
        return;
      }
      const record = context.pending[index]!;
      enqueue.assign({ pending: context.pending.filter((_, i) => i !== index) });
      record.state = 'cancelled';
      record.launchedDeferred.resolve(undefined);
      record.completionDeferred.resolve({ promptId: e.promptId, result: undefined, state: 'cancelled' });
      publishAborted(context, e.promptId);
      e.reply.outcome = 'pending';
    }),
    handleSteerBegin: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptSteerBeginEvent;
      if (
        context.active?.id !== e.activeId ||
        e.records.some((record) => !context.pending.includes(record))
      ) {
        e.reply.ok = false;
        return;
      }
      const pendingNext = [...context.pending];
      const removed: RemovedPromptEntry[] = [];
      for (const record of e.records) {
        const index = pendingNext.indexOf(record);
        removed.push({ record, index });
        pendingNext.splice(index, 1);
      }
      enqueue.assign({ pending: pendingNext, steering: context.steering + 1 });
      e.reply.ok = true;
      e.reply.removed = removed;
    }),
    handleSteerSettle: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptSteerSettleEvent;
      const steering = context.steering - 1;
      if (e.turn === undefined || context.active?.id !== e.activeId) {
        const pendingNext = [...context.pending];
        for (const { record, index } of [...e.removed].reverse()) {
          pendingNext.splice(index, 0, record);
        }
        enqueue.assign({ pending: pendingNext, steering });
        if (context.active === undefined) enqueue.raise({ type: 'prompt.pump' });
        e.reply.ok = false;
        return;
      }
      const turn = e.turn;
      const records = e.removed.map((entry) => entry.record);
      for (const record of records) {
        record.state = 'steered';
        record.launchedDeferred.resolve(turn);
      }
      const steered = new Map(context.steered);
      steered.set(e.activeId, [...(steered.get(e.activeId) ?? []), ...records]);
      enqueue.assign({ steering, steered });
      void context.runtime.dispatch(
        new PromptSteered({
          agentId: context.runtime.agent.agentId,
          activePromptId: e.activeId,
          promptIds: records.map((record) => record.id),
          content: records.flatMap((record) => stripBundledSkillBlocks(record.message)),
          steeredAt: new Date().toISOString(),
        }),
      );
      e.reply.ok = true;
    }),
    popNextLaunch: assign(({ context }) => ({
      launching: context.pending[0],
      pending: context.pending.slice(1),
    })),
    applyLaunchStarted: enqueueActions(({ event, enqueue }) => {
      const e = event as PromptLaunchStartedEvent;
      const record = e.record;
      record.state = 'running';
      record.launchedDeferred.resolve(e.turn);
      enqueue.assign({
        launching: undefined,
        active: Object.assign(record, { turn: e.turn }) as ActivePromptRecord,
      });
    }),
    applyLaunchBlocked: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptLaunchBlockedEvent;
      e.record.state = 'blocked';
      e.record.launchedDeferred.resolve(undefined);
      e.record.completionDeferred.resolve({ promptId: e.record.id, result: undefined, state: 'blocked' });
      publishCompleted(context, e.record.id, 'blocked');
      enqueue.assign({ launching: undefined });
      enqueue.raise({ type: 'prompt.pump' });
    }),
    applyLaunchFailed: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptLaunchFailedEvent;
      e.record.state = 'failed';
      e.record.launchedDeferred.resolve(undefined);
      e.record.completionDeferred.resolve({ promptId: e.record.id, result: undefined, state: 'failed' });
      publishCompleted(context, e.record.id, 'failed');
      enqueue.assign({ launching: undefined });
      enqueue.raise({ type: 'prompt.pump' });
    }),
    applyLaunchDeferred: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptLaunchDeferredEvent;
      enqueue.assign({ launching: undefined, pending: [e.record, ...context.pending] });
    }),
    applySettled: enqueueActions(({ context, event, enqueue }) => {
      const e = event as PromptTurnSettledEvent;
      const state = settledStateOf(e.result);
      e.record.state = state;
      e.record.completionDeferred.resolve({ promptId: e.record.id, result: e.result, state });
      for (const child of context.steered.get(e.record.id) ?? []) {
        child.state = state;
        child.completionDeferred.resolve({ promptId: child.id, result: e.result, state });
      }
      const steered = new Map(context.steered);
      steered.delete(e.record.id);
      enqueue.assign({ active: undefined, steered });
      if (state === 'cancelled') publishAborted(context, e.record.id);
      else publishCompleted(context, e.record.id, state);
      enqueue.raise({ type: 'prompt.pump' });
    }),
  },
  guards: {
    canLaunch: ({ context }) =>
      context.pending.length > 0 && context.steering === 0 && !launchGated(context.runtime),
    settledActiveMatches: ({ context, event }) =>
      context.active?.id === (event as PromptTurnSettledEvent).record.id,
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    hooks: { onBeforeSubmitPrompt: new OrderedHookSlot<PromptSubmitContext>() },
    admitted: new Set<string>(),
    reserved: new Set<string>(),
    pending: [],
    launching: undefined,
    active: undefined,
    steering: 0,
    steered: new Map<string, readonly PromptRecord[]>(),
  }),
  invoke: {
    src: 'promptEffects',
    input: ({ context }) => context.runtime,
  },
  initial: 'idle',
  states: {
    idle: {
      on: {
        'prompt.pump': {
          guard: 'canLaunch',
          target: 'launching',
          actions: 'popNextLaunch',
        },
      },
    },
    launching: {
      invoke: {
        src: 'promptLaunch',
        input: ({ context }): PromptLaunchInput => ({
          runtime: context.runtime,
          hooks: context.hooks,
          record: context.launching!,
        }),
      },
      on: {
        'prompt.launchStarted': { target: 'active', actions: 'applyLaunchStarted' },
        'prompt.launchBlocked': { target: 'idle', actions: 'applyLaunchBlocked' },
        'prompt.launchFailed': { target: 'idle', actions: 'applyLaunchFailed' },
        'prompt.launchDeferred': { target: 'idle', actions: 'applyLaunchDeferred' },
      },
    },
    active: {
      invoke: {
        src: 'promptSettlement',
        input: ({ context }) => context.active!,
      },
      on: {
        'prompt.turnSettled': {
          guard: 'settledActiveMatches',
          target: 'idle',
          actions: 'applySettled',
        },
      },
    },
  },
  on: {
    'prompt.commit': { actions: 'commitAdmitted' },
    'prompt.reserve': { actions: 'reserveId' },
    'prompt.release': { actions: 'releaseId' },
    'prompt.enqueue': { actions: 'handleEnqueue' },
    'prompt.abort': { actions: 'handleAbort' },
    'prompt.steerBegin': { actions: 'handleSteerBegin' },
    'prompt.steerSettle': { actions: 'handleSteerSettle' },
    'runtime.restore': {},
  },
});
