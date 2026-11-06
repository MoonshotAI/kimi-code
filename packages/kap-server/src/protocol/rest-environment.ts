import { z } from 'zod';

import { environmentEntrySchema } from './events-zod';

export const environmentBindingResponseSchema = z.object({
  workspace_id: z.string(),
  environment_id: z.string(),
  cwd: z.string().optional(),
});

export const sessionEnvironmentParamsSchema = z.object({
  session_id: z.string().min(1),
});

export const sessionEnvironmentEntrySchema = environmentEntrySchema;

export const connectEnvironmentRequestSchema = z.object({
  environment_id: z.string().min(1),
}).strict();

export const sessionEnvironmentsResponseSchema = z.object({
  environments: z.array(sessionEnvironmentEntrySchema),
});

export type EnvironmentBindingResponse = z.infer<typeof environmentBindingResponseSchema>;
export type SessionEnvironmentEntry = z.infer<typeof sessionEnvironmentEntrySchema>;
export type SessionEnvironmentsResponse = z.infer<typeof sessionEnvironmentsResponseSchema>;
