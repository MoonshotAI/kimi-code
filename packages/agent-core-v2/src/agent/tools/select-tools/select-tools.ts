import { z } from 'zod';

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

export type ISelectToolsTool = AgentTool<SelectToolsInput>;
