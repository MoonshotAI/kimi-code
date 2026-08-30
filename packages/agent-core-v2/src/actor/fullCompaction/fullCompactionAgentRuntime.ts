import type { Draft } from 'immer';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { FoldContext } from '#/state/state';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/actor/agentRuntime';
import type { CompactionResult, CompactionSource } from './types';
import { FullCompactionBegin, FullCompactionCancel, FullCompactionComplete, type CompactionState } from './compactionOps';
import { CompactionStarted } from './fullCompactionEvents';
import {
  fullCompactionActorLogic,
  type FullCompactionActorSnapshot,
} from './internal/compactionMachine';
import {
  beginFullCompaction,
  cancelFullCompaction,
  compactionContextOf,
  fullCompactionStatusOf,
  registerCompactionHook,
} from './internal/compactionOperations';

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

  begin(input?: FullCompactionBeginInput): Promise<FullCompactionTask> {
    return beginFullCompaction(this.context, input);
  }

  cancel(): Promise<void> {
    return cancelFullCompaction(this.context);
  }

  status(): FullCompactionStatus {
    return fullCompactionStatusOf(compactionContextOf(this.context));
  }

  get onDidFinish(): Event<FullCompactionTask> {
    return compactionContextOf(this.context).didFinishEmitter.event;
  }

  registerBeforeCompactHook(
    name: string,
    hook: (ctx: FullCompactionHookContext) => Promise<void>,
  ): IDisposable {
    return registerCompactionHook(this.context, name, hook);
  }
}

export const AgentFullCompaction = defineAgentRuntimeContract<FullCompactionRuntime>('fullCompaction');

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
      status: fullCompactionStatusOf(context),
      lastCompactedTokenCount: context.lastCompactedTokenCount,
    };
  },
});
