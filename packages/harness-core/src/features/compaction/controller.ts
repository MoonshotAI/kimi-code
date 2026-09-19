import {
  usedContextTokens,
  type AgentCommands,
  type SessionStores,
  type TurnBeforeStep,
  type TurnBeforeStepContext,
  type UserMessage,
} from '@moonshot-ai/agent-core';
import { createActor, waitFor, type ActorRefFrom, type Subscription } from '@moonshot-ai/agent-core/xstate2/index';

import { CompactError } from './errors';
import {
  createCompactionMachine,
  type CompactionEvent,
  type CompactionMachineOutput,
  type CompactionOrigin,
  type CompactionPhase,
  type CompactionReason,
} from './machine';
import type { Summarize } from './summarize';

export {
  type CompactionCancelCause,
  type CompactionEvent,
  type CompactionPhase,
  type CompactionReason,
  type CompactionStats,
} from './machine';

export interface CompactionStatus {
  phase: CompactionPhase;
  reason?: CompactionReason;
  startedAt?: number;
}

export interface CompactionControllerDeps {
  agentId: string;
  agent: AgentCommands;
  stores: SessionStores;
  summarize: Summarize;
  budget: {
    maxContextTokens(): number;
    triggerRatio: number;
  };
  continuation?: (reason: CompactionReason) => UserMessage | undefined;
  maxAutoAttempts?: number;
  todos?: () => string | undefined;
  onEvent?: (event: CompactionEvent) => void;
  onWillCompact?: (input: {
    reason: CompactionReason;
    instruction?: string;
    signal: AbortSignal;
    tokenCount: number;
  }) => void | Promise<void>;
}

export interface CompactionController {
  compact(instruction?: string): Promise<void>;
  cancel(): void;
  status(): CompactionStatus;
  onBeforeStep: TurnBeforeStep;
  dispose(): void;
}

type RunActor = ActorRefFrom<ReturnType<typeof createCompactionMachine>>;

interface ActiveRun {
  actor: RunActor;
  reason: CompactionReason;
  startedAt: number;
}

const DEFAULT_MAX_AUTO_ATTEMPTS = 3;

function errorMessageOf(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? String(typeof error);
}

export function createCompactionController(deps: CompactionControllerDeps): CompactionController {
  const maxAutoAttempts = deps.maxAutoAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;
  const machine = createCompactionMachine(deps);
  let active: ActiveRun | undefined;
  let pendingAuto: { reason: 'budget' | 'overflow'; origin: CompactionOrigin } | undefined;
  let attempts: { turnId?: number; count: number } = { count: 0 };

  const record = (event: {
    type: string;
    agentId: string;
    reason?: string;
    instruction?: string;
    cause?: string;
    errorMessage?: string;
  }): void => {
    void deps.stores.session.dispatch(event).then(
      () => undefined,
      () => undefined,
    );
  };

  const budgetExceeded = (used: number): boolean => {
    const max = deps.budget.maxContextTokens();
    return max > 0 && used >= max * deps.budget.triggerRatio;
  };

  const firePending = (): void => {
    const scheduled = pendingAuto;
    pendingAuto = undefined;
    if (scheduled === undefined) return;
    queueMicrotask(() => void run(scheduled.reason, undefined, scheduled.origin));
  };

  const pipeEvents = (actor: RunActor): Subscription[] => [
    actor.on('compaction.started', (event) => {
      deps.onEvent?.(event);
      record({
        type: 'compaction.started',
        agentId: deps.agentId,
        reason: event.reason,
        instruction: event.instruction,
      });
    }),
    actor.on('compaction.blocked', (event) => {
      deps.onEvent?.(event);
    }),
    actor.on('compaction.completed', (event) => {
      deps.onEvent?.(event);
      record({ type: 'compaction.completed', agentId: deps.agentId });
      active = undefined;
      firePending();
    }),
    actor.on('compaction.cancelled', (event) => {
      deps.onEvent?.(event);
      record({
        type: 'compaction.cancelled',
        agentId: deps.agentId,
        cause: event.cause,
        errorMessage: errorMessageOf(event.error),
      });
    }),
  ];

  const run = async (
    reason: CompactionReason,
    instruction?: string,
    origin?: CompactionOrigin,
  ): Promise<void> => {
    if (active !== undefined) {
      if (reason === 'manual') {
        throw new CompactError('busy', 'compaction is already running');
      }
      pendingAuto = { reason: reason as 'budget' | 'overflow', origin: origin as CompactionOrigin };
      return;
    }
    if (deps.stores.get(deps.agentId) === undefined) {
      if (reason === 'manual') {
        throw new CompactError('unknown-agent', `unknown agent: '${deps.agentId}'`);
      }
      if (origin !== undefined) {
        deps.agent.contextReset({
          error: new CompactError('unknown-agent', `unknown agent: '${deps.agentId}'`),
        });
      }
      return;
    }
    const actor = createActor(machine, { input: { reason, instruction, origin } });
    const current = { actor, reason, startedAt: Date.now() };
    active = current;
    const subscriptions = pipeEvents(actor);
    actor.start();
    try {
      const snapshot = await waitFor(actor, (currentSnapshot) => currentSnapshot.status !== 'active');
      const output = snapshot.output as CompactionMachineOutput;
      if (output.status === 'completed') {
        return;
      }
      if (reason === 'manual') {
        throw output.error;
      }
    } finally {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      if (active === current) {
        active = undefined;
      }
      actor.stop();
    }
  };

  const subscriptions: Subscription[] = [
    deps.agent.on('turn.compaction_requested', (event) => {
      if (attempts.turnId !== event.turnId) {
        attempts = { turnId: event.turnId, count: 0 };
      }
      attempts.count += 1;
      if (attempts.count > maxAutoAttempts) {
        deps.agent.contextReset({
          error: new CompactError(
            'attempts-exceeded',
            `auto compaction exceeded ${maxAutoAttempts} attempts for turn ${event.turnId}`,
          ),
        });
        return;
      }
      const origin: CompactionOrigin = { turnId: event.turnId, history: event.history };
      queueMicrotask(() => void run(event.reason, undefined, origin));
    }),
    deps.agent.on('turn.done', (event) => {
      if (event.outcome.type === 'done') {
        attempts = { count: 0 };
      }
    }),
    deps.agent.on('turn.aborting', () => {
      active?.actor.send({ type: 'cancel', cause: 'user-abort' });
    }),
  ];

  const onBeforeStep: TurnBeforeStep = async ({
    messages,
    tools,
    systemPrompt,
  }: TurnBeforeStepContext) => {
    const used = usedContextTokens(messages, {
      systemPrompt,
      tools,
    });
    if (!budgetExceeded(used)) return undefined;
    return { compact: true };
  };

  return {
    compact: (instruction) => run('manual', instruction),
    cancel: () => {
      active?.actor.send({ type: 'cancel', cause: 'cancelled' });
    },
    status: () =>
      active === undefined
        ? { phase: 'idle' }
        : {
            phase: active.actor.getSnapshot().value as CompactionPhase,
            reason: active.reason,
            startedAt: active.startedAt,
          },
    onBeforeStep,
    dispose: () => {
      active?.actor.send({ type: 'cancel', cause: 'cancelled' });
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    },
  };
}
