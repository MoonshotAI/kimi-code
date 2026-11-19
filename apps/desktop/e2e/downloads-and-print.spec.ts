import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { startDownloadAuthRoutes } from './fixtures/download-auth-routes';
import { textOf } from './fixtures/model';
import { answerNativeDialog, answeredNativeCalls } from './fixtures/native-dialog';
import { chooseOption, closeSettings, openSettings } from './fixtures/settings';

const DOWNLOAD_LIMIT = 100 * 1024 ** 2;

test('agent downloads are saved, capped and attributed, user downloads offer Save As, and printing is blocked for the agent', async ({ app, agent, model, pages, scratch }) => {
  const routes = await startDownloadAuthRoutes();
  const agentDir = join(scratch, 'agent-downloads');
  const movedDir = join(scratch, 'moved');
  await Promise.all([agentDir, movedDir].map(dir => mkdir(dir, { recursive: true })));
  const url = `${pages.url('downloads.html')}?files=${encodeURIComponent(routes.origin)}`;
  let tabId = '';

  try {
    await test.step('the agent download lands in the agent folder and is recorded for the indicator', async () => {
      await answerNativeDialog(app, 'showOpenDialog', { canceled: false, filePaths: [agentDir] });
      const settings = await openSettings(app.window, 'Browser');
      await settings.getByRole('button', { name: 'Choose…' }).click();
      await expect(settings.getByText(agentDir, { exact: true })).toBeVisible();
      const limit = settings.getByRole('combobox', { name: 'Agent download size limit' });
      await chooseOption(app.window, limit, '100 MB');
      await expect(limit).toHaveText('100 MB');
      await closeSettings(app.window);

      tabId = await agent.openTab(url);
      const page = await app.page(candidate => candidate.startsWith(pages.url('downloads.html')), 'downloads fixture');
      await expect(page.getByText('Ready')).toBeVisible();

      const click = await agent.click(tabId, { role: 'link', name: 'Download report' });
      expect(click.ok, JSON.stringify(click.error)).toBe(true);
      await expect.poll(() => readdir(agentDir)).toEqual(['report.csv']);
      const events = agent.dialogLog(tabId, click);
      await expect.poll(events.poll).toEqual([expect.objectContaining({ kind: 'download', origin: routes.origin, message: 'report.csv', outcome: 'saved', answerer: 'auto', files: [join(agentDir, 'report.csv')] })]);
      expect(await readdir(app.downloads)).toEqual([]);

      const control = await app.controlSurface();
      await expect(control.locator('.control-records-badge')).toHaveText('1');
      await app.snapshot('agent-download-badge');
      await control.getByRole('button', { name: 'Handled page dialogs' }).click();
      const history = control.getByRole('dialog', { name: 'Page dialogs this session' });
      const record = history.getByRole('listitem').filter({ hasText: 'report.csv' });
      await expect(record).toContainText('Download');
      await expect(record).toContainText('Saved automatically');
      await expect(record.getByRole('button', { name: 'Show in folder' })).toBeVisible();
      await expect(record.getByRole('button', { name: 'Move…' })).toBeVisible();
      await app.snapshot('agent-download-popover');
      await answerNativeDialog(app, 'showItemInFolder', undefined);
      await record.getByRole('button', { name: 'Show in folder' }).click();
      await expect.poll(async () => (await answeredNativeCalls(app)).filter(call => call.api === 'showItemInFolder')).toEqual([
        { api: 'showItemInFolder', detail: join(agentDir, 'report.csv') },
      ]);
      await control.getByRole('button', { name: 'Handled page dialogs' }).click();
      await expect(history).toBeHidden();
    });

    await test.step('an unknown-size agent download over the cap is cancelled and its partial file removed', async () => {
      const click = await agent.click(tabId, { role: 'link', name: 'Download archive' });
      expect(click.ok, JSON.stringify(click.error)).toBe(true);
      const { notices, handled, poll } = agent.dialogLog(tabId, click);
      await expect.poll(async () => (await poll()).filter(dialog => dialog.message === 'archive.bin')).toEqual([expect.objectContaining({ kind: 'download', outcome: 'too-large', answerer: 'auto' })]);
      expect(handled.find(dialog => dialog.message === 'archive.bin')).not.toHaveProperty('files');
      expect(notices).toContainEqual(expect.stringMatching(/^Download of "archive\.bin" blocked: it passed .* and exceeds the 100 MB agent download limit set in Settings\./));
      expect(routes.streamedBytes()).toBeGreaterThan(DOWNLOAD_LIMIT);
      await expect.poll(() => readdir(agentDir)).toEqual(['report.csv']);

      const control = await app.controlSurface();
      await expect(control.locator('.control-records-badge')).toHaveText('1');
      await control.getByRole('button', { name: 'Handled page dialogs' }).click();
      const history = control.getByRole('dialog', { name: 'Page dialogs this session' });
      const record = history.getByRole('listitem').filter({ hasText: 'archive.bin' });
      await expect(record).toContainText('Blocked: size limit');
      await expect(record.getByRole('button')).toHaveCount(0);
      await app.snapshot('download-blocked-by-size-limit');
    });

    await test.step('a late download after control ends still goes to the agent, the user\'s own download offers Save As', async () => {
      const control = await app.controlSurface();
      model.releaseTurns();
      await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeHidden();
      const page = await app.page(candidate => candidate.startsWith(pages.url('downloads.html')), 'downloads fixture');
      const overlay = await app.overlay();
      const notice = overlay.getByRole('dialog', { name: 'Download saved' });

      await page.evaluate(() => document.getElementById('report')!.click());
      await expect.poll(() => readdir(agentDir)).toEqual(['report (1).csv', 'report.csv']);
      await expect(notice).toBeHidden();
      expect(await readdir(app.downloads)).toEqual([]);

      await page.getByRole('heading', { name: 'Monthly reports' }).click();
      await app.window.getByRole('button', { name: 'New tab' }).click();
      await overlay.getByRole('menuitem', { name: /^Browser/ }).click();
      const tabs = app.window.getByRole('tablist').getByRole('tab');
      await expect(tabs).toHaveCount(2);
      await expect(tabs.filter({ hasText: 'Monthly reports' })).toHaveAttribute('aria-selected', 'false');
      await page.evaluate(() => document.getElementById('own')!.click());
      await expect.poll(() => readdir(app.downloads)).toEqual(['own-report.csv']);
      expect(await readdir(agentDir)).toEqual(['report (1).csv', 'report.csv']);

      await tabs.filter({ hasText: 'Monthly reports' }).click();
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('own-report.csv');
      await expect(notice).toContainText(join(app.downloads, 'own-report.csv'));
      await expect(notice.locator('footer').getByRole('button', { name: 'Keep' })).toBeVisible();
      await app.snapshot('user-download-notice');

      const target = join(movedDir, 'own-report.csv');
      await answerNativeDialog(app, 'showSaveDialog', { canceled: false, filePath: target });
      await notice.locator('footer').getByRole('button', { name: 'Move…' }).click();
      await expect(notice).toBeHidden();
      await expect.poll(() => readdir(movedDir)).toEqual(['own-report.csv']);
      expect(await readdir(app.downloads)).toEqual([]);
    });

    await test.step('print is blocked under agent control and reaches the native print path after takeover', async () => {
      const nextAgent = await app.startAgentTurn('Print the receipt for the user.');
      const resumed = await nextAgent.run('browser.activate_tab', { tabId });
      expect(resumed.ok, JSON.stringify(resumed.error)).toBe(true);
      expect(resumed.handledDialogs ?? []).toEqual([]);
      const reminder = `- download "report.csv" from ${routes.origin}: saved by the app automatically (files: ${JSON.stringify(join(agentDir, 'report (1).csv'))}).`;
      await expect.poll(
        () => model.requests().some(request => request.messages.some(message => textOf(message.content).includes(reminder))),
        { message: 'waiting for the late agent download to be reported in the next turn reminder' },
      ).toBe(true);
      expect(model.requests().some(request => request.messages.some(message => textOf(message.content).includes('own-report.csv')))).toBe(false);

      const page = await app.page(candidate => candidate.startsWith(pages.url('downloads.html')), 'downloads fixture');
      const click = await nextAgent.click(tabId, { role: 'button', name: 'Print receipt' });
      expect(click.ok, JSON.stringify(click.error)).toBe(true);
      await expect(page.getByText('Print requested')).toBeVisible();
      const { notices, poll } = nextAgent.dialogLog(tabId, click);
      await expect.poll(async () => (await poll()).filter(dialog => dialog.kind === 'print')).toEqual([expect.objectContaining({ kind: 'print', origin: pages.origin })]);
      expect(notices).toContain('The page tried to open the print dialog. Printing is blocked while the browser tool controls the tab; ask the user to print if needed.');
      expect((await answeredNativeCalls(app)).filter(call => call.api === 'print')).toEqual([]);

      const control = await app.controlSurface();
      await expect(control.locator('.control-records-badge')).toHaveText('2');
      await control.getByRole('button', { name: 'Handled page dialogs' }).click();
      const history = control.getByRole('dialog', { name: 'Page dialogs this session' });
      await expect(history.getByRole('listitem')).toHaveCount(2);
      await expect(history.getByRole('listitem').filter({ hasText: 'report.csv' })).toContainText('Saved automatically');
      const printRecord = history.getByRole('listitem').filter({ hasText: 'Print' });
      await expect(printRecord).toContainText('Blocked');
      await expect(printRecord).toContainText(pages.origin);
      await app.snapshot('print-blocked-record');

      await control.getByRole('button', { name: 'Take over' }).click();
      await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeHidden();
      await answerNativeDialog(app, 'print', true);
      await page.getByRole('button', { name: 'Print receipt' }).click();
      await expect.poll(async () => (await answeredNativeCalls(app)).filter(call => call.api === 'print').map(call => call.detail)).toEqual([
        expect.stringContaining(`window.print() in isolated world`),
      ]);
    });
  } finally {
    await routes.close();
  }
});
