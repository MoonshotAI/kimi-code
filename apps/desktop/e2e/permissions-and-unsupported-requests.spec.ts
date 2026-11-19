import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { agentBadge } from './fixtures/browser';
import { startDownloadAuthRoutes } from './fixtures/download-auth-routes';
import { failFileChooserInterceptionRelease } from './fixtures/file-chooser-interception';
import { answerNativeDialog } from './fixtures/native-dialog';

const SCREEN_CAPTURE_NOTICE = 'The page asked to capture the screen or a window. Screen sharing is not supported in the built-in browser, so the request was denied.';
const SWALLOWED_PICKER = 'The file picker this page opened was cancelled because the built-in browser was still handing control back to you. Try again.';

test('site permission prompts reach the user, and unsupported screen capture, HTTP auth and file system pickers are refused', async ({ app, agent, model, pages, scratch }) => {
  const routes = await startDownloadAuthRoutes();
  const url = pages.url('permissions.html');
  let tabId = '';

  try {
    await test.step('a geolocation request under agent control waits for the user, who allows it once', async () => {
      tabId = await agent.openTab(url);
      const page = await app.page(candidate => candidate.startsWith(url), 'permissions fixture');
      await expect(page.getByText('Idle')).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setGeolocationOverride', { latitude: 31.2304, longitude: 121.4737, accuracy: 10 });

      const click = await agent.click(tabId, { role: 'button', name: 'Share location' });
      expect(click.ok, JSON.stringify(click.error)).toBe(true);
      await expect(page.getByText('Locating')).toBeVisible();
      const overlay = await app.overlay();
      const prompt = overlay.getByRole('dialog', { name: 'Website permission' });
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText(`Allow ${pages.origin} to use Location?`);
      await expect(prompt.getByRole('button', { name: 'Always allow' })).toBeVisible();
      await expect(prompt.locator('footer').getByRole('button', { name: 'Block' })).toBeVisible();
      const waiting = await agent.hover(tabId, { name: 'Share screen' });
      expect(waiting.ok).toBe(false);
      expect(waiting.error?.code).toBe('WAITING_FOR_USER');
      expect(waiting.error?.message).toContain('site permission prompt (location)');
      await app.snapshot('geolocation-permission-prompt');

      await prompt.getByRole('button', { name: 'Allow once' }).click();
      await expect(prompt).toBeHidden();
      await expect(page.getByText('Location: 31.2304, 121.4737')).toBeVisible();
      await app.snapshot('geolocation-allowed-once');
      expect((await agent.run('page.elements.snapshot', { tabId })).ok).toBe(true);
      await cdp.detach();
    });

    await test.step('screen capture is denied with a notice to the agent and a record for the user', async () => {
      const page = await app.page(candidate => candidate.startsWith(url), 'permissions fixture');
      const click = await agent.click(tabId, { role: 'button', name: 'Share screen' });
      expect(click.ok, JSON.stringify(click.error)).toBe(true);
      await expect(page.getByText('Screen sharing failed: NotAllowedError')).toBeVisible();
      const events = agent.dialogLog(tabId, click);
      await expect.poll(async () => (await events.poll()).filter(dialog => dialog.kind === 'screen-capture')).toEqual([
        expect.objectContaining({ kind: 'screen-capture', origin: pages.origin, answerer: 'auto' }),
      ]);
      expect(events.notices.filter(notice => notice === SCREEN_CAPTURE_NOTICE)).toHaveLength(1);
      expect(events.handled.filter(dialog => dialog.kind !== 'screen-capture')).toEqual([]);
      const overlay = await app.overlay();
      await expect(overlay.getByRole('dialog', { name: 'Website permission' })).toBeHidden();

      const control = await app.controlSurface();
      await expect(control.locator('.control-records-badge')).toHaveText('1');
      await control.getByRole('button', { name: 'Handled page dialogs' }).click();
      const history = control.getByRole('dialog', { name: 'Page dialogs this session' });
      await expect(history.getByRole('listitem')).toHaveCount(1);
      await expect(history.getByRole('listitem')).toContainText('Screen sharing');
      await expect(history.getByRole('listitem')).toContainText('Blocked automatically');
      await app.snapshot('screen-capture-denied');
      await control.getByRole('button', { name: 'Handled page dialogs' }).click();
      await expect(history).toBeHidden();
    });

    await test.step('a Basic auth challenge is cancelled with a notice and no native sign-in dialog', async () => {
      const membersUrl = routes.url('/members');
      const navigated = await agent.run('tab.navigate', { tabId, url: membersUrl });
      const events = agent.dialogLog(tabId, navigated);
      const members = await app.page(candidate => candidate.startsWith(membersUrl), 'members page');
      await expect(members.getByRole('heading', { name: '401 Members only' })).toBeVisible();
      const notice = `${routes.origin} asked for a username and password (HTTP authentication). HTTP authentication is not supported in the built-in browser, so the request was cancelled and neither the agent nor the user can sign in here; tell the user to open the page in their default browser if they need it.`;
      await expect.poll(async () => {
        await events.poll();
        return events.notices;
      }).toContain(notice);
      const overlay = await app.overlay();
      await expect(overlay.getByRole('dialog')).toHaveCount(0);
      await app.snapshot('http-auth-unsupported');

      const back = await agent.run('tab.navigate', { tabId, url });
      expect(back.ok, JSON.stringify(back.error)).toBe(true);
      expect((await agent.run('tab.wait_for_load', { tabId, state: 'complete' })).ok).toBe(true);
    });

    await test.step('a file system picker swallowed while control returns is reported to the user, and a file input reopens the picker', async () => {
      const page = await app.page(candidate => candidate.startsWith(url), 'permissions fixture');
      await expect(page.getByText('Idle')).toBeVisible();
      const control = await app.controlSurface();
      const interception = await failFileChooserInterceptionRelease(app);
      try {
        model.releaseTurns();
        await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeHidden();
        await expect.poll(interception.failures, { message: 'waiting for the app to try turning file chooser interception off' }).toBeGreaterThan(0);

        await page.evaluate(() => (window as unknown as { pickFile: () => void }).pickFile());
        const overlay = await app.overlay();
        const alert = overlay.getByRole('dialog', { name: /says$/ });
        await expect(alert).toBeVisible();
        await expect(alert).toContainText(SWALLOWED_PICKER);
        await expect(agentBadge(alert)).toBeHidden();
        await app.snapshot('swallowed-file-system-picker');
        await alert.getByRole('button', { name: 'OK' }).click();
        await expect(alert).toBeHidden();
        await expect(page.getByText('File system picker failed: AbortError')).toBeVisible();

        const outside = join(scratch, 'outside');
        await mkdir(outside, { recursive: true });
        const picked = join(outside, 'store-receipt.txt');
        await writeFile(picked, 'receipt\n');
        await answerNativeDialog(app, 'showOpenDialog', { canceled: false, filePaths: [picked] });
        await page.evaluate(() => document.getElementById('attachment')!.click());
        await expect(page.getByRole('list', { name: 'Received files' }).getByRole('listitem')).toHaveText(['store-receipt.txt']);
        await expect(overlay.getByRole('dialog')).toHaveCount(0);
        await app.snapshot('reopened-picker-answered');
      } finally {
        await interception.restore();
      }
    });
  } finally {
    await routes.close();
  }
});
