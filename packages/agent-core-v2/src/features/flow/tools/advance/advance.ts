import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

import { FlowCriterionVerdictSchema } from '../../flow';

export const FlowAdvanceInputSchema = z.object({
  stage: z.string().describe('Id of the stage this verdict is for. Must be the current stage of the active flow run.'),
  verdict: z
    .enum(['pass', 'reject'])
    .describe(
      'pass = every completion criterion is met with evidence and the stage may close; reject = at least one criterion is unmet, record the rejection and continue reworking the stage.',
    ),
  criteria: z
    .array(FlowCriterionVerdictSchema)
    .min(1)
    .describe(
      "Per-criterion verdicts covering every clause of the stage's completion definition. Verify against artifacts and execution output, not the worker's claims.",
    ),
  note: z
    .string()
    .optional()
    .describe('Optional context for the record: reviewer findings, rejection rationale, next-stage advice.'),
});
export type FlowAdvanceInput = z.infer<typeof FlowAdvanceInputSchema>;

export interface IFlowAdvanceTool extends AgentTool<FlowAdvanceInput> {
  readonly _serviceBrand: undefined;
}
export const IFlowAdvanceTool: ServiceIdentifier<IFlowAdvanceTool> =
  createDecorator<IFlowAdvanceTool>('flowAdvanceTool');
