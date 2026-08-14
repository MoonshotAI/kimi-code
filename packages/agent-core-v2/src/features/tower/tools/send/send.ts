/**
 * `tools` domain — `ITowerSendTool` contract (the `TowerSend` tool).
 *
 * Public contract of the tower inbox sender: delivers a message to a roster
 * agent, the tower, or everyone ("all"); the store builds the file name and
 * frontmatter. Exports the model-facing `TowerSendToolInputSchema` /
 * `TowerSendToolInput` and the `ITowerSendTool` DI decorator. Bound at Agent
 * scope.
 */

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
  })
  .strict();

export type TowerSendToolInput = z.infer<typeof TowerSendToolInputSchema>;

export interface ITowerSendTool extends AgentTool<TowerSendToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerSendTool = createDecorator<ITowerSendTool>('towerSendTool');
