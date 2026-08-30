import { enqueueActions, fromCallback, setup, type Snapshot } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import { IAgentHostService } from '#/agent/host/agentHost';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import { AgentFullCompaction } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import {
  CompactionCancelled,
  CompactionCompleted,
  CompactionStarted,
} from '#/actor/fullCompaction/fullCompactionEvents';
import { AgentInteraction } from '#/actor/interaction/interactionAgentRuntime';
import {
  AgentLoop,
  type LoopActivity,
  type LoopTurnActivity,
  type LoopTurnPhase,
} from '#/actor/loop/loop';
import { AgentTask } from '#/actor/task/taskAgentRuntime';
import { TaskStarted, TaskTerminatedNotice } from '#/actor/task/taskOps';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { ToolCallStarted, ToolResultEvent } from '#/actor/toolExecutor/toolExecutorEvents';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { AgentActivityUpdated } from './activityViewEvents';
import type {
  ActivityTurnState,
  AgentActivityState,
  BackgroundRef,
  TurnPhase,
} from './types';

const FULL_COMPACTION_BACKGROUND_ID = 'full-compaction';

const TURN_PHASE_BY_LOOP_PHASE: Record<LoopTurnPhase, TurnPhase> = {
  working: 'running',
  streaming: 'streaming',
  toolCalling: 'tool_call',
  retrying: 'retrying',
};

function projectTurn(
  lifecycle: IAgentLifecycleService,
  context: AgentRuntimeContext<null>,
  turn: LoopTurnActivity,
): ActivityTurnState {
  const agent = context.agent;
  const pendingApprovals = lifecycle
    .resolve(agent, AgentInteraction)
    .listPending('approval')
    .map((interaction) => ({
      approvalId: interaction.id,
      toolCallId: (interaction.payload as { readonly toolCallId?: string }).toolCallId,
      since: interaction.createdAt,
    }));
  const activeToolCalls = lifecycle
    .resolve(agent, AgentTools)
    .activeCalls()
    .filter((call) => call.turnId === turn.turnId)
    .map((call) => ({ toolCallId: call.toolCallId, name: call.name, since: call.since }));
  return {
    turnId: turn.turnId,
    origin: turn.origin,
    phase: TURN_PHASE_BY_LOOP_PHASE[turn.phase],
    stream: turn.stream,
    step: turn.step,
    ending: turn.interrupting !== undefined,
    endingReason: turn.interrupting,
    retry: turn.retry,
    pendingApprovals,
    activeToolCalls,
    since: turn.since,
  };
}

function projectBackground(
  lifecycle: IAgentLifecycleService,
  context: AgentRuntimeContext<null>,
): readonly BackgroundRef[] {
  const agent = context.agent;
  const refs: BackgroundRef[] = lifecycle
    .resolve(agent, AgentTask)
    .list(true)
    .map((info) => ({ kind: info.kind, id: info.taskId, since: info.startedAt }));
  const compactionSince = lifecycle.resolve(agent, AgentFullCompaction).runningSince();
  if (compactionSince !== undefined) {
    refs.push({ kind: 'compaction', id: FULL_COMPACTION_BACKGROUND_ID, since: compactionSince });
  }
  return refs.toSorted((a, b) => a.since - b.since);
}

function projectActivity(
  context: AgentRuntimeContext<null>,
  loopActivity?: LoopActivity,
): AgentActivityState {
  const lifecycle = context.get(IAgentLifecycleService);
  const activity = loopActivity ?? lifecycle.resolve(context.agent, AgentLoop).activity();
  return {
    lifecycle: 'ready',
    turn: activity.turn === undefined
      ? undefined
      : projectTurn(lifecycle, context, activity.turn),
    lastTurn: activity.lastTurn,
    background: projectBackground(lifecycle, context),
  };
}

interface ActivityViewActorContext {
  readonly runtime: AgentRuntimeContext<null>;
  published: AgentActivityState;
}

interface ActivityViewRefreshEvent {
  readonly type: 'activityView.refresh';
  readonly loopActivity?: LoopActivity;
}

type ActivityViewActorEvent = ActivityViewRefreshEvent | AgentRuntimeRestoreEvent;

type ActivityViewActorSnapshot = Snapshot<unknown> & {
  readonly context: ActivityViewActorContext;
};

const activityViewEffects = fromCallback(
  ({
    input,
    sendBack,
  }: {
    input: AgentRuntimeContext<null>;
    sendBack: (event: ActivityViewActorEvent) => void;
  }) => {
    const refresh = (): void => {
      sendBack({ type: 'activityView.refresh' });
    };
    const agent = input.agent;
    const lifecycle = input.get(IAgentLifecycleService);
    const eventBus = input.get(IAgentHostService).of(agent).eventBus;
    const subscriptions: IDisposable[] = [
      lifecycle.resolve(agent, AgentLoop).onDidChangeActivity((loopActivity) => {
        sendBack({ type: 'activityView.refresh', loopActivity });
      }),
      lifecycle.resolve(agent, AgentInteraction).onDidChangePending(refresh),
      eventBus.subscribe(ToolCallStarted, refresh),
      eventBus.subscribe(ToolResultEvent, refresh),
      eventBus.subscribe(TaskStarted, refresh),
      eventBus.subscribe(TaskTerminatedNotice, refresh),
      eventBus.subscribe(CompactionStarted, refresh),
      eventBus.subscribe(CompactionCompleted, refresh),
      eventBus.subscribe(CompactionCancelled, refresh),
    ];
    refresh();
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
      const published = input.getLogicState<ActivityViewActorContext>().published;
      void input.dispatch(
        new AgentActivityUpdated({
          ...published,
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
    events: ActivityViewActorEvent;
  },
  actors: { activityViewEffects },
  actions: {
    publish: enqueueActions(({ context, event, enqueue }) => {
      const loopActivity =
        event.type === 'activityView.refresh' ? event.loopActivity : undefined;
      const next = projectActivity(context.runtime, loopActivity);
      if (activityEqual(context.published, next)) return;
      enqueue.assign({ published: next });
      void context.runtime.dispatch(
        new AgentActivityUpdated({ ...next, agentId: context.runtime.agent.agentId }),
      );
    }),
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    published: { lifecycle: 'ready', background: [] },
  }),
  invoke: {
    src: 'activityViewEffects',
    input: ({ context }) => context.runtime,
  },
  on: {
    'activityView.refresh': { actions: 'publish' },
    'runtime.restore': { actions: 'publish' },
  },
});

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
    return this.context.getLogicState<ActivityViewActorContext>().published;
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
    inspect: (snapshot) => (snapshot as ActivityViewActorSnapshot).context.published,
  },
);
