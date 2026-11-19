import { join } from 'node:path';

import { app, nativeImage } from 'electron';

import { getDockIconChoice, saveDockIconChoice } from '../app/ui-state';

export interface DockIconEnv {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  isDark: boolean;
}

export function dockIconPath(env: DockIconEnv): string {
  return join(env.isPackaged ? env.resourcesPath : env.appPath, 'build', env.isDark ? 'icon-dark.png' : 'icon.png');
}

export type DockIconChoice = 'light' | 'dark';

export function isDockIconChoice(value: unknown): value is DockIconChoice {
  return value === 'light' || value === 'dark';
}

let currentChoice: DockIconChoice = 'light';

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

export function initDockIcon(): void {
  if (process.platform !== 'darwin') return;
  currentChoice = getDockIconChoice() ?? 'light';
  applyDockIcon();
}
