import { z } from 'zod';

export const agentProfileNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const agentProfileParamsSchema = z.object({
  name: agentProfileNameSchema,
});

export const agentProfileSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

export const agentProfileDetailSchema = agentProfileSummarySchema.extend({
  prompt: z.string(),
  etag: z.string(),
});

export const skippedAgentProfileSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const listAgentProfilesResponseSchema = z.object({
  root: z.string(),
  agents: z.array(agentProfileSummarySchema),
  skipped: z.array(skippedAgentProfileSchema),
});

export const getAgentProfileResponseSchema = z.object({
  agent: agentProfileDetailSchema,
});

export const createAgentProfileRequestSchema = z.object({
  name: agentProfileNameSchema,
  description: z.string().min(1),
  prompt: z.string().min(1),
}).strict();

export const updateAgentProfileRequestSchema = z.object({
  new_name: agentProfileNameSchema.optional(),
  description: z.string().min(1),
  prompt: z.string().min(1),
  etag: z.string().min(1),
}).strict();

export const deleteAgentProfileQuerySchema = z.object({
  etag: z.string().min(1),
});

export const agentProfileMutationResultSchema = z.object({
  agent: agentProfileDetailSchema,
  refresh_error: z.string().optional(),
});

export const deleteAgentProfileResultSchema = z.object({
  deleted: z.literal(true),
  refresh_error: z.string().optional(),
});

export const refreshAgentProfilesRequestSchema = z.object({}).strict();

export const refreshAgentProfilesResultSchema = z.object({
  refreshed: z.literal(true),
  refresh_error: z.string().optional(),
});
