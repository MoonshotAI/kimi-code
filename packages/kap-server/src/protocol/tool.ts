import { z } from 'zod';

export const toolSourceSchema = z.enum(['builtin', 'skill', 'mcp']);
export type ToolSource = z.infer<typeof toolSourceSchema>;

export const toolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.unknown(),
  source: toolSourceSchema,
  mcp_server_id: z.string().min(1).optional(),
  active: z.boolean().optional(),
});
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;
