import { z } from 'zod';

import {
  createTerminalRequestSchema as engineCreateTerminalRequestSchema,
  terminalSchema,
} from '@moonshot-ai/agent-core-v2/os/interface/terminal';

export const createTerminalRequestSchema = engineCreateTerminalRequestSchema.extend({
  runtime_id: z.string().min(1).optional(),
});
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;

export const getTerminalResponseSchema = terminalSchema;
export type GetTerminalResponse = z.infer<typeof getTerminalResponseSchema>;

export const listTerminalsResponseSchema = z.object({
  items: z.array(terminalSchema),
});
export type ListTerminalsResponse = z.infer<typeof listTerminalsResponseSchema>;

export const closeTerminalResponseSchema = z.object({
  closed: z.literal(true),
});
export type CloseTerminalResponse = z.infer<typeof closeTerminalResponseSchema>;
