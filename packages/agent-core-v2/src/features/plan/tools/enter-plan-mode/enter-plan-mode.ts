import { z } from 'zod';

import type { AgentTool } from '#/tool/toolContract';

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;

export type IEnterPlanModeTool = AgentTool<EnterPlanModeInput>;
