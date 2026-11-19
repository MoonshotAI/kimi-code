import { expect } from '@playwright/test';

import type { DesktopApp } from './app';

export type PermissionLabel = 'Always Ask' | 'Ask When Needed' | 'Never Ask';

export const permissionPill = (app: DesktopApp, label: PermissionLabel) =>
  app.window.getByRole('button', { name: label, exact: true });

export async function choosePermissionMode(app: DesktopApp, from: PermissionLabel, to: PermissionLabel, snapshot?: string): Promise<void> {
  await permissionPill(app, from).click();
  const overlay = await app.overlay();
  const choice = overlay.getByRole('menuitemradio', { name: new RegExp(`^${to}`) });
  await expect(choice).toBeVisible();
  await expect(overlay.getByRole('menuitemradio', { name: new RegExp(`^${from}`) })).toHaveAttribute('aria-checked', 'true');
  if (snapshot !== undefined) await app.snapshot(snapshot);
  await choice.click();
  await expect(choice).toBeHidden();
  await expect(permissionPill(app, to)).toBeVisible();
}
