import { z } from 'zod';

import { type AgentTool } from '#/tool/toolContract';

export const GetGoalToolInputSchema = z.object({}).strict();
export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export type IGetGoalTool = AgentTool<GetGoalToolInput>;
