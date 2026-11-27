import { expect, type Page } from '@playwright/test';

import type { DesktopApp } from './app';
import { sidebarOf } from './sessions';

export async function waitForSettledReply(window: Page, text: string): Promise<void> {
  await expect(window.getByRole('list').first().getByText(text, { exact: true })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
}

export async function relaunchAndSettle(app: DesktopApp, title: string): Promise<void> {
  await app.relaunch();
  await expect(sidebarOf(app).getByText(title, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
}
