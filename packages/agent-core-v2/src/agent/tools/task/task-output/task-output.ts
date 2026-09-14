import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect — the tool call ID of the Bash/Agent/AskUserQuestion call that started the task, as shown by TaskList.'),
});

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export interface ITaskOutputTool extends AgentTool<TaskOutputInput> { readonly _serviceBrand: undefined }
export const ITaskOutputTool = createDecorator<ITaskOutputTool>('taskOutputTool');
