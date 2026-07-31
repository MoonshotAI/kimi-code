/**
 * `tools` domain — `ISelectToolsTool` contract (the `select_tools` tool).
 *
 * Public contract of `select_tools`, the load-by-exact-name primitive of
 * progressive tool disclosure: the model-facing `SelectToolsInputSchema` /
 * `SelectToolsInput` and the `ISelectToolsTool` DI decorator. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const SelectToolsInputSchema = z
  .object({
    names: z
      .array(z.string())
      .min(1)
      .describe('Exact tool names to load, taken from the latest announced tool list.'),
  })
  .strict();

export type SelectToolsInput = z.infer<typeof SelectToolsInputSchema>;

export interface ISelectToolsTool extends AgentTool<SelectToolsInput> { readonly _serviceBrand: undefined }
export const ISelectToolsTool = createDecorator<ISelectToolsTool>('selectToolsTool');
