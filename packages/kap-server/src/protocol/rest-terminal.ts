/**
 *   GET    /v1/sessions/{session_id}/terminals
 *   GET    /v1/sessions/{session_id}/terminals/{terminal_id}
 *   DELETE /v1/sessions/{session_id}/terminals/{terminal_id}
 *
 * The `Terminal` shape itself is owned by the engine (`os/interface/terminal`);
 * these are only the REST list/get/close wrappers around it.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './message';

/**
 * Locally-owned terminal wire schemas (stage 4: protocol localisation) —
 * copied from the v2 `os/interface/terminal` so kap-server no longer imports
 * it. The `Terminal` shape itself is owned by the engine (`os/interface/terminal`);
 * these are only the REST list/get/close wrappers around it.
 */
export const terminalStatusSchema = z.enum(['running', 'exited']);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const terminalSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  shell: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  status: terminalStatusSchema,
  created_at: isoDateTimeSchema,
  exited_at: isoDateTimeSchema.optional(),
  exit_code: z.number().int().nullable().optional(),
});
export type Terminal = z.infer<typeof terminalSchema>;

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
