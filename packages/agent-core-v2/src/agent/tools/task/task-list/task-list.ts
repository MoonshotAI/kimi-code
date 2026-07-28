/**
 * `tools` domain (L7) — `ITaskListTool` contract (the `TaskList` tool).
 *
 * Public contract of the `TaskList` tool (list background tasks): the input
 * zod schema the model-facing parameters are derived from and the
 * `ITaskListTool` DI decorator that the implementation (`taskListTool.ts`)
 * registers against via `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
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


export interface ITaskListTool extends AgentTool<TaskListInput> { readonly _serviceBrand: undefined }
export const ITaskListTool = createDecorator<ITaskListTool>('taskListTool');
