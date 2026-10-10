import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const NOTIFY_USER_TOOL_NAME = 'NotifyUser' as const;

export const NOTIFY_USER_DELIVERED_OUTPUT = 'Update shown to the user.';
export const NOTIFY_USER_EMPTY_TITLE = 'title must not be empty.';
export const NOTIFY_USER_EMPTY_MESSAGE = 'message must not be empty.';
export const NOTIFY_USER_SUPPRESSED_OUTPUT = 'Notifications are disabled; the update was not displayed.';

export interface NotifyUserInput {
  title: string;
  message: string;
}

export const NotifyUserInputSchema: z.ZodType<NotifyUserInput> = z.object({
  title: z
    .string()
    .min(1)
    .describe(
      "A one-line headline the user can take in at a glance: the conclusion or current phase, in the user's language, under ~60 characters, plain text.",
    ),
  message: z
    .string()
    .min(1)
    .describe(
      "The details behind the title, without repeating it: a short paragraph followed by a few bullet points of light Markdown, in the user's language, under ~1000 characters.",
    ),
});

export interface INotifyUserTool extends AgentTool<NotifyUserInput> {
  readonly _serviceBrand: undefined;
}
export const INotifyUserTool = createDecorator<INotifyUserTool>('notifyUserTool');
