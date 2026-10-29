import { z } from 'zod';

import { actorSchema } from './actor';
import { deviceCapabilitiesSchema, deviceEnvironmentSchema } from '../devices/protocol';

export const deviceRootSchema = z.object({
  root: z.string().min(1),
  display_name: z.string().min(1).optional(),
  registered_by: actorSchema,
  registered_at: z.string().min(1),
  connection_id: z.string().min(1),
  generation: z.string().min(1),
});

export const deviceSchema = z.object({
  device_id: z.string().min(1),
  display_name: z.string().min(1),
  runtime_id: z.string().min(1),
  online: z.boolean(),
  connection_id: z.string().optional(),
  generation: z.string().optional(),
  protocol_version: z.number().int().positive(),
  environment: deviceEnvironmentSchema,
  capabilities: deviceCapabilitiesSchema,
  roots: z.array(deviceRootSchema),
  connected_by: actorSchema.optional(),
  last_seen_at: z.string().min(1),
});

export const listDevicesResponseSchema = z.object({
  items: z.array(deviceSchema),
});

export const runtimeCatalogItemSchema = z.object({
  runtime_id: z.string().min(1),
  kind: z.enum(['local', 'desktop']),
  device_id: z.string().optional(),
  display_name: z.string().min(1),
  online: z.boolean(),
  capabilities: z.object({
    fs: z.boolean(),
    process: z.boolean(),
    terminal: z.boolean(),
  }),
});

export const listRuntimesResponseSchema = z.object({
  items: z.array(runtimeCatalogItemSchema),
});

export const deviceChangedEventSchema = z.object({
  type: z.literal('event.device.updated'),
  device: deviceSchema,
});

export type Device = z.infer<typeof deviceSchema>;
export type DeviceChangedEvent = z.infer<typeof deviceChangedEventSchema>;
