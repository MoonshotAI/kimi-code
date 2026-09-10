import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TaskStopInputSchema = z.object({
  task_id: z.string().describe('The background task ID to stop — the tool call ID of the Bash/Agent/AskUserQuestion call that started the task, as shown by TaskList.'),
  reason: z
    .string()
    .default('Stopped by TaskStop')
    .describe('Short reason recorded when the task is stopped.')
    .optional(),
});

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export interface ITaskStopTool extends AgentTool<TaskStopInput> { readonly _serviceBrand: undefined }
export const ITaskStopTool = createDecorator<ITaskStopTool>('taskStopTool');
