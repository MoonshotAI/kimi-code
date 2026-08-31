import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

const BUDGET_UNITS = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'] as const;

export const SetGoalBudgetToolInputSchema = z
  .object({
    value: z.number().positive().describe('The positive numeric budget value.'),
    unit: z.enum(BUDGET_UNITS),
  })
  .strict();

export type SetGoalBudgetToolInput = z.infer<typeof SetGoalBudgetToolInputSchema>;

export interface ISetGoalBudgetTool extends AgentTool<SetGoalBudgetToolInput> { readonly _serviceBrand: undefined }
export const ISetGoalBudgetTool = createDecorator<ISetGoalBudgetTool>('setGoalBudgetTool');
