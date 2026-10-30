import { z } from 'zod';

import { environmentStatusSchema } from './events-zod';

export const environmentBindingResponseSchema = z.object({
  workspace_id: z.string(),
  environment_id: z.string(),
  cwd: z.string().optional(),
});

export const sessionEnvironmentParamsSchema = z.object({
  session_id: z.string().min(1),
});

export const sessionEnvironmentEntrySchema = z.object({
  environment_id: z.string(),
  type: z.enum(['local', 'ssh', 'docker', 'command']),
  status: environmentStatusSchema,
  connect_error: z.string().optional(),
});

export const sessionEnvironmentsResponseSchema = z.object({
  environments: z.array(sessionEnvironmentEntrySchema),
});

export type EnvironmentBindingResponse = z.infer<typeof environmentBindingResponseSchema>;
export type SessionEnvironmentEntry = z.infer<typeof sessionEnvironmentEntrySchema>;
export type SessionEnvironmentsResponse = z.infer<typeof sessionEnvironmentsResponseSchema>;
