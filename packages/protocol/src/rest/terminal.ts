import { z } from 'zod';

import { isoDateTimeSchema } from '../time';

const relativeCwdSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolutePath(value), 'cwd must be relative to the session workspace');

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

export const createTerminalRequestSchema = z.object({
  cwd: relativeCwdSchema.optional(),
  shell: z.string().min(1).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;

export const listTerminalsResponseSchema = z.object({
  items: z.array(terminalSchema),
});
export type ListTerminalsResponse = z.infer<typeof listTerminalsResponseSchema>;

export const getTerminalResponseSchema = terminalSchema;
export type GetTerminalResponse = z.infer<typeof getTerminalResponseSchema>;

export const closeTerminalResponseSchema = z.object({
  closed: z.literal(true),
});
export type CloseTerminalResponse = z.infer<typeof closeTerminalResponseSchema>;

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}
