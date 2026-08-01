import { join } from 'node:path';

import { app, nativeImage } from 'electron';

import { getDockIconChoice, saveDockIconChoice } from './ui-state';

// User-picked Dock icon. macOS has no appearance variants in .icns (the
// packaged bundle icon is static — Finder/Launchpad keep the light tile), but
// app.dock.setIcon works at runtime, so the running app's Dock icon follows
// the explicit settings choice: light tile (icon.png) or dark tile
// (icon-dark.png), both generated from the KIMI CODE LOGO kit by
// scripts/build-brand-icons.mjs. Dev needs the explicit setIcon anyway (an
// unpackaged run shows Electron's default Dock icon); packaged builds get the
// same swap for consistency while running.

export interface DockIconEnv {
  isPackaged: boolean;
  /** <resources> in packaged builds (mac-only extraResources carries build/icon*.png). */
  resourcesPath: string;
  /** Repo dir in dev (Electron launched with cwd = apps/desktop). */
  appPath: string;
  /** Which tile to use. */
  isDark: boolean;
}

/** Dock icon file for the given appearance. */
export function dockIconPath(env: DockIconEnv): string {
  return join(env.isPackaged ? env.resourcesPath : env.appPath, 'build', env.isDark ? 'icon-dark.png' : 'icon.png');
}

/** User preference for the Dock tile: the default light tile or the black one. */
export type DockIconChoice = 'light' | 'dark';

export function isDockIconChoice(value: unknown): value is DockIconChoice {
  return value === 'light' || value === 'dark';
}

// Renderer-pushed preference (IPC.dockIconChoice), mirrored into ui-state.json
// on every push; initDockIcon seeds from that file so the first tile at launch
// is already the user's choice (the renderer's localStorage original only
// arrives once the window has booted). 'light' when nothing is stored, which
// matches the static bundle icon.
let currentChoice: DockIconChoice = 'light';

/** Update the preference (settings UI), persist the startup seed, and
    re-apply the Dock icon. */
export function setDockIconChoice(choice: DockIconChoice): void {
  currentChoice = choice;
  saveDockIconChoice(choice);
  applyDockIcon();
}

function applyDockIcon(): void {
  if (process.platform !== 'darwin') return;
  app.dock?.setIcon(
    nativeImage.createFromPath(
      dockIconPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        isDark: currentChoice === 'dark',
      }),
    ),
  );
}

/** Seed from the ui-state.json mirror, then set the Dock icon once; afterwards
    it only changes when the renderer pushes a new preference
    (setDockIconChoice). macOS only; no-op elsewhere. */
export function initDockIcon(): void {
  if (process.platform !== 'darwin') return;
  currentChoice = getDockIconChoice() ?? 'light';
  applyDockIcon();
}
