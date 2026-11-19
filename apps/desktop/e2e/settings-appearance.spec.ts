import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { say } from './fixtures/model';
import { closeSettings, luminance, menuItem, nativeThemeSource, openSettings } from './fixtures/settings';
import { sidebarOf } from './fixtures/sessions';

const PROMPT = 'Describe the release checklist';
const REPLY = 'The release checklist has five steps, starting with the changelog review.';
const EN_TABS = ['General', 'Account', 'Agent & Sessions', 'Model Providers', 'Devices', 'Browser', 'Plugins', 'Hotkeys', 'About', 'Lab', 'Archived Sessions'];
const ZH_TABS = ['通用', '账户', '智能体与会话', '模型供应商', '设备', '浏览器', '插件', '快捷键', '关于', '实验室', '已归档的会话'];
const DESKTOP_DIR = fileURLToPath(new URL('..', import.meta.url));
const CORE_DIR = join(DESKTOP_DIR, '..', '..', 'kimi-code');

const git = (args: string[]): string => execFileSync('git', args, { cwd: CORE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const expectedCoreRef = (): string => {
  try {
    const commit = git(['rev-parse', '--short', 'HEAD']);
    let branch = '';
    try {
      branch = git(['symbolic-ref', '--short', 'HEAD']);
    } catch {
      branch = '';
    }
    return branch === '' ? commit : `${branch}@${commit}`;
  } catch {
    return '';
  }
};

const appBackground = (window: Page): Promise<number> =>
  window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg')).then(luminance);
const replyFontSize = (window: Page): Promise<number> =>
  window.getByRole('list').first().getByText(REPLY, { exact: true })
    .evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));

test('appearance, font size and language apply app-wide and survive a relaunch', async ({ app, model }) => {
  const window = app.window;
  const transcript = window.getByRole('list').first();
  let medium = 0;

  await test.step('a finished turn gives the transcript text to measure', async () => {
    model.script(say(REPLY));
    await app.startTurn(PROMPT);
    await expect(transcript.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await app.snapshot('transcript');
  });

  await test.step('Mod+, opens Settings on General with every tab listed', async () => {
    const dialog = await openSettings(window);
    const tabs = dialog.getByRole('tablist', { name: 'Settings' }).getByRole('tab');
    await expect(tabs).toHaveText(EN_TABS);
    await expect(dialog.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'System', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tab', { name: 'English', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tablist', { name: 'Font size' }).getByRole('tab', { name: 'Normal', exact: true })).toHaveAttribute('aria-selected', 'true');
    await app.snapshot('settings-general');
  });

  await test.step('Moon dark darkens the app and the native theme', async () => {
    const dialog = await openSettings(window);
    await window.emulateMedia({ colorScheme: 'light' });
    await dialog.getByRole('tab', { name: 'Moon dark', exact: true }).click();
    await expect(dialog.getByRole('tab', { name: 'Moon dark', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => appBackground(window)).toBeLessThan(0.2);
    await expect.poll(() => nativeThemeSource(app.electron)).toBe('dark');
    await app.snapshot('moon-dark');
  });

  await test.step('Moon bright lightens it, and System follows the OS scheme', async () => {
    const dialog = await openSettings(window);
    await dialog.getByRole('tab', { name: 'Moon bright', exact: true }).click();
    await expect(dialog.getByRole('tab', { name: 'Moon bright', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => appBackground(window)).toBeGreaterThan(0.8);
    await expect.poll(() => nativeThemeSource(app.electron)).toBe('light');
    await app.snapshot('moon-bright');

    await dialog.getByRole('tab', { name: 'System', exact: true }).click();
    await expect(dialog.getByRole('tab', { name: 'System', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => nativeThemeSource(app.electron)).toBe('system');
    await expect.poll(() => appBackground(window)).toBeGreaterThan(0.8);
    await window.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => appBackground(window)).toBeLessThan(0.2);
    await app.snapshot('system-with-dark-os');
    await window.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => appBackground(window)).toBeGreaterThan(0.8);
  });

  await test.step('the font size scale resizes the transcript text', async () => {
    const dialog = await openSettings(window);
    const sizes = dialog.getByRole('tablist', { name: 'Font size' });
    medium = await replyFontSize(window);
    await sizes.getByRole('tab', { name: 'Small', exact: true }).click();
    await expect.poll(() => replyFontSize(window)).toBeLessThan(medium);
    await sizes.getByRole('tab', { name: 'Extra Large', exact: true }).click();
    await expect(sizes.getByRole('tab', { name: 'Extra Large', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => replyFontSize(window)).toBeGreaterThan(medium);
    await closeSettings(window);
    await app.snapshot('font-xl');
  });

  await test.step('switching to Chinese relabels the whole UI and the native menu', async () => {
    const dialog = await openSettings(window);
    await dialog.getByRole('tab', { name: 'Moon dark', exact: true }).click();
    await dialog.getByRole('tab', { name: '简体中文', exact: true }).click();
    await expect(window.getByRole('dialog', { name: '设置' })).toBeVisible();
    await expect(dialog.getByRole('tablist', { name: '设置' }).getByRole('tab')).toHaveText(ZH_TABS);
    await expect(dialog.getByRole('tab', { name: '月之暗面', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await menuItem(app.electron, 'open-settings'))?.label).toBe('设置…');
    await closeSettings(window);
    await expect(window.getByRole('button', { name: /^新建会话/ })).toBeVisible();
    await expect(window.getByRole('combobox', { name: '消息输入框' })).toHaveAttribute('aria-placeholder', '输入消息…');
    await app.snapshot('chinese-dark-xl');
  });

  await test.step('a relaunch keeps Chinese, Moon dark and the XL font', async () => {
    await app.relaunch();
    const relaunched = app.window;
    await expect(relaunched.getByRole('button', { name: /^新建会话/ })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => appBackground(relaunched)).toBeLessThan(0.2);
    await expect.poll(() => nativeThemeSource(app.electron)).toBe('dark');
    await expect.poll(async () => (await menuItem(app.electron, 'open-settings'))?.label).toBe('设置…');
    await sidebarOf(app).getByText(PROMPT).click();
    await expect(relaunched.getByRole('list').first().getByText(REPLY, { exact: true })).toBeVisible();
    await expect.poll(() => replyFontSize(relaunched)).toBeGreaterThan(medium);
    const dialog = await openSettings(relaunched);
    await expect(dialog.getByRole('tab', { name: '简体中文', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tab', { name: '月之暗面', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tablist', { name: '字体大小' }).getByRole('tab', { name: '特大', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tablist', { name: '设置' }).getByRole('tab')).toHaveText(ZH_TABS);
    await app.snapshot('relaunched-chinese');
  });

  await test.step('switching back to English and the defaults restores the original look', async () => {
    const window = app.window;
    const dialog = await openSettings(window);
    await dialog.getByRole('tab', { name: 'English', exact: true }).click();
    await expect(dialog.getByRole('tablist', { name: 'Settings' }).getByRole('tab')).toHaveText(EN_TABS);
    await dialog.getByRole('tab', { name: 'System', exact: true }).click();
    await dialog.getByRole('tablist', { name: 'Font size' }).getByRole('tab', { name: 'Normal', exact: true }).click();
    await expect(dialog.getByRole('tab', { name: 'System', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tablist', { name: 'Font size' }).getByRole('tab', { name: 'Normal', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => nativeThemeSource(app.electron)).toBe('system');
    await expect.poll(() => replyFontSize(window)).toBe(medium);
    await expect.poll(async () => (await menuItem(app.electron, 'open-settings'))?.label).toBe('Settings…');
    await closeSettings(window);
    await expect(window.getByRole('button', { name: /^New Session/ })).toBeVisible();
    await expect(window.getByRole('combobox', { name: 'Message input' })).toHaveAttribute('aria-placeholder', 'Type a message…');
    await app.snapshot('english-defaults');
  });

  await test.step('About shows the app version and the built-in server version', async () => {
    const pkg = JSON.parse(await readFile(join(DESKTOP_DIR, 'package.json'), 'utf8')) as { version: string };
    const dialog = await openSettings(app.window, 'About');
    await expect(dialog.getByRole('heading', { name: 'Version & updates' })).toBeVisible();
    const appVersion = dialog.locator('.row', { hasText: 'App version' });
    await expect(appVersion.locator('.rvalue')).toHaveText(pkg.version);
    const coreRef = dialog.locator('.row', { hasText: 'Built-in server version' });
    await expect(coreRef.locator('.rvalue')).toHaveText(expectedCoreRef());
    await expect(dialog.getByRole('button', { name: 'Export log' })).toBeVisible();
    await app.snapshot('about');
  });
});
