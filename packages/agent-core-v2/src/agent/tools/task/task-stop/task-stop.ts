/**
 * `tools` domain (L7) — `ITaskStopTool` contract (the `TaskStop` tool).
 *
 * Public contract of the `TaskStop` tool (stop a running task): the input
 * zod schema the model-facing parameters are derived from and the
 * `ITaskStopTool` DI decorator that the implementation (`taskStopTool.ts`)
 * registers against via `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
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


export interface ITaskStopTool extends AgentTool<TaskStopInput> { readonly _serviceBrand: undefined }
export const ITaskStopTool = createDecorator<ITaskStopTool>('taskStopTool');
