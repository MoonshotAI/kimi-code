import { z } from 'zod';

export const globalAgentsMdResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  exists: z.boolean(),
});
export type GlobalAgentsMdResponse = z.infer<typeof globalAgentsMdResponseSchema>;

export const writeGlobalAgentsMdRequestSchema = z.object({
  content: z.string(),
});
export type WriteGlobalAgentsMdRequest = z.infer<typeof writeGlobalAgentsMdRequestSchema>;
