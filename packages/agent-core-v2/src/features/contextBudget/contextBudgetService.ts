import { fromCallback, setup } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import {
  AgentActorService,
  type AgentActorContext,
  type AgentActorRestoreEvent,
} from '#/agent/actorService/agentActorService';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionResult } from '#/features/reminder/types';
import { IEventDispatcher } from '#/state/eventDispatcher';

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
  readonly runtime: AgentActorContext<null>;
}

const contextBudgetReminders = fromCallback(({
  input,
}: {
  input: {
    readonly runtime: AgentActorContext<null>;
  };
}) => {
  const runtime = input.runtime;
  const reminder = runtime.get(IAgentReminderService);
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
    input: AgentActorContext<null>;
    events: AgentActorRestoreEvent;
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

export interface IAgentContextBudgetService {
  readonly _serviceBrand: undefined;
}

export const IAgentContextBudgetService = createDecorator<IAgentContextBudgetService>(
  'agentContextBudgetService',
);

export class AgentContextBudgetService
  extends AgentActorService<null>
  implements IAgentContextBudgetService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(dispatcher, scopeContext, instantiation);
    this.attachActor(contextBudgetActorLogic, { id: 'contextBudget' });
  }
}
