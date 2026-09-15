import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;

export interface IEnterPlanModeTool extends AgentTool<EnterPlanModeInput> {
  readonly _serviceBrand: undefined;
}
export const IEnterPlanModeTool = createDecorator<IEnterPlanModeTool>('enterPlanModeTool');
