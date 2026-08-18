import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const FlowAbortInputSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe("Why the run is being aborted — verbatim user instruction when available."),
});
export type FlowAbortInput = z.infer<typeof FlowAbortInputSchema>;

export interface IFlowAbortTool extends AgentTool<FlowAbortInput> {
  readonly _serviceBrand: undefined;
}
export const IFlowAbortTool: ServiceIdentifier<IFlowAbortTool> =
  createDecorator<IFlowAbortTool>('flowAbortTool');
