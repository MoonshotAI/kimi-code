import type { Locator } from '@playwright/test';

import { expect, type DesktopApp } from './app';
import { say, type StubModel } from './model';

export const sidebarOf = (app: DesktopApp): Locator => 
  app.window.getByRole('complementary').filter({ has: app.window.getByRole('button', { name: /^(New Session|新建会话)/ }) });

export const transcriptOf = (app: DesktopApp): Locator => app.window.getByRole('list').first();

export const sessionRow = (app: DesktopApp, title: string | RegExp): Locator =>
  sidebarOf(app).locator('[data-session-id]').filter({ hasText: title });

export const sessionRowById = (app: DesktopApp, id: string): Locator => sidebarOf(app).locator(`[data-session-id="${id}"]`);

export async function rowMenu(app: DesktopApp, row: string | RegExp | Locator): Promise<Locator> {
  const target = typeof row === 'string' || row instanceof RegExp ? sidebarOf(app).getByText(row).first() : row;
  await target.click({ button: 'right' });
  const menu = app.window.getByRole('menu');
  await expect(menu).toHaveCount(1);
  await expect(menu).toBeVisible();
  return menu;
}

export async function sendAndFinish(app: DesktopApp, model: StubModel, prompt: string, reply: string): Promise<string> {
  model.script(say(reply));
  await app.startTurn(prompt);
  await expect(transcriptOf(app).getByText(reply, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  return app.sessionId();
}

export async function expectOrder(scope: Locator, texts: readonly string[]): Promise<void> {
  await expect.poll(async () => {
    const text = await scope.textContent() ?? '';
    const positions = texts.map(entry => text.indexOf(entry));
    return positions.every(position => position >= 0) && positions.every((position, index) => index === 0 || positions[index - 1]! < position);
  }, { message: `expected ${texts.join(' < ')}` }).toBe(true);
}

export async function relaunchAndSettle(app: DesktopApp): Promise<void> {
  await app.relaunch();
  await expect(sidebarOf(app).locator('[data-session-id]').first()).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('status', { name: 'Connecting…' })).toHaveCount(0, { timeout: 30_000 });
}
