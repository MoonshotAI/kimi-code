/**
 * `tools` domain — `IEnterPlanModeTool` contract.
 *
 * Public contract of the EnterPlanMode tool — the plan-mode entry tool the
 * LLM calls to enter plan mode directly: the (empty) input schema and the
 * Agent-scope identifier used to resolve the implementation through the
 * container. Entering plan mode does not require approval in any permission
 * mode. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;

export interface IEnterPlanModeTool extends AgentTool<EnterPlanModeInput> {
  readonly _serviceBrand: undefined;
}
export const IEnterPlanModeTool = createDecorator<IEnterPlanModeTool>('enterPlanModeTool');
