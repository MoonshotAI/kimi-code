import { z } from 'zod';

import { type AgentTool } from '#/tool/toolContract';

export const TaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect.'),
});

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export type ITaskOutputTool = AgentTool<TaskOutputInput>;
