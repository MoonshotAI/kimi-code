import { z } from 'zod';

export const runtimeBindingResponseSchema = z.object({
  workspace_id: z.string(),
  runtime_id: z.string(),
  cwd: z.string().optional(),
});

export const switchRuntimeRequestSchema = z.object({
  runtime_id: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

export const sessionRuntimeParamsSchema = z.object({
  session_id: z.string().min(1),
});

export const sessionRuntimeEntrySchema = z.object({
  runtime_id: z.string(),
  type: z.enum(['local', 'ssh', 'docker', 'command']),
  status: z.enum(['connecting', 'ready', 'degraded', 'disconnected', 'draining', 'disposed']),
  generation: z.string(),
  capabilities: z.array(z.enum(['fs', 'process', 'terminal'])),
  default_cwd: z.string().optional(),
  connect_error: z.string().optional(),
});

export const sessionRuntimesResponseSchema = z.object({
  workspace_id: z.string(),
  runtimes: z.array(sessionRuntimeEntrySchema),
  ssh_hosts: z.array(z.string()),
});

export type RuntimeBindingResponse = z.infer<typeof runtimeBindingResponseSchema>;
export type SessionRuntimeEntry = z.infer<typeof sessionRuntimeEntrySchema>;
export type SessionRuntimesResponse = z.infer<typeof sessionRuntimesResponseSchema>;
