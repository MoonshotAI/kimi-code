import type { SystemPermissionId, SystemPermissionItem, SystemPermissionStatus } from '@moonshot-ai/app-core/lib';

export const SYSTEM_PERMISSION_COPY: Record<SystemPermissionId, { title: string; hint: string }> = {
  'local-network': {
    title: 'settings.systemPermissions.localNetwork',
    hint: 'settings.systemPermissions.localNetworkHint',
  },
  'screen-recording': {
    title: 'settings.systemPermissions.screenRecording',
    hint: 'settings.systemPermissions.screenRecordingHint',
  },
  microphone: {
    title: 'settings.systemPermissions.microphone',
    hint: 'settings.systemPermissions.microphoneHint',
  },
  camera: {
    title: 'settings.systemPermissions.camera',
    hint: 'settings.systemPermissions.cameraHint',
  },
  notifications: {
    title: 'settings.systemPermissions.notifications',
    hint: 'settings.systemPermissions.notificationsHint',
  },
  'files-and-folders': {
    title: 'settings.systemPermissions.filesAndFolders',
    hint: 'settings.systemPermissions.filesAndFoldersHint',
  },
  'cu-accessibility': {
    title: 'settings.systemPermissions.cuAccessibility',
    hint: 'settings.systemPermissions.cuAccessibilityHint',
  },
  'cu-screen-recording': {
    title: 'settings.systemPermissions.cuScreenRecording',
    hint: 'settings.systemPermissions.cuScreenRecordingHint',
  },
};

export const SYSTEM_PERMISSION_STATUS_COPY: Record<SystemPermissionStatus, { key: string; variant: 'success' | 'neutral' | 'warning' }> = {
  granted: { key: 'settings.systemPermissions.statusGranted', variant: 'success' },
  'not-determined': { key: 'settings.systemPermissions.statusNotDetermined', variant: 'neutral' },
  denied: { key: 'settings.systemPermissions.statusDenied', variant: 'warning' },
  restricted: { key: 'settings.systemPermissions.statusRestricted', variant: 'warning' },
  'on-demand': { key: 'settings.systemPermissions.statusOnDemand', variant: 'neutral' },
  unavailable: { key: 'settings.systemPermissions.statusUnavailable', variant: 'neutral' },
};

export function systemPermissionExtraHintKey(item: SystemPermissionItem): string | null {
  if (item.id === 'screen-recording' && item.requiresRestart) {
    return 'settings.systemPermissions.screenRecordingRestartHint';
  }
  if (item.id === 'notifications' && item.status === 'denied') {
    return 'settings.systemPermissions.notificationsSettingsHint';
  }
  if (item.id === 'local-network' && item.status === 'unavailable') {
    return 'settings.systemPermissions.localNetworkUnavailableHint';
  }
  return null;
}
