import { deviceEntrySchema, type DeviceEntry } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

const deviceWireObjectSchema = z
  .object({
    host: deviceEntrySchema.shape.host,
    name: deviceEntrySchema.shape.name,
    enabled: deviceEntrySchema.shape.enabled,
    identity_file: z.string().min(1).optional(),
    remote_bin: z.string().min(1).optional(),
  })
  .strict();

export const deviceWireSchema: z.ZodType<DeviceEntry, z.input<typeof deviceWireObjectSchema>> =
  deviceWireObjectSchema.transform((entry) => ({
    host: entry.host,
    name: entry.name,
    enabled: entry.enabled,
    identityFile: entry.identity_file,
    remoteBin: entry.remote_bin,
  }));
