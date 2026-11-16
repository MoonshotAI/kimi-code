import { hostEntrySchema, type HostEntry } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

const hostWireObjectSchema = z
  .object({
    host: hostEntrySchema.shape.host,
    name: hostEntrySchema.shape.name,
    enabled: hostEntrySchema.shape.enabled,
    identity_file: z.string().min(1).optional(),
    remote_bin: z.string().min(1).optional(),
  })
  .strict();

export const hostWireSchema: z.ZodType<HostEntry, z.input<typeof hostWireObjectSchema>> =
  hostWireObjectSchema.transform((entry) => ({
    host: entry.host,
    name: entry.name,
    enabled: entry.enabled,
    identityFile: entry.identity_file,
    remoteBin: entry.remote_bin,
  }));
