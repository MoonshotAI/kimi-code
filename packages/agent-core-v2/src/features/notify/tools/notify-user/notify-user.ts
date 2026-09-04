import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const NOTIFY_USER_TOOL_NAME = 'NotifyUser' as const;

export interface NotifyUserInput {
  message: string;
}

export const NotifyUserInputSchema: z.ZodType<NotifyUserInput> = z.object({
  message: z
    .string()
    .min(1)
    .describe(
      "The update to show the user: a sentence or two of light Markdown in the user's language.",
    ),
});

export interface INotifyUserTool extends AgentTool<NotifyUserInput> {
  readonly _serviceBrand: undefined;
}
export const INotifyUserTool = createDecorator<INotifyUserTool>('notifyUserTool');
