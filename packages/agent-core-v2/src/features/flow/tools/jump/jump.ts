import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const FlowJumpInputSchema = z.object({
  to: z
    .string()
    .trim()
    .min(1)
    .describe('The id of the stage to move the run to — earlier to redo, later to skip.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Why the run must move there: what invalidated the current position, or why the skipped stages do not apply to this task. Recorded in the audit trail.',
    ),
});
export type FlowJumpInput = z.infer<typeof FlowJumpInputSchema>;

export interface IFlowJumpTool extends AgentTool<FlowJumpInput> {
  readonly _serviceBrand: undefined;
}
export const IFlowJumpTool: ServiceIdentifier<IFlowJumpTool> =
  createDecorator<IFlowJumpTool>('flowJumpTool');
