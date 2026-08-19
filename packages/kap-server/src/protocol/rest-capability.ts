import { z } from 'zod';

export const capabilityStepSchema = z.object({
  id: z.string(),
  state: z.enum(['ok', 'missing', 'failed']),
  detail: z.string().optional(),
  optional: z.boolean().optional(),
});
export type CapabilityStepWire = z.infer<typeof capabilityStepSchema>;

export const capabilityInstallProgressSchema = z.object({
  running: z.boolean(),
  step: z.string().optional(),
  percent: z.number().min(0).max(100).optional(),
  error: z.string().optional(),
  note: z.string().optional(),
});
export type CapabilityInstallProgressWire = z.infer<typeof capabilityInstallProgressSchema>;

export const capabilityStatusSchema = z.object({
  id: z.string(),
  pluginId: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  supported: z.boolean(),
  state: z.enum(['not_installed', 'partial', 'ready', 'unsupported']),
  version: z.string().optional(),
  steps: z.array(capabilityStepSchema),
  install: capabilityInstallProgressSchema,
});
export type CapabilityStatusWire = z.infer<typeof capabilityStatusSchema>;

export const listCapabilitiesResponseSchema = z.object({
  capabilities: z.array(capabilityStatusSchema),
});
export type ListCapabilitiesResponse = z.infer<typeof listCapabilitiesResponseSchema>;

export const capabilityIdParamSchema = z.object({
  capability_id: z.string().min(1),
});
export type CapabilityIdParam = z.infer<typeof capabilityIdParamSchema>;
