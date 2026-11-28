import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { desktopCapturer, shell, systemPreferences } from 'electron';
import {
  actionForMediaStatus,
  isComputerUseSystemPermissionId,
  notificationPermissionStatus,
  type SystemPermissionId,
  type SystemPermissionItem,
  type SystemPermissionsQuery,
  type SystemPermissionsSnapshot,
} from '@moonshot-ai/app-core/system-permissions';
import { getLocalNetworkPermissionProbed, setLocalNetworkPermissionProbed } from '../app/ui-state';
import { log } from '../diagnostics/log';
import { isLocalNetworkProbeAvailable, probeLocalNetworkPermission, triggerLocalNetworkPrompt } from './local-network';

const execFileAsync = promisify(execFile);

const SETTINGS_URLS: Record<string, string> = {
  'local-network': 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  'files-and-folders': 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
};

const KIMI_CU_BIN = join('/Applications', 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
const CU_PROBE_TIMEOUT_MS = 3_000;
const CU_REQUEST_TIMEOUT_MS = 15_000;
const LOCAL_NETWORK_REQUEST_PROBE_TIMEOUT_MS = 8_000;

interface ComputerUsePermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export function parseComputerUsePermissions(output: string): ComputerUsePermissions | null {
  const match = /(?:permissions|permissionStatus):\s*accessibility=(true|false)\s+screenRecording=(true|false)/.exec(output);
  if (match === null) return null;
  return { accessibility: match[1] === 'true', screenRecording: match[2] === 'true' };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readComputerUsePermissions(): Promise<ComputerUsePermissions | null> {
  if (!(await fileExists(KIMI_CU_BIN))) return null;
  try {
    const { stdout } = await execFileAsync(KIMI_CU_BIN, ['xpc-ping'], { timeout: CU_PROBE_TIMEOUT_MS });
    return parseComputerUsePermissions(stdout);
  } catch (error) {
    log.warn(`[permissions] kimi-cu xpc-ping failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function requestComputerUsePermissions(): Promise<void> {
  if (!(await fileExists(KIMI_CU_BIN))) return;
  try {
    await execFileAsync(KIMI_CU_BIN, ['request-permissions', '--ax', '--screen'], { timeout: CU_REQUEST_TIMEOUT_MS });
  } catch (error) {
    log.warn(`[permissions] kimi-cu request-permissions ended: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let localNetworkProbeArmed = false;

function rememberLocalNetworkDecision(status: 'granted' | 'denied' | 'unavailable'): void {
  if (status !== 'unavailable' && !getLocalNetworkPermissionProbed()) {
    setLocalNetworkPermissionProbed(true);
  }
}

async function readLocalNetworkItem(): Promise<SystemPermissionItem> {
  if (!isLocalNetworkProbeAvailable()) {
    return { id: 'local-network', status: 'unavailable', action: null, requiresRestart: false };
  }
  if (!localNetworkProbeArmed && !getLocalNetworkPermissionProbed()) {
    return { id: 'local-network', status: 'not-determined', action: 'request', requiresRestart: false };
  }
  const status = await probeLocalNetworkPermission();
  rememberLocalNetworkDecision(status);
  return {
    id: 'local-network',
    status,
    action: status === 'denied' ? 'open-settings' : null,
    requiresRestart: false,
  };
}

function mediaItem(id: 'screen-recording' | 'microphone' | 'camera', mediaType: 'screen' | 'microphone' | 'camera'): SystemPermissionItem {
  const rawStatus = systemPreferences.getMediaAccessStatus(mediaType);
  const status = rawStatus === 'unknown' ? 'unavailable' : rawStatus;
  return {
    id,
    status,
    action: actionForMediaStatus(rawStatus),
    requiresRestart: id === 'screen-recording' && status !== 'granted' && status !== 'unavailable',
  };
}

function computerUseItem(id: 'cu-accessibility' | 'cu-screen-recording', permissions: ComputerUsePermissions | null): SystemPermissionItem {
  if (permissions === null) {
    return { id, status: 'unavailable', action: 'request', requiresRestart: false };
  }
  const granted = id === 'cu-accessibility' ? permissions.accessibility : permissions.screenRecording;
  return { id, status: granted ? 'granted' : 'not-determined', action: granted ? null : 'request', requiresRestart: false };
}

export async function getSystemPermissions(query: SystemPermissionsQuery): Promise<SystemPermissionsSnapshot> {
  if (process.platform !== 'darwin') {
    return { platform: process.platform, computerUseInstalled: false, items: [] };
  }
  const notificationStatus = notificationPermissionStatus(query.notificationPermission);
  const [localNetwork, cuPermissions] = await Promise.all([
    readLocalNetworkItem(),
    query.computerUseInstalled ? readComputerUsePermissions() : Promise.resolve(null),
  ]);
  const items: SystemPermissionItem[] = [
    localNetwork,
    mediaItem('screen-recording', 'screen'),
    mediaItem('microphone', 'microphone'),
    mediaItem('camera', 'camera'),
    {
      id: 'notifications',
      status: notificationStatus,
      action: notificationStatus === 'granted' ? null : notificationStatus === 'not-determined' ? 'request' : 'open-settings',
      requiresRestart: false,
    },
    { id: 'files-and-folders', status: 'on-demand', action: 'open-settings', requiresRestart: false },
  ];
  if (query.computerUseInstalled) {
    items.push(
      computerUseItem('cu-accessibility', cuPermissions),
      computerUseItem('cu-screen-recording', cuPermissions),
    );
  }
  return { platform: process.platform, computerUseInstalled: query.computerUseInstalled, items };
}

export async function requestSystemPermission(id: SystemPermissionId, query: SystemPermissionsQuery): Promise<SystemPermissionsSnapshot> {
  if (process.platform !== 'darwin') return getSystemPermissions(query);
  if (isComputerUseSystemPermissionId(id)) {
    await requestComputerUsePermissions();
  } else if (id === 'local-network') {
    localNetworkProbeArmed = true;
    await triggerLocalNetworkPrompt();
    const status = await probeLocalNetworkPermission(LOCAL_NETWORK_REQUEST_PROBE_TIMEOUT_MS);
    rememberLocalNetworkDecision(status);
  } else if (id === 'screen-recording') {
    if (systemPreferences.getMediaAccessStatus('screen') === 'not-determined') {
      try {
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } });
      } catch (error) {
        log.warn(`[permissions] screen recording request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (id === 'microphone' || id === 'camera') {
    if (systemPreferences.getMediaAccessStatus(id) === 'not-determined') {
      try {
        await systemPreferences.askForMediaAccess(id);
      } catch (error) {
        log.warn(`[permissions] ${id} request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (id === 'notifications') {
    return getSystemPermissions(query);
  } else if (id === 'files-and-folders') {
    return openSystemPermissionSettings(id, query);
  }
  return getSystemPermissions(query);
}

export async function openSystemPermissionSettings(id: SystemPermissionId, query: SystemPermissionsQuery): Promise<SystemPermissionsSnapshot> {
  if (process.platform !== 'darwin') return getSystemPermissions(query);
  if (isComputerUseSystemPermissionId(id)) {
    await requestComputerUsePermissions();
    return getSystemPermissions(query);
  }
  const url = SETTINGS_URLS[id];
  if (url !== undefined) {
    await shell.openExternal(url);
  }
  return getSystemPermissions(query);
}
