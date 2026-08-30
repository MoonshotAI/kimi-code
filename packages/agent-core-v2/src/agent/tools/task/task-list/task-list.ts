import { z } from 'zod';

import { type AgentTool } from '#/tool/toolContract';

export const TaskListInputSchema = z.object({
  active_only: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to list only non-terminal background tasks.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of tasks to return.')
    .optional(),
});

export type TaskListInput = z.infer<typeof TaskListInputSchema>;

export type ITaskListTool = AgentTool<TaskListInput>;
