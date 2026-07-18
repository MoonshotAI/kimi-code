/**
 *   GET    /v1/sessions/{session_id}/terminals
 *   GET    /v1/sessions/{session_id}/terminals/{terminal_id}
 *   DELETE /v1/sessions/{session_id}/terminals/{terminal_id}
 *
 * The `Terminal` shape itself is owned by the engine (`os/interface/terminal`);
 * these are only the REST list/get/close wrappers around it.
 */

import { z } from 'zod';

import { terminalSchema } from '@moonshot-ai/agent-core-v2/os/interface/terminal';

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
