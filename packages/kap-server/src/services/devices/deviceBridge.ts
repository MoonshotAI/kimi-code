import { metaResponseSchema } from '../../protocol/rest-meta';
import { deviceGet, DeviceSourceError } from './deviceFanout';
import { DEVICE_API_LEVEL } from './deviceProtocol';
import type { DeviceSession } from './deviceSession';

export type DeviceStatus = 'pending' | 'connecting' | 'ready' | 'disconnected';

export type DeviceConnectFailure =
  | 'host_not_found'
  | 'connection_refused'
  | 'host_unreachable'
  | 'connect_timeout'
  | 'authentication_failed'
  | 'host_key_changed'
  | 'executor_not_found'
  | 'outdated'
  | 'remote_busy'
  | 'remote_start_failed'
  | 'offline'
  | 'signed_out'
  | 'relay_unavailable'
  | 'duplicate'
  | 'self'
  | 'unknown';

export class DeviceConnectError extends Error {
  constructor(
    readonly failure: DeviceConnectFailure,
    message: string,
    readonly remoteVersion?: string,
  ) {
    super(message);
    this.name = 'DeviceConnectError';
  }
}

export interface RemoteDeviceIdentity {
  readonly deviceId: string;
  readonly productName?: string;
}

export interface DeviceBridge {
  readonly status: DeviceStatus;
  readonly failure: DeviceConnectFailure | undefined;
  readonly error: string | undefined;
  readonly remoteVersion: string | undefined;
  readonly session: DeviceSession | undefined;
  readonly identity: RemoteDeviceIdentity | undefined;
  connect(): Promise<DeviceSession>;
  start(): void;
  dispose(): void;
}

export interface RemoteDeviceMeta {
  readonly identity?: RemoteDeviceIdentity;
  readonly serverVersion?: string;
}

const remoteMetaSchema = metaResponseSchema
  .pick({ server_version: true, product: true, device_id: true, device_api_level: true })
  .partial();

export async function readRemoteMeta(session: DeviceSession): Promise<RemoteDeviceMeta> {
  const parsed = remoteMetaSchema.safeParse(await deviceGet<unknown>(session, '/api/v1/meta'));
  if (!parsed.success) throw new DeviceSourceError(undefined, 'device returned unexpected server metadata');
  const meta = parsed.data;
  if (meta.device_id === undefined || meta.device_api_level === undefined || meta.device_api_level < DEVICE_API_LEVEL) {
    return { serverVersion: meta.server_version };
  }
  return {
    identity: { deviceId: meta.device_id, productName: meta.product },
    serverVersion: meta.server_version,
  };
}
