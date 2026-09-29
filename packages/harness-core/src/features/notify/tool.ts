import type { ToolDefinition } from '@moonshot-ai/agent-core';
import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

import DESCRIPTION from './notify-user.md?raw';

export const NOTIFY_USER_TOOL_NAME = 'NotifyUser';

export const NOTIFY_USER_DELIVERED_OUTPUT = 'Update shown to the user.';
export const NOTIFY_USER_EMPTY_MESSAGE = 'message must not be empty.';
export const NOTIFY_USER_SUPPRESSED_OUTPUT =
  'Notifications are disabled; the update was not displayed.';

export interface NotifyUserToolDeps {
  readonly available: () => boolean;
  readonly fire: (event: RuntimeEvent) => void;
}

export function createNotifyUserTool(deps: NotifyUserToolDeps): ToolDefinition {
  return {
    name: NOTIFY_USER_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          description:
            "The update to show the user: a short intro paragraph followed by a few bullet points of light Markdown, in the user's language, under ~1000 characters.",
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      const args = JSON.parse(toolCall.arguments ?? '{}') as { message?: unknown };
      const message = typeof args.message === 'string' ? args.message : '';
      if (message.trim().length === 0) {
        return { content: [{ type: 'text', text: NOTIFY_USER_EMPTY_MESSAGE }], isError: true };
      }
      if (!deps.available()) {
        return { content: [{ type: 'text', text: NOTIFY_USER_SUPPRESSED_OUTPUT }] };
      }
      deps.fire({ type: 'notify.shown', message });
      return { content: [{ type: 'text', text: NOTIFY_USER_DELIVERED_OUTPUT }] };
    },
  };
}
