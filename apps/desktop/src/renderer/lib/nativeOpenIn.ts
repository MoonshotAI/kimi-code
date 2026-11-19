
import { isLinuxDesktop, isMacosDesktop, isWindowsDesktop } from '@moonshot-ai/app-core/lib';
import { track } from './track';

import iconVscode from '../assets/app-icons/vscode.png';
import iconVscodeInsiders from '../assets/app-icons/vscode-insiders.png';
import iconCursor from '../assets/app-icons/cursor.png';
import iconZed from '../assets/app-icons/zed.png';
import iconFinder from '../assets/app-icons/finder.png';
import iconTerminal from '../assets/app-icons/terminal.png';
import iconIterm from '../assets/app-icons/iterm2.png';
import iconGhostty from '../assets/app-icons/ghostty.png';
import iconWarp from '../assets/app-icons/warp.png';
import iconKitty from '../assets/app-icons/kitty.png';
import iconXcode from '../assets/app-icons/xcode.png';
import iconExplorer from '../assets/app-icons/explorer.png';
import iconWindowsTerminal from '../assets/app-icons/windows-terminal.png';
import iconGitBash from '../assets/app-icons/git-bash.png';
import iconSafari from '../assets/app-icons/safari.png';
import iconChrome from '../assets/app-icons/chrome.png';
import iconArc from '../assets/app-icons/arc.png';
import iconEdge from '../assets/app-icons/edge.png';
import iconFirefox from '../assets/app-icons/firefox.png';
import iconBrave from '../assets/app-icons/brave.png';
import iconPreview from '../assets/app-icons/preview.png';

const APP_ICONS: Record<string, string> = {
  vscode: iconVscode,
  'vscode-insiders': iconVscodeInsiders,
  cursor: iconCursor,
  zed: iconZed,
  finder: iconFinder,
  terminal: iconTerminal,
  iterm: iconIterm,
  ghostty: iconGhostty,
  warp: iconWarp,
  kitty: iconKitty,
  xcode: iconXcode,
  explorer: iconExplorer,
  'windows-terminal': iconWindowsTerminal,
  'git-bash': iconGitBash,
  safari: iconSafari,
  chrome: iconChrome,
  arc: iconArc,
  edge: iconEdge,
  firefox: iconFirefox,
  brave: iconBrave,
  preview: iconPreview,
};

export function openInAppIcon(appId: string): string {
  return APP_ICONS[appId] ?? '';
}

export interface OpenInAppOption {
  id: string;
  label: string;
  preferred?: boolean;
}

interface DesktopOpenInBridge {
  listOpenInApps?: (filePath?: string) => Promise<OpenInAppOption[]>;
  openInApp?: (appId: string, path: string) => Promise<{ ok: boolean; error?: string }>;
}

function bridge(): DesktopOpenInBridge | undefined {
  return (window as { kimiDesktop?: DesktopOpenInBridge }).kimiDesktop;
}

export function canOpenInNative(): boolean {
  const b = bridge();
  return typeof b?.listOpenInApps === 'function' && typeof b?.openInApp === 'function';
}

export async function listNativeOpenInApps(filePath?: string): Promise<OpenInAppOption[]> {
  if (!canOpenInNative()) return [];
  try {
    const apps = await bridge()!.listOpenInApps!(filePath);
    return Array.isArray(apps)
      ? apps.filter((a) => typeof a?.id === 'string' && typeof a?.label === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function openInNativeApp(appId: string, path: string): Promise<boolean> {
  if (!canOpenInNative()) return false;
  try {
    const result = await bridge()!.openInApp!(appId, path);
    if (result.ok !== true) return false;
    track('native_feature_used', { feature: 'open_in' });
    return true;
  } catch {
    return false;
  }
}

export type DirectoryOpenAppId = 'finder' | 'explorer' | 'file-manager';

export function directoryOpenAppId(platform: string): DirectoryOpenAppId | null {
  if (platform === 'darwin') return 'finder';
  if (platform === 'win32') return 'explorer';
  if (platform === 'linux') return 'file-manager';
  return null;
}

function currentDirectoryOpenAppId(): DirectoryOpenAppId | null {
  if (isMacosDesktop) return 'finder';
  if (isWindowsDesktop) return 'explorer';
  if (isLinuxDesktop) return 'file-manager';
  return null;
}

export function canOpenDirectoryInNative(): boolean {
  return currentDirectoryOpenAppId() !== null && canOpenInNative();
}

export async function openDirectoryInNative(path: string): Promise<boolean> {
  const appId = currentDirectoryOpenAppId();
  return appId === null ? false : openInNativeApp(appId, path);
}

const TEXT_EDITOR_IDS = ['vscode', 'vscode-insiders', 'cursor', 'zed', 'xcode', 'typora'] as const;

export async function openTextFileInNative(path: string): Promise<boolean> {
  if (!canOpenInNative()) return false;
  const installed = new Set((await listNativeOpenInApps()).map((app) => app.id));
  const appId = TEXT_EDITOR_IDS.find((id) => installed.has(id));
  return appId === undefined ? false : openInNativeApp(appId, path);
}
