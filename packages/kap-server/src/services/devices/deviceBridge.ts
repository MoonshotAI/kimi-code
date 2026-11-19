import { z } from 'zod';

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

export type DeviceInstall = 'desktop' | 'cli';

export interface DeviceUpgradeState {
  readonly status: 'installing' | 'restarting' | 'failed';
  readonly error?: string;
}

export interface DeviceUpgradeResult {
  readonly status: 'started' | 'update_on_device' | 'unsupported';
  readonly message?: string;
}

export class DeviceUpgradeInProgressError extends Error {
  constructor() {
    super('an upgrade is already in progress on this device');
    this.name = 'DeviceUpgradeInProgressError';
  }
}

export function isUpgrading(state: DeviceUpgradeState | undefined): boolean {
  return state?.status === 'installing' || state?.status === 'restarting';
}

export const DEFAULT_UPGRADE_TIMEOUT_MS = 15 * 60_000;

function formatDuration(ms: number): string {
  const [count, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

export function upgradeTimeoutError(timeoutMs: number): string {
  return `the device did not come back on a new Kimi Code version within ${formatDuration(timeoutMs)}; check Kimi Code on that device`;
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
  readonly upgradeState: DeviceUpgradeState | undefined;
  connect(): Promise<DeviceSession>;
  upgrade(): Promise<DeviceUpgradeResult>;
  start(): void;
  dispose(): void;
}

export abstract class DeviceBridgeState {
  protected statusValue: DeviceStatus = 'pending';
  protected failureValue: DeviceConnectFailure | undefined;
  protected errorValue: string | undefined;
  protected remoteVersionValue: string | undefined;
  protected upgradeValue: DeviceUpgradeState | undefined;
  protected disposed = false;

  get status(): DeviceStatus {
    return this.statusValue;
  }

  get failure(): DeviceConnectFailure | undefined {
    return this.failureValue;
  }

  get error(): string | undefined {
    return this.errorValue;
  }

  get remoteVersion(): string | undefined {
    return this.remoteVersionValue;
  }

  get upgradeState(): DeviceUpgradeState | undefined {
    return this.upgradeValue;
  }

  protected rejectDisposed(): Promise<never> {
    return Promise.reject(new DeviceConnectError('unknown', 'device bridge disposed'));
  }
}

export interface RemoteDeviceMeta {
  readonly identity?: RemoteDeviceIdentity;
  readonly serverVersion?: string;
  readonly systemUpgrade: boolean;
}

const remoteMetaSchema = metaResponseSchema
  .pick({ server_version: true, product: true, device_id: true, device_api_level: true })
  .partial()
  .extend({ capabilities: z.object({ system_upgrade: z.boolean().optional() }).optional() });

export async function readRemoteMeta(session: DeviceSession): Promise<RemoteDeviceMeta> {
  const parsed = remoteMetaSchema.safeParse(await deviceGet<unknown>(session, '/api/v1/meta'));
  if (!parsed.success) throw new DeviceSourceError(undefined, 'device returned unexpected server metadata');
  const meta = parsed.data;
  const systemUpgrade = meta.capabilities?.system_upgrade === true;
  if (meta.device_id === undefined || meta.device_api_level === undefined || meta.device_api_level < DEVICE_API_LEVEL) {
    return { serverVersion: meta.server_version, systemUpgrade };
  }
  return {
    identity: { deviceId: meta.device_id, productName: meta.product },
    serverVersion: meta.server_version,
    systemUpgrade,
  };
}
