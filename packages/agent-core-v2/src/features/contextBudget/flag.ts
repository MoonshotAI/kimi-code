import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const CONTEXT_BUDGET_REMINDERS_FLAG_ID = 'context_budget_reminders';
export const CONTEXT_BUDGET_REMINDERS_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_CONTEXT_BUDGET_REMINDERS';

export const contextBudgetRemindersFlag: FlagDefinitionInput = {
  id: CONTEXT_BUDGET_REMINDERS_FLAG_ID,
  title: 'Context budget reminders',
  description:
    'Tell the model how much of its context budget is used as it crosses half, three quarters and ninety percent of the compaction trigger, and warn it once per window when automatic compaction is imminent.',
  env: CONTEXT_BUDGET_REMINDERS_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(contextBudgetRemindersFlag);
