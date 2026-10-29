import { z } from 'zod';

export const DEVICE_BRIDGE_PROTOCOL_VERSION = 1;
export const DEVICE_BRIDGE_PATH = '/api/v1/devices/bridge';
export const DEVICE_BRIDGE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const DEVICE_BRIDGE_MAX_BINARY_BYTES = 10 * 1024 * 1024;
export const DEVICE_BRIDGE_MAX_PENDING_PER_DEVICE = 32;
export const DEVICE_BRIDGE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const deviceConnectionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const deviceGenerationSchema = z.string().regex(/^g_[1-9][0-9]*$/);
export const bridgeRequestIdSchema = z.string().min(1).max(128);

export const deviceEnvironmentSchema = z.object({
  os_kind: z.string().min(1).max(100),
  os_arch: z.string().min(1).max(100),
  os_version: z.string().max(200),
  shell_name: z.enum(['bash', 'sh']),
  shell_path: z.string().max(4096),
  path_class: z.enum(['posix', 'win32']),
  home_dir: z.string().min(1).max(4096),
});

export const deviceCapabilitiesSchema = z.object({
  fs: z.literal(true),
  process: z.literal(false),
  terminal: z.literal(false),
});

export const deviceHelloSchema = z.object({
  type: z.literal('device.hello'),
  protocol_version: z.literal(DEVICE_BRIDGE_PROTOCOL_VERSION),
  device_id: deviceIdSchema,
  display_name: z.string().trim().min(1).max(100),
  connection_id: deviceConnectionIdSchema,
  environment: deviceEnvironmentSchema,
  capabilities: deviceCapabilitiesSchema,
});

export const deviceRootRegistrationSchema = z.object({
  path: z.string().min(1).max(4096),
  display_name: z.string().trim().min(1).max(200).optional(),
});

export const deviceCommandSchema = z.object({
  type: z.literal('device.command'),
  request_id: bridgeRequestIdSchema,
  command: z.literal('root.register'),
  root: deviceRootRegistrationSchema,
});

export const bridgeErrorSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(4000),
  retryable: z.boolean().optional(),
  uncertain: z.boolean().optional(),
});

const bridgeIdentitySchema = z.object({
  protocol_version: z.number().int().positive(),
  device_id: deviceIdSchema,
  connection_id: deviceConnectionIdSchema,
  generation: deviceGenerationSchema,
  request_id: bridgeRequestIdSchema,
});

export const runtimeResultSchema = bridgeIdentitySchema.extend({
  type: z.literal('runtime.result'),
  result: z.unknown(),
});

export const runtimeErrorSchema = bridgeIdentitySchema.extend({
  type: z.literal('runtime.error'),
  error: bridgeErrorSchema,
});

export const devicePongSchema = z.object({ type: z.literal('device.pong') });

export const deviceClientFrameSchema = z.discriminatedUnion('type', [
  deviceHelloSchema,
  deviceCommandSchema,
  runtimeResultSchema,
  runtimeErrorSchema,
  devicePongSchema,
]);

export type DeviceEnvironment = z.infer<typeof deviceEnvironmentSchema>;
export type DeviceCapabilities = z.infer<typeof deviceCapabilitiesSchema>;
export type DeviceHello = z.infer<typeof deviceHelloSchema>;
export type DeviceCommand = z.infer<typeof deviceCommandSchema>;
export type RuntimeResult = z.infer<typeof runtimeResultSchema>;
export type RuntimeErrorFrame = z.infer<typeof runtimeErrorSchema>;
export type DeviceClientFrame = z.infer<typeof deviceClientFrameSchema>;
export type BridgeErrorPayload = z.infer<typeof bridgeErrorSchema>;

export interface DeviceWelcome {
  readonly type: 'device.welcome';
  readonly protocol_version: typeof DEVICE_BRIDGE_PROTOCOL_VERSION;
  readonly device_id: string;
  readonly connection_id: string;
  readonly generation: string;
  readonly limits: {
    readonly max_payload_bytes: number;
    readonly max_binary_bytes: number;
    readonly max_pending_requests: number;
  };
}

export interface DeviceResult {
  readonly type: 'device.result';
  readonly request_id: string;
  readonly result: unknown;
}

export interface DeviceError {
  readonly type: 'device.error';
  readonly request_id?: string;
  readonly error: BridgeErrorPayload;
}

export interface RuntimeRpc {
  readonly type: 'runtime.rpc';
  readonly protocol_version: typeof DEVICE_BRIDGE_PROTOCOL_VERSION;
  readonly device_id: string;
  readonly connection_id: string;
  readonly generation: string;
  readonly request_id: string;
  readonly method: string;
  readonly params: unknown;
  readonly timeout_ms: number;
}

export interface DevicePing {
  readonly type: 'device.ping';
}

export const deviceWelcomeSchema = z.object({
  type: z.literal('device.welcome'),
  protocol_version: z.literal(DEVICE_BRIDGE_PROTOCOL_VERSION),
  device_id: deviceIdSchema,
  connection_id: deviceConnectionIdSchema,
  generation: deviceGenerationSchema,
  limits: z.object({
    max_payload_bytes: z.number().int().positive(),
    max_binary_bytes: z.number().int().positive(),
    max_pending_requests: z.number().int().positive(),
  }),
});

export const deviceResultSchema = z.object({
  type: z.literal('device.result'),
  request_id: bridgeRequestIdSchema,
  result: z.unknown(),
});

export const deviceErrorSchema = z.object({
  type: z.literal('device.error'),
  request_id: bridgeRequestIdSchema.optional(),
  error: bridgeErrorSchema,
});

export const runtimeRpcSchema = bridgeIdentitySchema.extend({
  type: z.literal('runtime.rpc'),
  protocol_version: z.literal(DEVICE_BRIDGE_PROTOCOL_VERSION),
  method: z.string().min(1),
  params: z.unknown(),
  timeout_ms: z.number().int().positive(),
});

export const devicePingSchema = z.object({ type: z.literal('device.ping') });

export const deviceServerFrameSchema = z.discriminatedUnion('type', [
  deviceWelcomeSchema,
  deviceResultSchema,
  deviceErrorSchema,
  runtimeRpcSchema,
  devicePingSchema,
]);

export type DeviceServerFrame = DeviceWelcome | DeviceResult | DeviceError | RuntimeRpc | DevicePing;

export const remoteRuntimeMethods = [
  'device.inspect_root',
  'fs.read_text',
  'fs.write_text',
  'fs.append_text',
  'fs.read_bytes',
  'fs.write_bytes',
  'fs.create_exclusive',
  'fs.stat',
  'fs.lstat',
  'fs.readdir',
  'fs.mkdir',
  'fs.remove',
  'fs.rename',
  'fs.realpath',
] as const;

export type RemoteRuntimeMethod = (typeof remoteRuntimeMethods)[number];

export function runtimeIdForDevice(deviceId: string): string {
  return `desktop:${deviceId}`;
}

export function deviceIdFromRuntime(runtimeId: string): string | undefined {
  if (!runtimeId.startsWith('desktop:')) return undefined;
  const deviceId = runtimeId.slice('desktop:'.length);
  const parsed = deviceIdSchema.safeParse(deviceId);
  return parsed.success ? parsed.data : undefined;
}
