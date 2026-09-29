import { z } from 'zod';

import { type ToolDefinition } from '@moonshot-ai/agent-core';

import DESCRIPTION from './inbox.md?raw';
import {
  callerName,
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  type TowerToolDeps,
} from './support';

export const TowerInboxToolInputSchema = z
  .object({
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Max messages to return (default 20), newest first'),
  })
  .strict();

export type TowerInboxToolInput = z.infer<typeof TowerInboxToolInputSchema>;

const DEFAULT_LIMIT = 20;

export function createTowerInboxTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerInbox',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerInboxToolInputSchema),
    execute({ toolCall }) {
      const parsed = parseTowerArgs(TowerInboxToolInputSchema, toolCall.arguments, 'TowerInbox');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const state = await store.load();
        const caller = callerName(deps.agentId, store, state);
        const items = await store.readInbox(caller, args.limit ?? DEFAULT_LIMIT);
        if (items.length === 0) {
          return text(`inbox empty for ${caller}`);
        }
        const sections = items.map((item) =>
          [
            `file: ${item.file}`,
            `from: ${item.from}`,
            `to: ${item.to}`,
            `subject: ${item.subject}`,
            `sent_at: ${item.sentAt}`,
            ...(item.scope !== undefined ? [`scope: ${item.scope}`] : []),
            ...(item.action !== undefined ? [`action: ${item.action}`] : []),
            '',
            item.body,
          ].join('\n'),
        );
        return text(
          [
            `${String(items.length)} message(s) for ${caller} (newest first):`,
            '',
            sections.join('\n\n---\n\n'),
          ].join('\n'),
        );
      });
    },
  };
}
