import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerSendToolInputSchema = z
  .object({
    to: z
      .string()
      .describe('Recipient: a roster agent name, "tower", or "all" (broadcast)'),
    subject: z.string().describe('One-line subject; keep it greppable'),
    body: z.string().describe('Full message body (markdown)'),
    scope: z.string().optional().describe('Optional scope tag (e.g. the mission id)'),
    action: z.string().optional().describe('Optional action tag for machine routing'),
    consent_ref: z
      .string()
      .optional()
      .describe('Optional reference to a consent/approval record this message relies on'),
    urgent: z
      .boolean()
      .optional()
      .describe(
        'Mark the message as an interruption directive. It is still delivered the same way (steered into the running turn, seen at the next step boundary) — urgent does not abort the recipient\'s in-flight tool call; for a hard abort, TaskStop the recipient\'s task and resume it with this message instead',
      ),
  })
  .strict();

export type TowerSendToolInput = z.infer<typeof TowerSendToolInputSchema>;

export interface ITowerSendTool extends AgentTool<TowerSendToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerSendTool = createDecorator<ITowerSendTool>('towerSendTool');
