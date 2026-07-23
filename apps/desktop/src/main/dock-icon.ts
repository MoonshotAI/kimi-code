import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { app, nativeImage, nativeTheme, systemPreferences } from 'electron';

import { getMainWindow } from './window';
import { IPC } from './ipc-channels';

// Theme-following Dock icon. macOS has no appearance variants in .icns (the
// packaged bundle icon is static — Finder/Launchpad keep the light tile), but
// app.dock.setIcon works at runtime, so the Dock icon tracks the effective
// appearance while the app runs: light tile (icon.png) in light mode, dark
// tile (icon-dark.png) in dark mode, both generated from the KIMI CODE LOGO
// kit by scripts/build-brand-icons.mjs. Dev needs the explicit setIcon anyway
// (an unpackaged run shows Electron's default Dock icon); packaged builds get
// the same swap for consistency while running.

export interface DockIconEnv {
  isPackaged: boolean;
  /** <resources> in packaged builds (mac-only extraResources carries build/icon*.png). */
  resourcesPath: string;
  /** Repo dir in dev (Electron launched with cwd = apps/desktop). */
  appPath: string;
  /** Effective appearance for the tile (auto resolves via osPrefersDark). */
  isDark: boolean;
}

/** Dock icon file for the given appearance. */
export function dockIconPath(env: DockIconEnv): string {
  return join(env.isPackaged ? env.resourcesPath : env.appPath, 'build', env.isDark ? 'icon-dark.png' : 'icon.png');
}

/** User preference for the Dock tile: fixed light/dark, or 'auto' (follow OS). */
export type DockIconChoice = 'light' | 'dark' | 'auto';

export function isDockIconChoice(value: unknown): value is DockIconChoice {
  return value === 'light' || value === 'dark' || value === 'auto';
}

/** Effective dark-tile flag: 'auto' follows the OS appearance. */
export function resolveDockIconDark(choice: DockIconChoice, systemDark: boolean): boolean {
  return choice === 'dark' || (choice === 'auto' && systemDark);
}

// Renderer-pushed preference (IPC.dockIconChoice); 'auto' until the first
// push arrives (startup seed comes from the renderer's stored setting).
let currentChoice: DockIconChoice = 'auto';

/** Update the preference (settings UI) and re-apply the Dock icon. */
export function setDockIconChoice(choice: DockIconChoice): void {
  currentChoice = choice;
  applyDockIcon();
}

function readGlobalDefault(key: string): string | null {
  try {
    return execFileSync('/usr/bin/defaults', ['read', '-g', key], { encoding: 'utf8' });
  } catch {
    return null; // key absent
  }
}

/** Real OS appearance for the 'auto' choice (independent of the app-level
    appearance override; see docs/native-todos.md). */
export function osAppearance(): 'dark' | 'light' {
  const style = readGlobalDefault('AppleInterfaceStyle');
  if (style !== null) return style.includes('Dark') ? 'dark' : 'light';
  // Explicit mode absent → macOS appearance is Auto: ask a fresh helper
  // process (no override of its own) for its effectiveAppearance.
  try {
    const name = execFileSync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSApplication.sharedApplication.effectiveAppearance.name.js'],
      { encoding: 'utf8' },
    );
    return name.includes('Dark') ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function osPrefersDark(): boolean {
  return osAppearance() === 'dark';
}

function applyDockIcon(): void {
  if (process.platform !== 'darwin') return;
  app.dock?.setIcon(
    nativeImage.createFromPath(
      dockIconPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        isDark: resolveDockIconDark(currentChoice, osPrefersDark()),
      }),
    ),
  );
  getMainWindow()?.webContents.send(IPC.osAppearanceChanged, osAppearance());
}

/** Set the Dock icon for the current appearance and keep it following OS
    appearance changes: nativeTheme `updated` (renderer theme pushes, OS
    changes under themeSource=system) plus the macOS distributed theme
    notification (OS changes while the app theme is pinned). macOS only;
    no-op elsewhere. */
export function initDockIcon(): void {
  if (process.platform !== 'darwin') return;
  applyDockIcon();
  nativeTheme.on('updated', applyDockIcon);
  systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', applyDockIcon);
}
