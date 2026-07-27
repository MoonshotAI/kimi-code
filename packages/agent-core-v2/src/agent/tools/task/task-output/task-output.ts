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
  block: z
    .boolean()
    .default(false)
    .describe(
      'Whether to wait for the task to finish before returning. Discouraged — background tasks notify automatically on completion; use only when the user explicitly asked you to wait.',
    )
    .optional(),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(30)
    .describe('Maximum number of seconds to wait when block=true.')
    .optional(),
});

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;


export interface ITaskOutputTool extends AgentTool<TaskOutputInput> { readonly _serviceBrand: undefined }
export const ITaskOutputTool = createDecorator<ITaskOutputTool>('taskOutputTool');
