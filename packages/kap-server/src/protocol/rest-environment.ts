import { z } from 'zod';

export const environmentBindingResponseSchema = z.object({
  workspace_id: z.string(),
  environment_id: z.string(),
  cwd: z.string().optional(),
});

export const switchEnvironmentRequestSchema = z.object({
  environment_id: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

export const sessionEnvironmentParamsSchema = z.object({
  session_id: z.string().min(1),
});

export const sessionEnvironmentEntrySchema = z.object({
  environment_id: z.string(),
  type: z.enum(['local', 'ssh', 'docker', 'command']),
  status: z.enum(['connecting', 'ready', 'degraded', 'disconnected', 'draining', 'disposed']),
  generation: z.string(),
  capabilities: z.array(z.enum(['fs', 'process', 'terminal'])),
  default_cwd: z.string().optional(),
  connect_error: z.string().optional(),
});

export const sessionEnvironmentsResponseSchema = z.object({
  workspace_id: z.string(),
  environments: z.array(sessionEnvironmentEntrySchema),
  ssh_hosts: z.array(z.string()),
});

export type EnvironmentBindingResponse = z.infer<typeof environmentBindingResponseSchema>;
export type SessionEnvironmentEntry = z.infer<typeof sessionEnvironmentEntrySchema>;
export type SessionEnvironmentsResponse = z.infer<typeof sessionEnvironmentsResponseSchema>;
