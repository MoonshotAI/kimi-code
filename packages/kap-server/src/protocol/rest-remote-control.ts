import { z } from 'zod';

export const remoteControlStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(['off', 'starting', 'on', 'stopping']),
  url: z.string().optional(),
  device_id: z.string().optional(),
  device_name: z.string().optional(),
  error: z.string().optional(),
});
export type RemoteControlStatusResponse = z.infer<typeof remoteControlStatusSchema>;

export const setRemoteControlRequestSchema = z.object({
  enabled: z.boolean(),
});
export type SetRemoteControlRequest = z.infer<typeof setRemoteControlRequestSchema>;

export const remoteControlDeviceSchema = z.object({
  device_id: z.string(),
  alias: z.string(),
  status: z.enum(['online', 'offline']),
  platform: z.string(),
  client_version: z.string(),
  local_base_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_remote_access_at: z.string(),
});
export type RemoteControlDeviceResponse = z.infer<typeof remoteControlDeviceSchema>;

export const remoteControlDeviceListSchema = z.object({
  devices: z.array(remoteControlDeviceSchema),
  max_devices: z.number().optional(),
});
export type RemoteControlDeviceListResponse = z.infer<typeof remoteControlDeviceListSchema>;

export const remoteControlDeviceParamsSchema = z.object({
  id: z.string().min(1),
});
export type RemoteControlDeviceParams = z.infer<typeof remoteControlDeviceParamsSchema>;

export const renameRemoteControlDeviceRequestSchema = z.object({
  alias: z.string().trim().min(1).max(50),
});
export type RenameRemoteControlDeviceRequest = z.infer<
  typeof renameRemoteControlDeviceRequestSchema
>;

export const remoteControlDeviceMutationResponseSchema = z.object({
  ok: z.literal(true),
});
export type RemoteControlDeviceMutationResponse = z.infer<
  typeof remoteControlDeviceMutationResponseSchema
>;
