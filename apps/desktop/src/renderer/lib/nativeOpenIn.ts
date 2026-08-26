// apps/desktop/src/renderer/lib/nativeOpenIn.ts
// Desktop-only "open this workspace in <editor/terminal>", backed by the
// main-process catalog + launcher (src/main/open-in.ts, exposed as
// `window.kimiDesktop.listOpenInApps` / `openInApp` by the desktop preload).
// The whole flow stays in the main process — no daemon REST involved. When
// the bridge is missing (not desktop) callers hide the entry entirely; this
// is a desktop-only feature by design (see docs/native-todos.md).
// Default-target persistence lives in @moonshot-ai/app-components
// (lib/openInTarget.ts, P20); this file keeps only the native bridge.

import { track } from './track';

// Colored app icons, extracted from the apps' own bundles (macOS .icns /
// Windows exe resources; the "open in <app>" menu is nominative use of the
// trademarks). PNG URLs are bundled by Vite; keyed by the main-process app id
// (src/main/open-in.ts).
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
};

/** Bundled PNG URL for an app id; '' for unknown ids (caller renders no img). */
export function openInAppIcon(appId: string): string {
  return APP_ICONS[appId] ?? '';
}

export interface OpenInAppOption {
  id: string;
  label: string;
}

interface DesktopOpenInBridge {
  listOpenInApps?: () => Promise<OpenInAppOption[]>;
  openInApp?: (appId: string, path: string) => Promise<{ ok: boolean; error?: string }>;
}

function bridge(): DesktopOpenInBridge | undefined {
  return (window as { kimiDesktop?: DesktopOpenInBridge }).kimiDesktop;
}

/** True when the preload bridge offers the open-in methods (desktop app). */
export function canOpenInNative(): boolean {
  const b = bridge();
  return typeof b?.listOpenInApps === 'function' && typeof b?.openInApp === 'function';
}

/** Installed apps that can open a directory. Empty when not desktop, not
 *  macOS, or the catalog query fails — all mean "show nothing". */
export async function listNativeOpenInApps(): Promise<OpenInAppOption[]> {
  if (!canOpenInNative()) return [];
  try {
    const apps = await bridge()!.listOpenInApps!();
    return Array.isArray(apps)
      ? apps.filter((a) => typeof a?.id === 'string' && typeof a?.label === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Opens `path` in the given app. Resolves false on any failure (missing
 *  bridge, IPC error, or the main process reporting `ok: false`). */
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
