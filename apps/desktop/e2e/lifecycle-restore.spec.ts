import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type DesktopApp } from './fixtures/app';
import { bash, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const WRITE = 'Write the release notes draft';
const WRITE_REPLY = 'Draft written to notes.md.';
const SECOND = 'Plan the next sprint';
const SECOND_REPLY = 'Sprint plan: fix flaky tests first.';
const WINDOW_SIZE = [1180, 820] as const;

test.use({ permissionMode: 'yolo' });

async function mainWindowSize(app: DesktopApp): Promise<number[]> {
  return app.electron.evaluate(({ BaseWindow }) => {
    const main = BaseWindow.getAllWindows().find(win => /^app:\/\/renderer\/(?!(browser-overlay|browser-control|screenshot|pin)\b)/.test((win as Electron.BrowserWindow).webContents?.getURL() ?? ''));
    return main?.getSize() ?? [];
  });
}

async function resizeMainWindow(app: DesktopApp, [width, height]: readonly [number, number]): Promise<void> {
  await app.electron.evaluate(({ BaseWindow }, size: { width: number; height: number }) => {
    const main = BaseWindow.getAllWindows().find(win => /^app:\/\/renderer\/(?!(browser-overlay|browser-control|screenshot|pin)\b)/.test((win as Electron.BrowserWindow).webContents?.getURL() ?? ''));
    main?.setSize(size.width, size.height);
  }, { width, height });
}

function panelTab(app: DesktopApp, name: string) {
  return app.window.getByRole('tab', { name, exact: true });
}

async function expectPinnedLayout(app: DesktopApp): Promise<void> {
  await expect(sidebarOf(app)).toMatchAriaSnapshot(`
    - text: Pinned
    - button "Collapse pinned"
    - text: /${WRITE}/
    - button "Collapse all projects"
    - text: /${SECOND}/
  `);
}

async function expectPanelRestored(app: DesktopApp): Promise<void> {
  await expect(panelTab(app, 'Changes')).toBeVisible();
  await expect(panelTab(app, 'notes.md')).toHaveAttribute('aria-selected', 'true');
  await expect(panelTab(app, 'Changes')).toHaveAttribute('aria-selected', 'false');
  await expect(app.window.getByText('Release notes draft', { exact: true }).last()).toBeVisible();
}

test('panel tabs, sidebar layout, pins and window size survive a relaunch and a renderer reload', async ({ app, model, scratch }) => {
  const sidebar = () => sidebarOf(app);
  const resizer = () => app.window.getByRole('separator', { name: 'Resize sidebar width' });
  let firstSession = '';
  let sidebarWidth = '';

  await test.step('a turn writes files into a git workspace', async () => {
    execFileSync('git', ['init', '-q'], { cwd: app.workspace });
    model.script(bash('printf "# Release notes draft\\n" > notes.md && mkdir -p src && printf "export const x = 1;\\n" > src/app.ts'), say(WRITE_REPLY));
    await app.startTurn(WRITE);
    await expect(app.window.getByRole('list').first().getByText(WRITE_REPLY, { exact: true })).toBeVisible();
    expect(await readFile(join(app.workspace, 'notes.md'), 'utf8')).toBe('# Release notes draft\n');
    firstSession = await app.sessionId();
  });

  await test.step('the right panel opens a Changes tab and a file tab', async () => {
    await app.window.getByRole('button', { name: 'Open right panel' }).first().click();
    await app.window.getByRole('button', { name: /^Changes/ }).last().click();
    await expect(panelTab(app, 'Changes')).toHaveAttribute('aria-selected', 'true');
    await expect(app.window.getByRole('button', { name: /^\+\W*src\/\W*$/ })).toBeVisible();
    await app.window.getByRole('button', { name: /^\+\W*notes\.md\W*$/ }).click();
    await expect(app.window.getByText('# Release notes draft').last()).toBeVisible();
    await app.window.getByRole('button', { name: 'Open file' }).click();
    await expectPanelRestored(app);
    await app.snapshot('panel-changes-and-file-tabs');
  });

  await test.step('a second session is created and the first one is pinned', async () => {
    await app.window.getByRole('button', { name: /^New Session/ }).click();
    model.script(say(SECOND_REPLY));
    await app.startTurn(SECOND);
    await expect(app.window.getByRole('list').first().getByText(SECOND_REPLY, { exact: true })).toBeVisible();
    await expect(panelTab(app, 'notes.md')).toBeHidden();
    const row = sidebar().getByText(WRITE, { exact: true });
    await row.hover();
    await sidebar().getByRole('button', { name: 'Pin', exact: true }).first().click();
    await expectPinnedLayout(app);
    await sidebar().getByText(WRITE, { exact: true }).first().click();
    await expect.poll(() => app.window.url()).toContain(firstSession);
    await expectPanelRestored(app);
  });

  await test.step('the sidebar is widened and collapsed and the window is resized', async () => {
    const before = Number(await resizer().getAttribute('aria-valuenow'));
    await resizer().focus();
    await app.window.keyboard.press('Shift+ArrowRight');
    await app.window.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => Number(await resizer().getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    sidebarWidth = (await resizer().getAttribute('aria-valuenow'))!;
    await app.snapshot('widened-sidebar-with-pin');
    await resizeMainWindow(app, WINDOW_SIZE);
    await expect.poll(() => mainWindowSize(app)).toEqual([...WINDOW_SIZE]);
    await app.window.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(app.window.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await expect(sidebar().getByText(SECOND, { exact: true })).toBeHidden();
    await app.snapshot('collapsed-sidebar');
  });

  await test.step('after a relaunch the window size and the collapsed sidebar are restored', async () => {
    await app.relaunch();
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    await expect(app.window.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    if (process.platform !== 'win32') {
      expect(await mainWindowSize(app)).toEqual([...WINDOW_SIZE]);
    }
    await app.window.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar().getByText(SECOND, { exact: true }).first()).toBeVisible();
    await expect(resizer()).toHaveAttribute('aria-valuenow', sidebarWidth);
    await expectPinnedLayout(app);
  });

  await test.step('the pinned session reopens with its panel tabs', async () => {
    await sidebar().getByText(WRITE, { exact: true }).first().click();
    await expect.poll(() => app.window.url()).toContain(firstSession);
    await expect(app.window.getByRole('list').first().getByText(WRITE_REPLY, { exact: true })).toBeVisible();
    await expectPanelRestored(app);
    await app.snapshot('restored-after-relaunch');
  });

  await test.step('a renderer reload keeps the session URL, the tabs and the layout', async () => {
    const url = app.window.url();
    await app.window.reload();
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    expect(app.window.url()).toBe(url);
    await expect(app.window.getByRole('list').first().getByText(WRITE_REPLY, { exact: true })).toBeVisible();
    await expectPanelRestored(app);
    await expect(resizer()).toHaveAttribute('aria-valuenow', sidebarWidth);
    await expectPinnedLayout(app);
    expect(model.agentRequests()).toBe(3);
    await app.snapshot('restored-after-reload');
  });
});
