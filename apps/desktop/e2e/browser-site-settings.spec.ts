import type { Page } from '@playwright/test';

import { addressBar, browserSection, detailPanel, expect, goTo, pageAt, test } from './fixtures/browser';

interface ProbeState {
  readonly notifications: boolean;
  readonly location: boolean;
  readonly cookie: string;
  readonly stored: string | null;
}

const probeState = (page: Page): Promise<ProbeState> => page.evaluate(async () => ({
  notifications: (await navigator.permissions.query({ name: 'notifications' })).state === 'granted' && Notification.permission === 'granted',
  location: (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted',
  cookie: document.cookie,
  // eslint-disable-next-line no-restricted-globals
  stored: localStorage.getItem('bench-draft'),
}));

const locationError = (page: Page): Promise<number> => page.evaluate(() => new Promise<number>((resolve) => {
  navigator.geolocation.getCurrentPosition(() => resolve(0), error => resolve(error.code), { timeout: 10_000 });
}));

test('site permissions are set from the address bar, reach the page, clear site data and survive a relaunch', async ({ app, sites }) => {
  const probe = sites.lab.url('/probe');
  const origin = sites.lab.origin;
  const siteMenu = async () => {
    await browserSection(app).getByRole('button', { name: 'Site information' }).click();
    const overlay = await app.overlay();
    await expect(overlay.getByRole('menu')).toBeVisible();
    return overlay;
  };
  const choice = (overlay: Page, permission: string) => overlay.getByRole('group', { name: permission, exact: true });
  const openProbe = async () => {
    await app.window.getByRole('button', { name: 'Open right panel' }).click();
    await app.window.getByRole('group', { name: 'Quick open' }).getByRole('button', { name: /Browser/ }).click();
    await goTo(app, probe);
    const page = await pageAt(app, probe);
    await expect(page.getByRole('heading', { name: 'Permission Probe' })).toBeVisible();
    return page;
  };

  await test.step('a fresh site asks for every permission and stores a cookie and local data', async () => {
    const page = await openProbe();
    await page.evaluate(() => {
      document.cookie = 'crew=seven; max-age=3600; path=/';
      // eslint-disable-next-line no-restricted-globals
      localStorage.setItem('bench-draft', 'centrifuge seal');
    });
    expect(await probeState(page)).toEqual({ notifications: false, location: false, cookie: 'crew=seven', stored: 'centrifuge seal' });
    const overlay = await siteMenu();
    await expect(overlay.getByText(origin, { exact: true })).toBeVisible();
    await expect(choice(overlay, 'Notifications').getByRole('tab', { name: 'Ask' })).toHaveAttribute('aria-selected', 'true');
    await expect(choice(overlay, 'Location').getByRole('tab', { name: 'Ask' })).toHaveAttribute('aria-selected', 'true');
    await expect(overlay.getByText('Cookies: 1')).toBeVisible();
    await app.snapshot('site-menu-defaults');
  });

  await test.step('allowing notifications and blocking location reaches the page', async () => {
    const overlay = await app.overlay();
    await choice(overlay, 'Notifications').getByRole('tab', { name: 'Allow' }).click();
    await expect(choice(overlay, 'Notifications').getByRole('tab', { name: 'Allow' })).toHaveAttribute('aria-selected', 'true');
    await choice(overlay, 'Location').getByRole('tab', { name: 'Block' }).click();
    await expect(choice(overlay, 'Location').getByRole('tab', { name: 'Block' })).toHaveAttribute('aria-selected', 'true');
    await app.snapshot('notifications-allowed-location-blocked');
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByRole('menu')).toBeHidden();

    const page = await pageAt(app, probe);
    const reloaded = page.waitForEvent('load');
    await browserSection(app).getByRole('button', { name: 'Reload' }).click();
    await reloaded;
    await expect.poll(() => probeState(page).then(state => [state.notifications, state.location])).toEqual([true, false]);
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('granted');
    expect(await locationError(page)).toBe(1);
  });

  await test.step('deleting site data after confirming clears the cookie and local storage but keeps permissions', async () => {
    const overlay = await siteMenu();
    await overlay.getByRole('menuitem', { name: 'Delete site data' }).click();
    const confirm = overlay.getByRole('dialog');
    await expect(confirm).toContainText(`Delete cookies and local data for ${origin}? This may sign you out.`);
    await app.snapshot('delete-site-data-confirm');
    await confirm.getByRole('button', { name: 'Delete site data' }).click();
    await expect(confirm).toBeHidden();
    const reopened = await siteMenu();
    await expect(reopened.getByText('Cookies: 0')).toBeVisible();
    await expect(choice(reopened, 'Notifications').getByRole('tab', { name: 'Allow' })).toHaveAttribute('aria-selected', 'true');
    await reopened.keyboard.press('Escape');
    const page = await pageAt(app, probe);
    const reloaded = page.waitForEvent('load');
    await browserSection(app).getByRole('button', { name: 'Reload' }).click();
    await reloaded;
    await expect.poll(() => probeState(page)).toEqual({ notifications: true, location: false, cookie: '', stored: null });
  });

  await test.step('Site settings lists the origin and resets location back to Ask', async () => {
    const overlay = await siteMenu();
    await overlay.getByRole('menuitem', { name: 'Site settings' }).click();
    const settings = app.window.getByRole('dialog');
    await settings.getByText(origin, { exact: true }).click();
    await expect(settings.getByRole('heading', { name: origin })).toBeVisible();
    await expect(settings.getByRole('combobox', { name: 'Notifications' })).toContainText('Allow');
    await expect(settings.getByRole('combobox', { name: 'Location' })).toContainText('Block');
    await settings.getByRole('combobox', { name: 'Location' }).click();
    await app.window.getByRole('option', { name: 'Ask' }).click();
    await expect(settings.getByRole('combobox', { name: 'Location' })).toContainText('Ask');
    await app.snapshot('site-settings-location-ask');
    await app.window.keyboard.press('Escape');
    await expect(settings).toBeHidden();
  });

  await test.step('after a relaunch the restored tab still has notifications and no location decision', async () => {
    await app.relaunch();
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    await expect(detailPanel(app).getByRole('tab', { name: 'Permission Probe', selected: true })).toBeVisible();
    await expect(addressBar(app)).toHaveValue(probe);
    const page = await pageAt(app, probe);
    await expect(page.getByRole('heading', { name: 'Permission Probe' })).toBeVisible();
    await expect.poll(() => probeState(page)).toEqual({ notifications: true, location: false, cookie: '', stored: null });
    const overlay = await siteMenu();
    await expect(choice(overlay, 'Notifications').getByRole('tab', { name: 'Allow' })).toHaveAttribute('aria-selected', 'true');
    await expect(choice(overlay, 'Location').getByRole('tab', { name: 'Ask' })).toHaveAttribute('aria-selected', 'true');
    await expect(overlay.getByText('Cookies: 0')).toBeVisible();
    await app.snapshot('site-permissions-after-relaunch');
  });
});
