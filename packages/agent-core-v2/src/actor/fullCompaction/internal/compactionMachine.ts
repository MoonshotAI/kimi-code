import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import { IAgentHostService } from '#/agent/host/agentHost';
import { AgentErrorEvent } from '#/app/event/agentEvents';
import type { KimiErrorPayload } from '#/errors';
import { getLoopControl } from '#/actor/loop/internal/access';
import { TurnStarted } from '#/actor/loop/turnEvents';
import { TurnEnded } from '#/actor/loop/turnOps';
import type { AgentRuntimeContext, AgentRuntimeRestoreEvent } from '#/actor/agentRuntime';

import { FullCompactionCancel, FullCompactionComplete, type CompactionState } from '../compactionOps';
import { CompactionCancelled, CompactionCompleted } from '../fullCompactionEvents';
import type {
  FullCompactionHookContext,
  FullCompactionStatus,
  FullCompactionTask,
} from '../fullCompactionAgentRuntime';
import type { CompactionBeginData, CompactionResult } from '../types';
import type { ActiveCompaction } from './compactionHelpers';
import {
  afterCompactionStep,
  beforeCompactionStep,
  recoverFromContextOverflow,
  shouldRecoverFromContextOverflow,
} from './compactionOperations';
import { runFullCompactionProcess, type CompactionProcessInput } from './compactionProcess';

export interface ActiveCompactionHandle extends ActiveCompaction {
  readonly data: CompactionBeginData;
  readonly resolve: (result: CompactionResult) => void;
  readonly reject: (reason: unknown) => void;
  detached: boolean;
}

export interface FullCompactionMachineContext {
  readonly runtime: AgentRuntimeContext<CompactionState>;
  readonly beforeCompactHooks: OrderedHookSlot<FullCompactionHookContext>;
  readonly didFinishEmitter: Emitter<FullCompactionTask>;
  state: CompactionState;
  active: ActiveCompactionHandle | undefined;
  lastOutcome: FullCompactionStatus | undefined;
  compactionCountInTurn: number;
  lastCompactedTokenCount: number | null;
  consecutiveOverflowCompactions: number;
  observedMaxContextTokensByModel: ReadonlyMap<string, number>;
  activeTurnId: number | undefined;
}

export type FullCompactionMachineEvent =
  | { readonly type: 'fullCompaction.commit'; readonly state: CompactionState }
  | { readonly type: 'fullCompaction.started'; readonly active: ActiveCompactionHandle }
  | { readonly type: 'fullCompaction.completed'; readonly result: CompactionResult }
  | { readonly type: 'fullCompaction.cancelled' }
  | {
      readonly type: 'fullCompaction.failed';
      readonly errorPayload: KimiErrorPayload;
      readonly notify: boolean;
    }
  | { readonly type: 'fullCompaction.turnStarted' }
  | { readonly type: 'fullCompaction.turnEnded' }
  | { readonly type: 'fullCompaction.stepEntered'; readonly turnId?: number }
  | { readonly type: 'fullCompaction.stepSettled' }
  | { readonly type: 'fullCompaction.slotTaken'; readonly source: CompactionBeginData['source'] }
  | { readonly type: 'fullCompaction.overflowRecovered' }
  | {
      readonly type: 'fullCompaction.contextWindowObserved';
      readonly modelAlias: string;
      readonly maxTokens: number;
    };

export type FullCompactionActorSnapshot = Snapshot<unknown> & {
  readonly context: FullCompactionMachineContext;
};

const fullCompactionEffects = fromCallback(
  ({ input }: { input: AgentRuntimeContext<CompactionState> }) => {
    const runtime = input;
    const loop = getLoopControl(runtime.agent);
    const eventBus = runtime.get(IAgentHostService).of(runtime.agent).eventBus;
    const registrations: IDisposable[] = [
      eventBus.subscribe(TurnStarted, () => {
        runtime.send({ type: 'fullCompaction.turnStarted' });
      }),
      eventBus.subscribe(TurnEnded, () => {
        runtime.send({ type: 'fullCompaction.turnEnded' });
      }),
      loop.hooks.onWillBeginStep.register('full-compaction', async (ctx, next) => {
        await beforeCompactionStep(runtime, ctx.signal, ctx.turnId);
        await next();
      }),
      loop.hooks.onDidFinishStep.register('full-compaction', async (_ctx, next) => {
        await afterCompactionStep(runtime);
        await next();
      }),
      loop.registerLoopErrorHandler({
        id: 'full-compaction',
        match: (context) => shouldRecoverFromContextOverflow(runtime, context.error),
        handle: (context) => recoverFromContextOverflow(runtime, context),
      }),
    ];
    return () => {
      for (const registration of registrations.splice(0)) registration.dispose();
    };
  },
);

const compactionProcess = fromCallback(({ input }: { input: CompactionProcessInput }) => {
  void runFullCompactionProcess(input).then(input.handle.resolve, input.handle.reject);
  return () => {
    input.handle.detached = true;
    if (!input.handle.abortController.signal.aborted) {
      input.handle.abortController.abort();
    }
  };
});

export const fullCompactionActorLogic = setup({
  types: {} as {
    context: FullCompactionMachineContext;
    input: AgentRuntimeContext<CompactionState>;
    events: FullCompactionMachineEvent | AgentRuntimeRestoreEvent;
  },
  actors: { fullCompactionEffects, compactionProcess },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    beforeCompactHooks: new OrderedHookSlot<FullCompactionHookContext>(),
    didFinishEmitter: new Emitter<FullCompactionTask>(),
    state: { phase: 'idle' },
    active: undefined,
    lastOutcome: undefined,
    compactionCountInTurn: 0,
    lastCompactedTokenCount: null,
    consecutiveOverflowCompactions: 0,
    observedMaxContextTokensByModel: new Map(),
    activeTurnId: undefined,
  }),
  invoke: {
    src: 'fullCompactionEffects',
    input: ({ context }) => context.runtime,
  },
  initial: 'idle',
  states: {
    idle: {
      on: {
        'fullCompaction.started': {
          target: 'running',
          actions: assign({ active: ({ event }) => event.active }),
        },
      },
    },
    running: {
      invoke: {
        src: 'compactionProcess',
        input: ({ context }): CompactionProcessInput => ({
          runtime: context.runtime,
          handle: context.active!,
          hooks: context.beforeCompactHooks,
          emitter: context.didFinishEmitter,
        }),
      },
      on: {
        'fullCompaction.completed': {
          target: 'idle',
          actions: [
            ({ context, event }) => {
              const handle = context.active;
              if (handle === undefined) return;
              const agentId = context.runtime.agent.agentId;
              handle.outcome = 'completed';
              void context.runtime.dispatch(new FullCompactionComplete({ agentId }));
              const { contextSummary: _contextSummary, ...eventResult } = event.result;
              void _contextSummary;
              void context.runtime.dispatch(
                new CompactionCompleted({ agentId, result: eventResult }),
              );
            },
            assign({
              active: undefined,
              lastOutcome: 'completed' as const,
              lastCompactedTokenCount: ({ event }) => event.result.tokensAfter,
            }),
          ],
        },
        'fullCompaction.cancelled': {
          target: 'idle',
          actions: [
            ({ context }) => {
              const handle = context.active;
              if (handle === undefined) return;
              const agentId = context.runtime.agent.agentId;
              handle.outcome = 'cancelled';
              void context.runtime.dispatch(new FullCompactionCancel({ agentId }));
              if (!handle.abortController.signal.aborted) {
                handle.abortController.abort();
              }
              void context.runtime.dispatch(new CompactionCancelled({ agentId }));
            },
            assign({ active: undefined, lastOutcome: 'cancelled' as const }),
          ],
        },
        'fullCompaction.failed': {
          target: 'idle',
          actions: [
            ({ context, event }) => {
              const handle = context.active;
              if (handle === undefined) return;
              const agentId = context.runtime.agent.agentId;
              void context.runtime.dispatch(new FullCompactionCancel({ agentId }));
              if (!handle.abortController.signal.aborted) {
                handle.abortController.abort();
              }
              void context.runtime.dispatch(new CompactionCancelled({ agentId }));
              handle.outcome = 'failed';
              if (event.notify) {
                void context.runtime.dispatch(
                  new AgentErrorEvent({ ...event.errorPayload, agentId }),
                );
              }
            },
            assign({ active: undefined, lastOutcome: 'failed' as const }),
          ],
        },
      },
    },
  },
  on: {
    'fullCompaction.commit': {
      actions: assign({ state: ({ event }) => event.state }),
    },
    'runtime.restore': {
      actions: ({ context, event }) => {
        if (context.state.phase !== 'running') return;
        event.waitUntil(
          context.runtime.dispatch(
            new FullCompactionCancel({ agentId: context.runtime.agent.agentId }),
          ),
        );
      },
    },
    'fullCompaction.turnStarted': {
      actions: assign({
        compactionCountInTurn: 0,
        lastCompactedTokenCount: null,
        consecutiveOverflowCompactions: 0,
      }),
    },
    'fullCompaction.turnEnded': {
      actions: assign({ activeTurnId: undefined }),
    },
    'fullCompaction.stepEntered': {
      actions: assign({ activeTurnId: ({ event }) => event.turnId }),
    },
    'fullCompaction.stepSettled': {
      actions: assign({ consecutiveOverflowCompactions: 0 }),
    },
    'fullCompaction.slotTaken': {
      actions: assign({
        compactionCountInTurn: ({ context, event }) =>
          event.source === 'manual' ? 0 : context.compactionCountInTurn + 1,
      }),
    },
    'fullCompaction.overflowRecovered': {
      actions: assign({
        consecutiveOverflowCompactions: ({ context }) => context.consecutiveOverflowCompactions + 1,
      }),
    },
    'fullCompaction.contextWindowObserved': {
      actions: assign({
        observedMaxContextTokensByModel: ({ context, event }) => {
          const next = new Map(context.observedMaxContextTokensByModel);
          next.set(event.modelAlias, event.maxTokens);
          return next;
        },
      }),
    },
  },
});
