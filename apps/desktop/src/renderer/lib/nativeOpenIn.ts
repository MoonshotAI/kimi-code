// apps/desktop/src/renderer/lib/nativeOpenIn.ts
// Desktop-only "open this workspace in <editor/terminal>", backed by the
// main-process catalog + launcher (src/main/open-in.ts, exposed as
// `window.kimiDesktop.listOpenInApps` / `openInApp` by the desktop preload).
// The whole flow stays in the main process — no daemon REST involved. When
// the bridge is missing (not desktop) callers hide the entry entirely; this
// is a desktop-only feature by design (see docs/native-todos.md).

import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from './storage';
import { track } from './track';
import { ref, type Ref } from 'vue';

// Colored app icons, extracted from the apps' own .icns bundles (the
// "open in <app>" menu is nominative use of the trademarks). PNG URLs are
// bundled by Vite; keyed by the main-process app id (src/main/open-in.ts).
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

/** The user's settings choice of default app id; null means "auto". */
export function loadDefaultOpenInTarget(): string | null {
  const value = safeGetString(STORAGE_KEYS.openInDefaultTarget);
  return value !== null && value !== '' ? value : null;
}

// Module-level reactive mirror of the persisted default, so every consumer
// (header pill, settings dialog) sees a settings change in the same tick —
// localStorage alone is not reactive.
const defaultTarget: Ref<string | null> = ref(loadDefaultOpenInTarget());

/** Shared reactive default-target (settings choice; null = auto). */
export function useDefaultOpenInTarget(): Ref<string | null> {
  return defaultTarget;
}

/** Persists the settings choice; '' clears it back to "auto". */
export function saveDefaultOpenInTarget(appId: string): void {
  if (appId === '') {
    safeRemove(STORAGE_KEYS.openInDefaultTarget);
  } else {
    safeSetString(STORAGE_KEYS.openInDefaultTarget, appId);
  }
  defaultTarget.value = appId === '' ? null : appId;
}

/**
 * Pure selected-target resolution: the chosen app when still installed,
 * otherwise the first available one. Single source of truth — a menu pick in
 * the header and the settings dropdown write the same storage key.
 */
export function resolveOpenInTarget(availableIds: string[], selectedId: string | null): string | null {
  if (selectedId !== null && availableIds.includes(selectedId)) return selectedId;
  return availableIds[0] ?? null;
}
