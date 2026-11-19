import { shell, systemPreferences } from 'electron';
import type { BrowserSitePermission } from '../../shared/browser-sites';

const MEDIA_ACCESS_KINDS = { camera: 'camera', microphone: 'microphone' } as const;

const SETTINGS_URLS: Partial<Record<string, Partial<Record<BrowserSitePermission, string>>>> = {
  darwin: {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  },
  win32: {
    camera: 'ms-settings:privacy-webcam',
    microphone: 'ms-settings:privacy-microphone',
  },
};

export function getBrowserSystemPermissionDenials(): BrowserSitePermission[] {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return [];
  const denials: BrowserSitePermission[] = [];
  for (const [permission, mediaType] of Object.entries(MEDIA_ACCESS_KINDS) as Array<[BrowserSitePermission, 'camera' | 'microphone']>) {
    const status = systemPreferences.getMediaAccessStatus(mediaType);
    if (status === 'denied' || status === 'restricted') denials.push(permission);
  }
  return denials;
}

export async function openBrowserSystemPermissionSettings(permission: BrowserSitePermission): Promise<void> {
  const url = SETTINGS_URLS[process.platform]?.[permission];
  if (url === undefined) throw new Error(`No system settings page for "${permission}" on ${process.platform}`);
  await shell.openExternal(url);
}
