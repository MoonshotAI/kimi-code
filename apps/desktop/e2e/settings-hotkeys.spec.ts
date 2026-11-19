import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { say } from './fixtures/model';
import { closeSettings, menuItem, openSettings } from './fixtures/settings';
import { sidebarOf } from './fixtures/sessions';

const APPLE = process.platform === 'darwin';
const MOD = APPLE ? 'Command' : 'Ctrl';
const SHIFT = 'Shift';
const PROMPT = 'Draft the weekly status update';
const REPLY = 'Here is the weekly status draft.';

const shortcutRow = (dialog: Locator, label: string): Locator =>
  dialog.locator('.sc-row').filter({ hasText: new RegExp(`^\\s*${label}`) });

async function findShortcut(dialog: Locator, label: string): Promise<Locator> {
  await dialog.getByPlaceholder('Search shortcuts').fill(label);
  const row = shortcutRow(dialog, label);
  await expect(row).toHaveCount(1);
  return row;
}

async function record(window: Page, row: Locator, chord: string): Promise<void> {
  await row.getByRole('button', { name: 'Edit shortcut' }).click();
  await expect(row.getByText('Press the new shortcut…')).toBeVisible();
  await window.keyboard.press(chord);
}

const searchDialog = (window: Page): Locator => window.getByPlaceholder('Search sessions and projects');

test('hotkeys are rebound with the recorder, guarded against conflicts, persisted and reset', async ({ app, model }) => {
  const sidebar = (): Locator => sidebarOf(app);

  await test.step('a finished session to navigate away from, and the default bindings', async () => {
    model.script(say(REPLY));
    await app.startTurn(PROMPT);
    await expect(app.window.getByRole('list').first().getByText(REPLY, { exact: true })).toBeVisible();
    await expect(sidebar().getByRole('button', { name: `Search ${MOD} K` })).toBeVisible();
    await expect(sidebar().getByRole('button', { name: `New Session ${MOD} N` })).toBeVisible();
    expect((await menuItem(app.electron, 'new-chat'))?.accelerator).toBe('CommandOrControl+N');
    const dialog = await openSettings(app.window, 'Hotkeys');
    const row = await findShortcut(dialog, 'Search Chats');
    await expect(row.getByText('Open the session search dialog')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Unassign shortcut' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
    await app.snapshot('hotkeys-search-filter');
  });

  await test.step('the recorder rejects a conflicting chord and a reserved one', async () => {
    const dialog = await openSettings(app.window);
    const row = shortcutRow(dialog, 'Search Chats');
    await record(app.window, row, 'ControlOrMeta+b');
    await expect(row.getByText('Already used by “Toggle Sidebar”')).toBeVisible();
    await app.snapshot('hotkeys-conflict');
    await app.window.keyboard.press('ControlOrMeta+s');
    await expect(row.getByText('Reserved for steer (Ctrl/Cmd+S)')).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(row.getByText('Press the new shortcut…')).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(row.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
  });

  await test.step('Search Chats is rebound to Shift+Mod+J', async () => {
    const dialog = await openSettings(app.window);
    const row = shortcutRow(dialog, 'Search Chats');
    await record(app.window, row, 'ControlOrMeta+Shift+j');
    await expect(row.getByText('Press the new shortcut…')).toBeHidden();
    await expect(row.getByRole('button', { name: 'Reset to default' })).toBeVisible();
    await app.snapshot('hotkeys-search-rebound');
    await closeSettings(app.window);
    await expect(sidebar().getByRole('button', { name: `Search ${SHIFT} ${MOD} J` })).toBeVisible();
  });

  await test.step('the new chord opens search and the old one no longer does', async () => {
    await app.window.keyboard.press('ControlOrMeta+k');
    await expect(searchDialog(app.window)).toBeHidden();
    await app.window.keyboard.press('ControlOrMeta+Shift+j');
    await expect(searchDialog(app.window)).toBeVisible();
    await app.snapshot('search-opened-by-new-chord');
    await app.window.keyboard.press('Escape');
    await expect(searchDialog(app.window)).toBeHidden();
  });

  await test.step('New Session is rebound and the native menu follows', async () => {
    const dialog = await openSettings(app.window, 'Hotkeys');
    const row = await findShortcut(dialog, 'New Session');
    await record(app.window, row, 'ControlOrMeta+Shift+u');
    await expect(row.getByRole('button', { name: 'Reset to default' })).toBeVisible();
    await expect.poll(async () => (await menuItem(app.electron, 'new-chat'))?.accelerator).toBe('Shift+CommandOrControl+U');
    await closeSettings(app.window);
    await expect(sidebar().getByRole('button', { name: `New Session ${SHIFT} ${MOD} U` })).toBeVisible();

    await app.window.getByRole('combobox', { name: 'Message input' }).click();
    await app.window.keyboard.press('ControlOrMeta+n');
    await app.window.keyboard.press('ControlOrMeta+Shift+j');
    await expect(searchDialog(app.window)).toBeVisible();
    expect(app.window.url()).toMatch(/\/sessions\//);
    await expect(app.window.getByRole('list').first().getByText(REPLY, { exact: true })).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(searchDialog(app.window)).toBeHidden();
    await app.window.keyboard.press('ControlOrMeta+Shift+u');
    await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
    await expect(app.window.getByRole('list').first().getByText(REPLY, { exact: true })).toBeHidden();
    await app.snapshot('new-session-by-new-chord');
  });

  await test.step('both bindings survive a relaunch', async () => {
    await app.relaunch();
    await expect(sidebar().getByRole('button', { name: `Search ${SHIFT} ${MOD} J` })).toBeVisible({ timeout: 30_000 });
    await expect(sidebar().getByRole('button', { name: `New Session ${SHIFT} ${MOD} U` })).toBeVisible();
    await expect.poll(async () => (await menuItem(app.electron, 'new-chat'))?.accelerator).toBe('Shift+CommandOrControl+U');
    await app.window.getByRole('combobox', { name: 'Message input' }).click();
    await app.window.keyboard.press('ControlOrMeta+k');
    await expect(searchDialog(app.window)).toBeHidden();
    await app.window.keyboard.press('ControlOrMeta+Shift+j');
    await expect(searchDialog(app.window)).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(searchDialog(app.window)).toBeHidden();

    await sidebar().getByText(PROMPT).click();
    await expect(app.window.getByRole('list').first().getByText(REPLY, { exact: true })).toBeVisible({ timeout: 30_000 });
    const sessionUrl = app.window.url();
    expect(sessionUrl).toMatch(/\/sessions\//);
    await app.window.getByRole('combobox', { name: 'Message input' }).click();
    await app.window.keyboard.press('ControlOrMeta+n');
    await app.window.keyboard.press('ControlOrMeta+Shift+j');
    await expect(searchDialog(app.window)).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(searchDialog(app.window)).toBeHidden();
    expect(app.window.url()).toBe(sessionUrl);
    await expect(app.window.getByRole('list').first().getByText(REPLY, { exact: true })).toBeVisible();
    await app.window.keyboard.press('ControlOrMeta+Shift+u');
    await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
    await expect(app.window.getByRole('list').first().getByText(REPLY, { exact: true })).toBeHidden();
    await app.snapshot('relaunched-with-custom-bindings');
  });

  await test.step('resetting one binding and then all restores the defaults', async () => {
    const dialog = await openSettings(app.window, 'Hotkeys');
    const row = await findShortcut(dialog, 'Search Chats');
    await row.getByRole('button', { name: 'Reset to default' }).click();
    await expect(row.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
    expect((await menuItem(app.electron, 'new-chat'))?.accelerator).toBe('Shift+CommandOrControl+U');
    await dialog.getByPlaceholder('Search shortcuts').fill('');
    await dialog.getByRole('button', { name: 'Reset all to defaults' }).click();
    await expect(dialog.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
    await expect.poll(async () => (await menuItem(app.electron, 'new-chat'))?.accelerator).toBe('CommandOrControl+N');
    await app.snapshot('hotkeys-reset');
    await closeSettings(app.window);
    await expect(sidebar().getByRole('button', { name: `Search ${MOD} K` })).toBeVisible();
    await expect(sidebar().getByRole('button', { name: `New Session ${MOD} N` })).toBeVisible();
    await app.window.keyboard.press('ControlOrMeta+k');
    await expect(searchDialog(app.window)).toBeVisible();
    await app.window.keyboard.press('Escape');
    await expect(searchDialog(app.window)).toBeHidden();
  });

  await test.step('the Lab tabbed session list adds Open / Done / Projects tabs with their shortcuts', async () => {
    const dialog = await openSettings(app.window, 'Lab');
    const toggle = dialog.getByRole('switch', { name: 'Tabbed session list' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(sidebar().getByRole('tab', { name: 'Done' })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await closeSettings(app.window);
    const tabs = sidebar().getByRole('tablist').getByRole('tab');
    await expect(tabs).toHaveText(['Open', 'Done', 'Projects']);
    await expect(sidebar().getByRole('tab', { name: 'Open' })).toHaveAttribute('aria-selected', 'true');
    await expect(sidebar().getByText(PROMPT)).toBeVisible();

    await app.window.keyboard.press('ControlOrMeta+Shift+d');
    await expect(sidebar().getByRole('tab', { name: 'Done' })).toHaveAttribute('aria-selected', 'true');
    await expect(sidebar().getByText(PROMPT)).toBeHidden();
    await app.window.keyboard.press('ControlOrMeta+Shift+w');
    await expect(sidebar().getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
    await app.snapshot('lab-workspaces-tab');
    await app.window.keyboard.press('ControlOrMeta+Shift+o');
    await expect(sidebar().getByRole('tab', { name: 'Open' })).toHaveAttribute('aria-selected', 'true');
    await expect(sidebar().getByText(PROMPT)).toBeVisible();
    await app.snapshot('lab-open-tab');

    const off = await openSettings(app.window, 'Lab');
    await off.getByRole('switch', { name: 'Tabbed session list' }).click();
    await closeSettings(app.window);
    await expect(sidebar().getByRole('tab', { name: 'Done' })).toHaveCount(0);
    await expect(sidebar().getByText(PROMPT)).toBeVisible();
  });
});
