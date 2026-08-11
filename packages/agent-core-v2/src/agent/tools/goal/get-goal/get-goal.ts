/**
 * `tools` domain — `IGetGoalTool` contract.
 *
 * Public contract of the GetGoal tool: the (empty) input schema and the
 * Agent-scope identifier used to resolve the implementation through the
 * container. The tool returns the current goal snapshot — objective, status,
 * budgets, and usage counters — so the model can decide whether to continue,
 * report completion via UpdateGoal, report a blocker, or respect a pause.
 * Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const GetGoalToolInputSchema = z.object({}).strict();
export type GetGoalToolInput = z.infer<typeof GetGoalToolInputSchema>;

export interface IGetGoalTool extends AgentTool<GetGoalToolInput> { readonly _serviceBrand: undefined }
export const IGetGoalTool = createDecorator<IGetGoalTool>('getGoalTool');
