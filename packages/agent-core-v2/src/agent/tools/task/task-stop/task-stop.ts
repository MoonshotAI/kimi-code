import { z } from 'zod';

import { type AgentTool } from '#/tool/toolContract';

export const TaskStopInputSchema = z.object({
  task_id: z.string().describe('The background task ID to stop.'),
  reason: z
    .string()
    .default('Stopped by TaskStop')
    .describe('Short reason recorded when the task is stopped.')
    .optional(),
});

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export type ITaskStopTool = AgentTool<TaskStopInput>;
