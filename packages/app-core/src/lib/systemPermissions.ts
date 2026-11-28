export type SystemPermissionStatus =
  | 'granted'
  | 'not-determined'
  | 'denied'
  | 'restricted'
  | 'on-demand'
  | 'unavailable';

export type HostSystemPermissionId =
  | 'local-network'
  | 'screen-recording'
  | 'microphone'
  | 'camera'
  | 'notifications'
  | 'files-and-folders';

export type ComputerUseSystemPermissionId =
  | 'cu-accessibility'
  | 'cu-screen-recording';

export type SystemPermissionId = HostSystemPermissionId | ComputerUseSystemPermissionId;

export type SystemPermissionAction = 'request' | 'open-settings';

export interface SystemPermissionItem {
  id: SystemPermissionId;
  status: SystemPermissionStatus;
  action: SystemPermissionAction | null;
  requiresRestart: boolean;
}

export interface SystemPermissionsQuery {
  computerUseInstalled: boolean;
  notificationPermission: string;
}

export interface SystemPermissionsSnapshot {
  platform: string;
  computerUseInstalled: boolean;
  items: SystemPermissionItem[];
}

const PERMISSION_IDS = new Set<string>([
  'local-network',
  'screen-recording',
  'microphone',
  'camera',
  'notifications',
  'files-and-folders',
  'cu-accessibility',
  'cu-screen-recording',
]);

const PERMISSION_STATUSES = new Set<string>([
  'granted',
  'not-determined',
  'denied',
  'restricted',
  'on-demand',
  'unavailable',
]);

export function isSystemPermissionId(value: unknown): value is SystemPermissionId {
  return typeof value === 'string' && PERMISSION_IDS.has(value);
}

export function isComputerUseSystemPermissionId(value: SystemPermissionId): value is ComputerUseSystemPermissionId {
  return value === 'cu-accessibility' || value === 'cu-screen-recording';
}

export function asSystemPermissionsQuery(value: unknown): SystemPermissionsQuery {
  if (typeof value !== 'object' || value === null) {
    return { computerUseInstalled: false, notificationPermission: 'default' };
  }
  const raw = value as Record<string, unknown>;
  const permission = raw['notificationPermission'];
  return {
    computerUseInstalled: raw['computerUseInstalled'] === true,
    notificationPermission:
      permission === 'granted' || permission === 'denied' || permission === 'default'
        ? permission
        : 'default',
  };
}

export function notificationPermissionStatus(permission: string): SystemPermissionStatus {
  if (permission === 'granted') return 'granted';
  if (permission === 'denied') return 'denied';
  return 'not-determined';
}

export function actionForMediaStatus(status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'): SystemPermissionAction | null {
  if (status === 'not-determined') return 'request';
  if (status === 'denied') return 'open-settings';
  return null;
}

export function isSystemPermissionsSnapshot(value: unknown): value is SystemPermissionsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw['platform'] !== 'string' || typeof raw['computerUseInstalled'] !== 'boolean') return false;
  if (!Array.isArray(raw['items'])) return false;
  return raw['items'].every((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const entry = item as Record<string, unknown>;
    return (
      isSystemPermissionId(entry['id']) &&
      typeof entry['status'] === 'string' &&
      PERMISSION_STATUSES.has(entry['status']) &&
      (entry['action'] === null || entry['action'] === 'request' || entry['action'] === 'open-settings') &&
      typeof entry['requiresRestart'] === 'boolean'
    );
  });
}
