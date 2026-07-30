/**
 * `tools` domain (L7) — `ITaskOutputTool` contract (the `TaskOutput` tool).
 *
 * Public contract of the `TaskOutput` tool (read output from a managed
 * task): the input zod schema the model-facing parameters are derived from
 * and the `ITaskOutputTool` DI decorator that the implementation
 * (`taskOutputTool.ts`) registers against via `registerAgentToolService`. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect.'),
});

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;


export interface ITaskOutputTool extends AgentTool<TaskOutputInput> { readonly _serviceBrand: undefined }
export const ITaskOutputTool = createDecorator<ITaskOutputTool>('taskOutputTool');
