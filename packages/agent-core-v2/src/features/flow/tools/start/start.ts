import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const FlowStartInputSchema = z.object({
  flow: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'flow id must be kebab-case')
    .describe(
      'Flow id: the basename of a definition file under the project .kimi-code/flows/ or the user-level ~/.kimi-code/flows/ (e.g. "issue-fix" for .kimi-code/flows/issue-fix.md).',
    ),
  task: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The concrete task for this run, in the user's own words plus any context they gave. This becomes the run's stated intent.",
    ),
});
export type FlowStartInput = z.infer<typeof FlowStartInputSchema>;

export interface IFlowStartTool extends AgentTool<FlowStartInput> {
  readonly _serviceBrand: undefined;
}
export const IFlowStartTool: ServiceIdentifier<IFlowStartTool> =
  createDecorator<IFlowStartTool>('flowStartTool');
