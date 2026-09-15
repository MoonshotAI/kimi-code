import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { DEFAULT_BACKGROUND_TIMEOUT_S } from '#/agent/tools/os/bash/bash';

export const WAIT_FOR_MAX_TIMEOUT_S = DEFAULT_BACKGROUND_TIMEOUT_S;

export const WaitForInputSchema = z.object({
  timeout: z
    .number()
    .int()
    .positive()
    .max(WAIT_FOR_MAX_TIMEOUT_S)
    .describe(
      `Maximum time to wait, in seconds (1-${String(WAIT_FOR_MAX_TIMEOUT_S)}). A timeout is not an error: the tool returns the tasks that are still running, and you can call it again to keep waiting.`,
    ),
  task_id: z
    .string()
    .optional()
    .describe(
      'The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.',
    ),
});

export type WaitForInput = z.infer<typeof WaitForInputSchema>;

export interface IWaitForTool extends AgentTool<WaitForInput> { readonly _serviceBrand: undefined }
export const IWaitForTool = createDecorator<IWaitForTool>('waitForTool');
