import type { Draft } from 'immer';
import { fromCallback, setup, type Snapshot } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { FoldContext } from '#/state/state';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import type { CompactionResult, CompactionSource } from './types';
import { FullCompactionBegin, FullCompactionCancel, FullCompactionComplete, type CompactionState } from './compactionOps';
import { CompactionStarted } from './fullCompactionEvents';
import { FullCompactionDomain } from './internal/fullCompactionDomain';

export type FullCompactionStatus = 'idle' | 'running' | 'cancelled' | 'completed' | 'failed';

export interface FullCompactionTask {
  readonly id: string;
  readonly status: FullCompactionStatus;
}

export interface FullCompactionBeginInput {
  readonly source?: CompactionSource;
  readonly instruction?: string;
}

export interface FullCompactionHookContext {
  readonly trigger: CompactionSource;
  readonly tokenCount: number;
  readonly signal: AbortSignal;
  readonly settlement: Promise<CompactionResult>;
}

export interface FullCompactionRuntime {
  begin(input?: FullCompactionBeginInput): Promise<FullCompactionTask>;
  cancel(): Promise<void>;
  status(): FullCompactionStatus;
  readonly onDidFinish: Event<FullCompactionTask>;
  registerBeforeCompactHook(
    name: string,
    hook: (ctx: FullCompactionHookContext) => Promise<void>,
  ): IDisposable;
}

export class AgentFullCompactionRuntime implements FullCompactionRuntime {
  constructor(private readonly context: AgentRuntimeContext<CompactionState>) {}

  private get domain(): FullCompactionDomain {
    return this.context.getLogicState<FullCompactionActorContext>().domain;
  }

  begin(input?: FullCompactionBeginInput): Promise<FullCompactionTask> {
    return this.domain.begin(input);
  }

  cancel(): Promise<void> {
    return this.domain.cancel();
  }

  status(): FullCompactionStatus {
    return this.domain.status();
  }

  get onDidFinish(): Event<FullCompactionTask> {
    return this.domain.onDidFinish;
  }

  registerBeforeCompactHook(
    name: string,
    hook: (ctx: FullCompactionHookContext) => Promise<void>,
  ): IDisposable {
    return this.domain.registerBeforeCompactHook(name, hook);
  }
}

export const AgentFullCompaction = defineAgentRuntimeContract<FullCompactionRuntime>('fullCompaction');

interface FullCompactionActorContext {
  readonly runtime: AgentRuntimeContext<CompactionState>;
  readonly domain: FullCompactionDomain;
  state: CompactionState;
}

interface FullCompactionCommitEvent {
  readonly type: 'fullCompaction.commit';
  readonly state: CompactionState;
}

type FullCompactionActorSnapshot = Snapshot<unknown> & {
  readonly context: FullCompactionActorContext;
};

const fullCompactionEffects = fromCallback(({ input }: { input: FullCompactionDomain }) => {
  const attached = input.attach();
  return () => attached.dispose();
});

const fullCompactionActorLogic = setup({
  types: {} as {
    context: FullCompactionActorContext;
    input: AgentRuntimeContext<CompactionState>;
    events: AgentRuntimeRestoreEvent | FullCompactionCommitEvent;
  },
  actors: { fullCompactionEffects },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    domain: new FullCompactionDomain(input),
    state: { phase: 'idle' },
  }),
  on: {
    'fullCompaction.commit': {
      actions: ({ context, event }) => {
        context.state = event.state;
      },
    },
    'runtime.restore': {
      actions: ({ context, event }) => {
        context.domain.normalizeAfterReplay(event);
      },
    },
  },
  invoke: {
    src: 'fullCompactionEffects',
    input: ({ context }) => context.domain,
  },
});

function fullCompactionTransition(
  state: Draft<CompactionState>,
  event: unknown,
  ctx: FoldContext,
): CompactionState | void {
  if (event instanceof FullCompactionBegin) {
    if (state.phase !== 'running') {
      state.phase = 'running';
    }
    ctx.emit(
      new CompactionStarted({
        agentId: event.agentId,
        trigger: event.source,
        instruction: event.instruction,
      }),
    );
    return;
  }
  if (event instanceof FullCompactionCancel || event instanceof FullCompactionComplete) {
    if (state.phase !== 'idle') {
      state.phase = 'idle';
    }
    return;
  }
}

export const fullCompactionAgentRuntimeProvider = defineAgentRuntimeProvider<
  CompactionState,
  FullCompactionRuntime
>(AgentFullCompaction, {
  id: 'fullCompaction',
  logic: fullCompactionActorLogic,
  eager: true,
  durable: {
    events: [FullCompactionBegin, FullCompactionCancel, FullCompactionComplete],
    undoable: false,
    transition: fullCompactionTransition,
    read: (snapshot) => (snapshot as FullCompactionActorSnapshot).context.state,
    commit: (actor, state) => {
      actor.send({ type: 'fullCompaction.commit', state });
    },
  },
  createApi: (context) => new AgentFullCompactionRuntime(context),
  inspect: (snapshot) => {
    const { context } = snapshot as FullCompactionActorSnapshot;
    return {
      phase: context.state.phase,
      status: context.domain.status(),
      lastCompactedTokenCount: context.domain.lastCompactedTokenCount,
    };
  },
});
