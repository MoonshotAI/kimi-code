import { z } from 'zod';

import { toolDescriptorSchema } from './tool';

export const listToolsQuerySchema = z.object({
  session_id: z.string().min(1).optional(),
});
export type ListToolsQuery = z.infer<typeof listToolsQuerySchema>;

export const listToolsResponseSchema = z.object({
  tools: z.array(toolDescriptorSchema),
});
export type ListToolsResponse = z.infer<typeof listToolsResponseSchema>;
