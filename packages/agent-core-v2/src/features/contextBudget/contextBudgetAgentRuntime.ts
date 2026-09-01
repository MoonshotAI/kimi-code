import { fromCallback, setup } from 'xstate';

import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { AgentReminder } from '#/features/reminder/reminderAgentRuntime';
import type { ContextInjectionResult } from '#/features/reminder/types';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import {
  COMPACTION_AHEAD_REMINDER_VARIANT,
  CONTEXT_BUDGET_REMINDER_VARIANT,
  compactionAheadLeadTokens,
  contextBudgetBucket,
  renderCompactionAheadReminder,
  renderContextBudgetReminder,
  shouldRemindCompactionAhead,
  type ContextBudgetDisclosure,
} from './contextBudgetReminder';
import { CONTEXT_BUDGET_REMINDERS_FLAG_ID } from './flag';

interface ContextBudgetActorContext {
  readonly runtime: AgentRuntimeContext<null>;
}

const contextBudgetReminders = fromCallback(({
  input,
}: {
  input: {
    readonly runtime: AgentRuntimeContext<null>;
  };
}) => {
  const runtime = input.runtime;
  const reminder = runtime
    .get(IAgentLifecycleService)
    .resolve(runtime.agent, AgentReminder);
  const flags = runtime.get(IFlagService);
  const compaction = runtime.get(IAgentFullCompactionService);
  const telemetry = runtime.get(ITelemetryService);
  const enabled = (): boolean => flags.enabled(CONTEXT_BUDGET_REMINDERS_FLAG_ID);

  const budgetRegistration = reminder.register<ContextBudgetDisclosure>(
    CONTEXT_BUDGET_REMINDER_VARIANT,
    ({ lastDisclosure }): ContextInjectionResult<ContextBudgetDisclosure> | undefined => {
      if (!enabled()) return undefined;
      const budget = compaction.budget();
      const bucket = contextBudgetBucket(budget);
      if (bucket === undefined || lastDisclosure?.bucket === bucket) return undefined;
      telemetry.track2('context_budget_reminder', {
        bucket,
        used_tokens: budget.used,
        trigger_tokens: budget.triggerTokens,
        max_tokens: budget.maxSize,
      });
      return { content: renderContextBudgetReminder(budget), disclosure: { bucket } };
    },
  );

  const aheadRegistration = reminder.register(
    COMPACTION_AHEAD_REMINDER_VARIANT,
    ({ lastInjection }): string | undefined => {
      if (!enabled()) return undefined;
      if (lastInjection !== undefined) return undefined;
      const budget = compaction.budget();
      if (!shouldRemindCompactionAhead(budget)) return undefined;
      telemetry.track2('compaction_ahead_reminder', {
        used_tokens: budget.used,
        trigger_tokens: budget.triggerTokens,
        lead_tokens: compactionAheadLeadTokens(budget),
      });
      return renderCompactionAheadReminder(budget);
    },
  );

  return () => {
    budgetRegistration.dispose();
    aheadRegistration.dispose();
  };
});

const contextBudgetActorLogic = setup({
  types: {} as {
    context: ContextBudgetActorContext;
    input: AgentRuntimeContext<null>;
    events: AgentRuntimeRestoreEvent;
  },
  actors: { contextBudgetReminders },
}).createMachine({
  context: ({ input }) => ({ runtime: input }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        src: 'contextBudgetReminders',
        input: ({ context }) => ({ runtime: context.runtime }),
      },
    },
  },
});

export class ContextBudgetRuntime {
  constructor(private readonly context: AgentRuntimeContext<null>) {}

  get agentId(): string {
    return this.context.agent.agentId;
  }
}

export const AgentContextBudget = defineAgentRuntimeContract<ContextBudgetRuntime>('contextBudget');

export const contextBudgetAgentRuntimeProvider = defineAgentRuntimeProvider<null, ContextBudgetRuntime>(
  AgentContextBudget,
  {
    id: 'contextBudget',
    logic: contextBudgetActorLogic,
    eager: true,
    createApi: (context) => new ContextBudgetRuntime(context),
  },
);
