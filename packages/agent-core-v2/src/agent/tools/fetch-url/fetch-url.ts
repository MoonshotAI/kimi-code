import { z } from 'zod';

import { type AgentTool } from '#/tool/toolContract';

export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
});

export type FetchURLInput = z.infer<typeof FetchURLInputSchema>;

export type IFetchURLTool = AgentTool<FetchURLInput>;
