import { z } from 'zod';

import { MAIN_AGENT_ID, type ToolDefinition } from '@moonshot-ai/agent-core';

import { CRON_MAIN_AGENT_ONLY } from './cron-create';

import CRON_DELETE_DESCRIPTION from './cron-delete.md?raw';

export const CronDeleteInputSchema = z.object({
  id: z
    .string()
    .describe('The cron job id (UUID) returned by CronCreate / CronList.'),
});

export type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createCronDeleteTool(
  cron: {
    readonly removeTasks: (ids: readonly string[]) => Promise<readonly string[]>;
  },
  agentId: string,
): ToolDefinition {
  return {
    name: 'CronDelete',
    description: CRON_DELETE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The cron job id (UUID) returned by CronCreate / CronList.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      if (agentId !== MAIN_AGENT_ID) {
        return { content: [{ type: 'text', text: CRON_MAIN_AGENT_ONLY }], isError: true };
      }
      let rawArgs: unknown;
      try {
        rawArgs = JSON.parse(toolCall.arguments ?? '{}');
      } catch {
        return {
          content: [{ type: 'text', text: `Invalid CronDelete arguments: ${toolCall.arguments ?? ''}` }],
          isError: true,
        };
      }
      const args = CronDeleteInputSchema.safeParse(rawArgs);
      if (!args.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid CronDelete arguments: ${args.error.issues[0]?.message ?? 'invalid input'}`,
            },
          ],
          isError: true,
        };
      }
      if (!ID_PATTERN.test(args.data.id)) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid cron job id ${JSON.stringify(args.data.id)} — must be a UUID.`,
            },
          ],
          isError: true,
        };
      }
      const removed = await cron.removeTasks([args.data.id]);
      if (removed.length === 0) {
        return {
          content: [{ type: 'text', text: `No cron job with id ${args.data.id}.` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: `Deleted cron job ${args.data.id}.` }] };
    },
  };
}
