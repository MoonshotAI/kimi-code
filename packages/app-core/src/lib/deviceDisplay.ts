import type { AppDevice, AppDeviceConnectFailure, AppDeviceInstall } from '../api/types';
import type { RcDevice } from './rcDevicesApi';

export type DeviceDisplayState =
  | 'local'
  | 'missing'
  | 'disabled'
  | 'ready'
  | 'connecting'
  | 'idle'
  | 'offline'
  | 'outdated'
  | 'signedOut'
  | 'duplicate'
  | 'self'
  | 'failed';

export type DeviceInstall = AppDeviceInstall;

export const LONG_OFFLINE_DAYS = 7;

const RETRYABLE_FAILURES: ReadonlySet<AppDeviceConnectFailure> = new Set([
  'connection_refused',
  'host_unreachable',
  'connect_timeout',
  'remote_busy',
  'remote_start_failed',
  'relay_unavailable',
  'unknown',
]);

const FAILURE_STATES: Partial<Record<AppDeviceConnectFailure, DeviceDisplayState>> = {
  offline: 'offline',
  outdated: 'outdated',
  signed_out: 'signedOut',
  duplicate: 'duplicate',
  self: 'self',
};

const USABLE_STATES: ReadonlySet<DeviceDisplayState> = new Set(['local', 'ready', 'connecting', 'idle']);

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

const INSTALL_PREFIXES: ReadonlyArray<readonly [string, DeviceInstall]> = [
  ['kimi-code-desktop/', 'desktop'],
  ['kimi-code-cli/', 'cli'],
  ['kimi-code/', 'cli'],
];

export function isRetryableDeviceFailure(failure: AppDeviceConnectFailure | undefined): boolean {
  return failure === undefined || RETRYABLE_FAILURES.has(failure);
}

export function deviceDisplayState(
  deviceId: string | undefined,
  device: AppDevice | undefined,
  options: { loaded: boolean; connecting?: boolean; settledFailure?: AppDeviceConnectFailure },
): DeviceDisplayState {
  if (deviceId === undefined) return 'local';
  if (device === undefined) return options.loaded ? 'missing' : 'idle';
  if (device.enabled === false) return 'disabled';
  if (device.status === 'ready') return 'ready';
  if (options.connecting === true) return 'connecting';
  if (device.status === 'connecting') return options.settledFailure === 'offline' ? 'offline' : 'connecting';
  if (device.status !== 'disconnected') return 'idle';
  const failureState = device.connectFailure === undefined ? undefined : FAILURE_STATES[device.connectFailure];
  if (failureState !== undefined) return failureState;
  return device.connectError === undefined ? 'idle' : 'failed';
}

export function isDeviceBlocked(state: DeviceDisplayState): boolean {
  return !USABLE_STATES.has(state);
}

export function deviceDisplayName(device: Pick<AppDevice, 'id' | 'name' | 'alias'>): string {
  return device.name ?? device.alias ?? device.id;
}

export function devicePlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function deviceInstall(clientVersion: string): { install: DeviceInstall; version: string } | undefined {
  for (const [prefix, install] of INSTALL_PREFIXES) {
    if (clientVersion.startsWith(prefix)) return { install, version: clientVersion.slice(prefix.length) };
  }
  return undefined;
}

export function isLongOffline(registration: Pick<RcDevice, 'status' | 'updated_at'>, now: number): boolean {
  if (registration.status === 'online') return false;
  const seenAt = Date.parse(registration.updated_at);
  return Number.isFinite(seenAt) && now - seenAt > LONG_OFFLINE_DAYS * 24 * 60 * 60 * 1000;
}
