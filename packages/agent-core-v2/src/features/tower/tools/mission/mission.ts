import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerMissionToolInputSchema = z
  .object({
    id: z.string().describe('Mission id (e.g. "M1")'),
    status: z
      .enum(['planned', 'active', 'completed', 'blocked', 'paused', 'merged'])
      .optional()
      .describe('New lifecycle status'),
    note: z.string().optional().describe('Append a decision-log note'),
    blocker: z.string().optional().describe('Report a blocker (also sets status to blocked)'),
    clear_blockers: z.boolean().optional().describe('Clear all recorded blockers'),
    task_done: z
      .string()
      .optional()
      .describe('Mark the first open task containing this text as done'),
    scope: z
      .array(z.string())
      .optional()
      .describe(
        'Tower only: replace the mission scope globs (picomatch — `**` crosses directories). Logged; widens what the merge gate accepts.',
      ),
  })
  .strict();

export type TowerMissionToolInput = z.infer<typeof TowerMissionToolInputSchema>;

export interface ITowerMissionTool extends AgentTool<TowerMissionToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerMissionTool = createDecorator<ITowerMissionTool>('towerMissionTool');
