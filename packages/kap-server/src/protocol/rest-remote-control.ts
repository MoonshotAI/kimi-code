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
