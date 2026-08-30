import { fromCallback, setup, type Snapshot } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import { IAgentHostService } from '#/agent/host/agentHost';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import { TaskStarted, TaskTerminatedNotice } from '#/actor/task/taskOps';
import { AgentTask } from '#/actor/task/taskAgentRuntime';
import {
  PermissionApprovalRequested,
  PermissionApprovalResolved,
} from '#/agent/toolApproval/toolApprovalService';
import { USER_PROMPT_ORIGIN, type PromptOrigin } from '#/actor/contextMemory/types';
import {
  CompactionCancelled,
  CompactionCompleted,
  CompactionStarted,
} from '#/actor/fullCompaction/fullCompactionEvents';
import { AgentFullCompaction } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import { getLoopDurableState, tryGetLoopControl } from '#/actor/loop/internal/access';
import { TurnStepRetrying } from '#/actor/loop/internal/stepRetry';
import {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  TurnStarted,
  TurnStepStarted,
  TurnStepCompleted,
  TurnStepInterrupted,
  type TurnEndReason,
} from '#/actor/loop/turnEvents';
import { TurnEnded } from '#/actor/loop/turnOps';
import { ToolCallStarted, ToolResultEvent } from '#/actor/toolExecutor/toolExecutorEvents';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { AgentActivityUpdated } from './activityViewEvents';
import type {
  ActivityLastTurnState,
  ActivityRetryState,
  ActivityTurnState,
  ActivityViewLifecycle,
  AgentActivityState,
  ApprovalRef,
  BackgroundRef,
  ToolCallRef,
  TurnPhase,
} from './types';

type EndingReason = NonNullable<ActivityTurnState['endingReason']>;
const FULL_COMPACTION_BACKGROUND_ID = 'full-compaction';

interface ActivityViewActorContext {
  readonly runtime: AgentRuntimeContext<null>;
  lifecycle: ActivityViewLifecycle;
  turn: MutableTurn | undefined;
  lastTurn: ActivityLastTurnState | undefined;
  readonly background: Map<string, BackgroundRef>;
  current: AgentActivityState;
}

type ActivityViewActorEvent =
  | { readonly type: 'activityView.turnStarted'; readonly turnId: number; readonly origin?: PromptOrigin }
  | { readonly type: 'activityView.stepStarted'; readonly step: number }
  | { readonly type: 'activityView.delta'; readonly stream: 'assistant' | 'thinking' | 'tool_call' }
  | { readonly type: 'activityView.toolCallStarted'; readonly toolCallId: string; readonly name: string }
  | { readonly type: 'activityView.toolResult'; readonly toolCallId: string }
  | { readonly type: 'activityView.retrying'; readonly retry: ActivityRetryState }
  | { readonly type: 'activityView.stepCompleted' }
  | { readonly type: 'activityView.stepInterrupted'; readonly turnId: number; readonly reason: string }
  | { readonly type: 'activityView.turnEnded'; readonly turnId: number; readonly reason: TurnEndReason }
  | { readonly type: 'activityView.approvalRequested'; readonly approvalId: string; readonly toolCallId: string }
  | { readonly type: 'activityView.approvalResolved'; readonly approvalId: string }
  | { readonly type: 'activityView.backgroundStarted'; readonly ref: BackgroundRef }
  | { readonly type: 'activityView.backgroundEnded'; readonly id: string }
  | { readonly type: 'activityView.backgroundSeeded'; readonly entries: readonly BackgroundRef[] }
  | { readonly type: 'activityView.seedTurn'; readonly turnId: number }
  | { readonly type: 'activityView.seedLastTurn' };

type ActivityViewActorSnapshot = Snapshot<unknown> & {
  readonly context: ActivityViewActorContext;
};

function publishActivity(context: ActivityViewActorContext): void {
  const t = context.turn;
  const next: AgentActivityState = {
    lifecycle: context.lifecycle,
    turn: t === undefined ? undefined : t.snapshot(),
    lastTurn: context.lastTurn,
    background: [...context.background.values()],
  };
  if (activityEqual(context.current, next)) return;
  context.current = next;
  void context.runtime.dispatch(
    new AgentActivityUpdated({ ...next, agentId: context.runtime.agent.agentId }),
  );
}

function mutateTurn(
  context: ActivityViewActorContext,
  mutate: (t: MutableTurn) => void,
): void {
  if (context.turn === undefined) return;
  mutate(context.turn);
  publishActivity(context);
}

function seedLastTurnFromWire(context: ActivityViewActorContext): void {
  if (context.turn !== undefined || context.lastTurn !== undefined) return;
  const lastEnded = getLoopDurableState(context.runtime)?.lastEnded;
  if (lastEnded === undefined) return;
  context.lastTurn = {
    turnId: lastEnded.turnId,
    reason: lastEnded.reason,
    durationMs: lastEnded.durationMs,
    at: Date.now(),
  };
  publishActivity(context);
}

const activityViewEffects = fromCallback(
  ({
    input,
    sendBack,
  }: {
    input: AgentRuntimeContext<null>;
    sendBack: (event: ActivityViewActorEvent) => void;
  }) => {
    const agent = input.agent;
    const eventBus = input.get(IAgentHostService).of(agent).eventBus;
    const status = tryGetLoopControl(input)?.status();
    if (status?.state === 'running' && status.activeTurnId !== undefined) {
      sendBack({ type: 'activityView.seedTurn', turnId: status.activeTurnId });
    } else {
      sendBack({ type: 'activityView.seedLastTurn' });
    }
    const taskRefs: BackgroundRef[] = input
      .get(IAgentLifecycleService)
      .resolve(agent, AgentTask)
      .list(true)
      .map((info) => ({ kind: info.kind, id: info.taskId, since: info.startedAt }));
    if (taskRefs.length > 0) {
      sendBack({ type: 'activityView.backgroundSeeded', entries: taskRefs });
    }
    if (
      input.get(IAgentLifecycleService).resolve(agent, AgentFullCompaction).status() === 'running'
    ) {
      sendBack({
        type: 'activityView.backgroundStarted',
        ref: { kind: 'compaction', id: FULL_COMPACTION_BACKGROUND_ID, since: Date.now() },
      });
    }
    const subscriptions: IDisposable[] = [
      eventBus.subscribe(TurnStarted, (e) => {
        sendBack({ type: 'activityView.turnStarted', turnId: e.turnId, origin: e.origin });
      }),
      eventBus.subscribe(TurnStepStarted, (e) => {
        sendBack({ type: 'activityView.stepStarted', step: e.step });
      }),
      eventBus.subscribe(AssistantDelta, () => {
        sendBack({ type: 'activityView.delta', stream: 'assistant' });
      }),
      eventBus.subscribe(ThinkingDelta, () => {
        sendBack({ type: 'activityView.delta', stream: 'thinking' });
      }),
      eventBus.subscribe(ToolCallDelta, () => {
        sendBack({ type: 'activityView.delta', stream: 'tool_call' });
      }),
      eventBus.subscribe(ToolCallStarted, (e) => {
        sendBack({ type: 'activityView.toolCallStarted', toolCallId: e.toolCallId, name: e.name });
      }),
      eventBus.subscribe(ToolResultEvent, (e) => {
        sendBack({ type: 'activityView.toolResult', toolCallId: e.toolCallId });
      }),
      eventBus.subscribe(TurnStepRetrying, (e) => {
        sendBack({
          type: 'activityView.retrying',
          retry: {
            failedAttempt: e.failedAttempt,
            nextAttempt: e.nextAttempt,
            maxAttempts: e.maxAttempts,
            delayMs: e.delayMs,
            errorName: e.errorName,
            statusCode: e.statusCode,
          },
        });
      }),
      eventBus.subscribe(TurnStepCompleted, () => {
        sendBack({ type: 'activityView.stepCompleted' });
      }),
      eventBus.subscribe(TurnStepInterrupted, (e) => {
        sendBack({ type: 'activityView.stepInterrupted', turnId: e.turnId, reason: e.reason });
      }),
      eventBus.subscribe(TurnEnded, (e) => {
        sendBack({ type: 'activityView.turnEnded', turnId: e.turnId, reason: e.reason });
      }),
      eventBus.subscribe(PermissionApprovalRequested, (e) => {
        sendBack({
          type: 'activityView.approvalRequested',
          approvalId: e.id ?? e.toolCallId,
          toolCallId: e.toolCallId,
        });
      }),
      eventBus.subscribe(PermissionApprovalResolved, (e) => {
        sendBack({ type: 'activityView.approvalResolved', approvalId: e.id ?? e.toolCallId });
      }),
      eventBus.subscribe(TaskStarted, (e) => {
        sendBack({
          type: 'activityView.backgroundStarted',
          ref: { kind: e.info.kind, id: e.info.taskId, since: e.info.startedAt },
        });
      }),
      eventBus.subscribe(TaskTerminatedNotice, (e) => {
        sendBack({ type: 'activityView.backgroundEnded', id: e.info.taskId });
      }),
      eventBus.subscribe(CompactionStarted, () => {
        sendBack({
          type: 'activityView.backgroundStarted',
          ref: { kind: 'compaction', id: FULL_COMPACTION_BACKGROUND_ID, since: Date.now() },
        });
      }),
      eventBus.subscribe(CompactionCompleted, () => {
        sendBack({ type: 'activityView.backgroundEnded', id: FULL_COMPACTION_BACKGROUND_ID });
      }),
      eventBus.subscribe(CompactionCancelled, () => {
        sendBack({ type: 'activityView.backgroundEnded', id: FULL_COMPACTION_BACKGROUND_ID });
      }),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      const context = input.getLogicState<ActivityViewActorContext>();
      void input.dispatch(
        new AgentActivityUpdated({
          ...context.current,
          lifecycle: 'disposed',
          agentId: agent.agentId,
        }),
      );
    };
  },
);

const activityViewActorLogic = setup({
  types: {} as {
    context: ActivityViewActorContext;
    input: AgentRuntimeContext<null>;
    events: ActivityViewActorEvent | AgentRuntimeRestoreEvent;
  },
  actors: { activityViewEffects },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    lifecycle: 'ready',
    turn: undefined,
    lastTurn: undefined,
    background: new Map(),
    current: { lifecycle: 'ready', background: [] },
  }),
  invoke: {
    src: 'activityViewEffects',
    input: ({ context }) => context.runtime,
  },
  on: {
    'activityView.turnStarted': {
      actions: ({ context, event }) => {
        context.turn = new MutableTurn(event.turnId, event.origin ?? USER_PROMPT_ORIGIN);
        context.lastTurn = undefined;
        publishActivity(context);
      },
    },
    'activityView.stepStarted': {
      actions: ({ context, event }) => {
        mutateTurn(context, (t) => {
          t.step = event.step;
          t.phase = 'running';
          t.stream = undefined;
          t.retry = undefined;
        });
      },
    },
    'activityView.delta': {
      actions: ({ context, event }) => {
        mutateTurn(context, (t) => {
          t.phase = 'streaming';
          t.stream = event.stream;
          t.retry = undefined;
        });
      },
    },
    'activityView.toolCallStarted': {
      actions: ({ context, event }) => {
        mutateTurn(context, (t) => {
          t.phase = 'tool_call';
          t.stream = undefined;
          t.retry = undefined;
          t.activeToolCalls.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            name: event.name,
            since: Date.now(),
          });
        });
      },
    },
    'activityView.toolResult': {
      actions: ({ context, event }) => {
        mutateTurn(context, (t) => {
          t.activeToolCalls.delete(event.toolCallId);
          t.phase = t.activeToolCalls.size === 0 ? 'running' : 'tool_call';
          t.stream = undefined;
          t.retry = undefined;
        });
      },
    },
    'activityView.retrying': {
      actions: ({ context, event }) => {
        mutateTurn(context, (t) => {
          t.phase = 'retrying';
          t.stream = undefined;
          t.retry = event.retry;
        });
      },
    },
    'activityView.stepCompleted': {
      actions: ({ context }) => {
        mutateTurn(context, (t) => {
          t.phase = 'running';
          t.stream = undefined;
          t.retry = undefined;
        });
      },
    },
    'activityView.stepInterrupted': {
      actions: ({ context, event }) => {
        if (event.reason !== 'aborted' && event.reason !== 'max_steps' && event.reason !== 'error') {
          return;
        }
        const reason: EndingReason = event.reason;
        mutateTurn(context, (t) => {
          if (t.turnId !== event.turnId) return;
          t.ending = true;
          t.endingReason = reason;
        });
      },
    },
    'activityView.turnEnded': {
      actions: ({ context, event }) => {
        if (context.turn === undefined || context.turn.turnId !== event.turnId) {
          context.lastTurn = { turnId: event.turnId, reason: event.reason, at: Date.now() };
          publishActivity(context);
          return;
        }
        context.lastTurn = {
          turnId: event.turnId,
          reason: event.reason,
          durationMs: Date.now() - context.turn.since,
          at: Date.now(),
        };
        context.turn = undefined;
        publishActivity(context);
      },
    },
    'activityView.approvalRequested': {
      actions: ({ context, event }) => {
        mutateTurn(context, (t) => {
          t.pendingApprovals.set(event.approvalId, {
            approvalId: event.approvalId,
            toolCallId: event.toolCallId,
            since: Date.now(),
          });
        });
      },
    },
    'activityView.approvalResolved': {
      actions: ({ context, event }) => {
        mutateTurn(context, (t) => {
          t.pendingApprovals.delete(event.approvalId);
        });
      },
    },
    'activityView.backgroundStarted': {
      actions: ({ context, event }) => {
        context.background.set(event.ref.id, event.ref);
        publishActivity(context);
      },
    },
    'activityView.backgroundEnded': {
      actions: ({ context, event }) => {
        if (context.background.delete(event.id)) publishActivity(context);
      },
    },
    'activityView.backgroundSeeded': {
      actions: ({ context, event }) => {
        for (const ref of event.entries) context.background.set(ref.id, ref);
        if (context.background.size > 0) publishActivity(context);
      },
    },
    'activityView.seedTurn': {
      actions: ({ context, event }) => {
        context.turn = new MutableTurn(event.turnId, USER_PROMPT_ORIGIN);
        publishActivity(context);
      },
    },
    'activityView.seedLastTurn': {
      actions: ({ context }) => {
        seedLastTurnFromWire(context);
      },
    },
    'runtime.restore': {
      actions: ({ context }) => {
        seedLastTurnFromWire(context);
      },
    },
  },
});

class MutableTurn {
  phase: TurnPhase = 'running';
  stream: ActivityTurnState['stream'];
  step = 0;
  ending = false;
  endingReason: EndingReason | undefined;
  retry: ActivityRetryState | undefined;
  readonly pendingApprovals = new Map<string, ApprovalRef>();
  readonly activeToolCalls = new Map<string, ToolCallRef>();
  readonly since = Date.now();

  constructor(
    readonly turnId: number,
    readonly origin: PromptOrigin,
  ) {}

  snapshot(): ActivityTurnState {
    return {
      turnId: this.turnId,
      origin: this.origin,
      phase: this.phase,
      stream: this.stream,
      step: this.step,
      ending: this.ending,
      endingReason: this.endingReason,
      retry: this.retry,
      pendingApprovals: [...this.pendingApprovals.values()],
      activeToolCalls: [...this.activeToolCalls.values()],
      since: this.since,
    };
  }
}

function activityEqual(a: AgentActivityState, b: AgentActivityState): boolean {
  if (a.lifecycle !== b.lifecycle) return false;
  if ((a.turn === undefined) !== (b.turn === undefined)) return false;
  if (a.turn !== undefined && b.turn !== undefined) {
    const ta = a.turn;
    const tb = b.turn;
    if (
      ta.turnId !== tb.turnId ||
      ta.phase !== tb.phase ||
      ta.stream !== tb.stream ||
      ta.step !== tb.step ||
      ta.ending !== tb.ending ||
      ta.endingReason !== tb.endingReason ||
      ta.pendingApprovals.length !== tb.pendingApprovals.length ||
      ta.activeToolCalls.length !== tb.activeToolCalls.length
    ) {
      return false;
    }
    if (ta.retry?.nextAttempt !== tb.retry?.nextAttempt) return false;
  }
  if ((a.lastTurn === undefined) !== (b.lastTurn === undefined)) return false;
  if (a.lastTurn !== undefined && b.lastTurn !== undefined) {
    if (a.lastTurn.turnId !== b.lastTurn.turnId || a.lastTurn.reason !== b.lastTurn.reason) {
      return false;
    }
  }
  if (a.background.length !== b.background.length) return false;
  for (let i = 0; i < a.background.length; i++) {
    if (a.background[i]!.id !== b.background[i]!.id || a.background[i]!.kind !== b.background[i]!.kind) {
      return false;
    }
  }
  return true;
}

export class ActivityViewRuntime {
  constructor(private readonly context: AgentRuntimeContext<null>) {}

  state(): AgentActivityState {
    return this.context.getLogicState<ActivityViewActorContext>().current;
  }
}

export const AgentActivityView = defineAgentRuntimeContract<ActivityViewRuntime>('activityView');

export const activityViewAgentRuntimeProvider = defineAgentRuntimeProvider<null, ActivityViewRuntime>(
  AgentActivityView,
  {
    id: 'activityView',
    logic: activityViewActorLogic,
    eager: true,
    createApi: (context) => new ActivityViewRuntime(context),
    inspect: (snapshot) => (snapshot as ActivityViewActorSnapshot).context.current,
  },
);
