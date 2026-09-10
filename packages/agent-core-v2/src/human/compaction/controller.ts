import { estimateUsedContextTokens } from '#/agent/context-usage';
import type { ExternalEvent } from '#/eventStore/events';
import type { UserMessage } from '#/llm/message';
import {
  compactionCancelled,
  compactionCompleted,
  compactionStarted,
} from '#/session/events';
import type { AgentActorRef } from '#/session/machine';
import type { SessionStores } from '#/session/stores';
import type { TurnBeforeStep, TurnBeforeStepContext } from '#/agent/turn';
import { createActor, waitFor, type ActorRefFrom, type Subscription } from '#/xstate2';

import { CompactError, isContextOverflowError } from './errors';
import {
  createCompactionMachine,
  type CompactionEvent,
  type CompactionMachineOutput,
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
  actor: AgentActorRef;
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
  compact(instruction?: string): Promise<{ branchId: string }>;
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
  let pendingAuto: { reason: 'budget' | 'overflow' } | undefined;
  let overflowAttempts = 0;
  let lastCompactedTokens: number | undefined;

  const record = (event: ExternalEvent): void => {
    void deps.stores
      .session()
      .then((session) => session.dispatch(event))
      .then(
        () => undefined,
        () => undefined,
      );
  };

  const budgetExceeded = (used: number): boolean => {
    const max = deps.budget.maxContextTokens();
    if (max <= 0 || used < max * deps.budget.triggerRatio) return false;
    return lastCompactedTokens === undefined || used > lastCompactedTokens;
  };

  const firePending = (): void => {
    const scheduled = pendingAuto;
    pendingAuto = undefined;
    if (scheduled === undefined) return;
    if (scheduled.reason === 'budget') {
      const history = deps.stores.get(deps.agentId)?.getState().history;
      if (history === undefined || !budgetExceeded(estimateUsedContextTokens(history))) {
        return;
      }
    }
    queueMicrotask(() => void run(scheduled.reason));
  };

  const pipeEvents = (actor: RunActor): Subscription[] => [
    actor.on('compaction.started', (event) => {
      deps.onEvent?.(event);
      record(
        compactionStarted({
          agentId: deps.agentId,
          reason: event.reason,
          instruction: event.instruction,
        }),
      );
    }),
    actor.on('compaction.blocked', (event) => {
      deps.onEvent?.(event);
    }),
    actor.on('compaction.completed', (event) => {
      deps.onEvent?.(event);
      record(compactionCompleted({ agentId: deps.agentId, branch: event.branchId }));
      lastCompactedTokens = event.stats.tokensBefore;
      active = undefined;
      firePending();
    }),
    actor.on('compaction.cancelled', (event) => {
      deps.onEvent?.(event);
      record(
        compactionCancelled({
          agentId: deps.agentId,
          cause: event.cause,
          errorMessage: errorMessageOf(event.error),
        }),
      );
      active = undefined;
      firePending();
    }),
  ];

  const run = async (
    reason: CompactionReason,
    instruction?: string,
  ): Promise<{ branchId: string } | undefined> => {
    if (active !== undefined) {
      if (reason === 'manual') {
        throw new CompactError('busy', 'compaction is already running');
      }
      pendingAuto = { reason };
      return undefined;
    }
    if (deps.stores.get(deps.agentId) === undefined) {
      if (reason === 'manual') {
        throw new CompactError('unknown-agent', `unknown agent: '${deps.agentId}'`);
      }
      return undefined;
    }
    const actor = createActor(machine, { input: { reason, instruction } });
    const current = { actor, reason, startedAt: Date.now() };
    active = current;
    const subscriptions = pipeEvents(actor);
    await deps.stores.session();
    actor.start();
    try {
      const snapshot = await waitFor(actor, (s) => s.status !== 'active');
      const output = snapshot.output as CompactionMachineOutput;
      if (output.status === 'completed') {
        return { branchId: output.branchId };
      }
      if (reason === 'manual') {
        throw output.error;
      }
      return undefined;
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
    deps.actor.on('turn.done', () => {
      overflowAttempts = 0;
    }),
    deps.actor.on('turn.failed', (event) => {
      if (!isContextOverflowError(event.error) || overflowAttempts >= maxAutoAttempts) {
        return;
      }
      overflowAttempts += 1;
      queueMicrotask(() => void run('overflow'));
    }),
    deps.actor.on('turn.aborting', () => {
      active?.actor.send({ type: 'cancel', cause: 'user-abort' });
    }),
  ];

  const onBeforeStep: TurnBeforeStep = async ({ messages, request }: TurnBeforeStepContext) => {
    const used = estimateUsedContextTokens(messages, {
      systemPrompt: request.systemPrompt,
      tools: request.tools,
    });
    if (!budgetExceeded(used)) return;
    queueMicrotask(() => void run('budget'));
    throw new CompactError('budget-blocked', 'context budget exceeded; compacting before next step');
  };

  return {
    compact: (instruction) => run('manual', instruction) as Promise<{ branchId: string }>,
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
