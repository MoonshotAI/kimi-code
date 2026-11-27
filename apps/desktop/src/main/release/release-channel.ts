
import { DESKTOP_WINDOWS_APP_ID, DESKTOP_WINDOWS_DEV_APP_ID } from '../../shared/identity';

export function windowsAppId(isPackaged: boolean, version: string): string {
  if (!isPackaged) return DESKTOP_WINDOWS_DEV_APP_ID;
  if (isCanaryVersion(version)) return `${DESKTOP_WINDOWS_APP_ID}.canary`;
  return isPreviewVersion(version) ? `${DESKTOP_WINDOWS_APP_ID}.preview` : DESKTOP_WINDOWS_APP_ID;
}

export function isCanaryVersion(version: string): boolean {
  return version.includes('-canary.');
}

export function isPreviewVersion(version: string): boolean {
  return version.includes('-preview.');
}

export type ReleaseChannelName = 'stable' | 'canary' | 'preview' | 'dev';

export function releaseChannelName(version: string, isPackaged: boolean): ReleaseChannelName {
  if (!isPackaged) return 'dev';
  if (isCanaryVersion(version)) return 'canary';
  if (isPreviewVersion(version)) return 'preview';
  return 'stable';
}

export function isDevCanaryOverride(isPackaged: boolean): boolean {
  return !isPackaged && process.env['KIMI_DESKTOP_CANARY'] === 'true';
}

export function isCanaryDisplay(version: string, isPackaged: boolean): boolean {
  return isCanaryVersion(version) || isDevCanaryOverride(isPackaged);
}

export function isCanaryChannelEnabled(version: string, isPackaged: boolean): boolean {
  return !isPackaged || isCanaryVersion(version);
}

export function isScreenshotShortcutEnabled(version: string): boolean {
  return !isCanaryVersion(version) && !isPreviewVersion(version);
}
