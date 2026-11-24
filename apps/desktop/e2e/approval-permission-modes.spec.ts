import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { choosePermissionMode, permissionPill } from './fixtures/approvals';
import { bash, call, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

test.use({ permissionMode: 'manual' });

test('permission modes switch from the composer picker, change what asks, persist per session and the default only affects new sessions', async ({ app, model }) => {
  const transcript = app.window.getByRole('list').first();
  const runCommand = app.window.getByText('Run command?');
  let sessionA = '';

  await test.step('Always Ask asks before a routine command', async () => {
    model.script(bash('echo manual > manual.txt', { description: 'Routine write' }), say('Manual mode done.'));
    await app.startTurn('Write the manual marker');
    await expect(runCommand).toBeVisible();
    await app.window.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(transcript.getByText('Manual mode done.', { exact: true })).toBeVisible();
    await expect(permissionPill(app, 'Always Ask')).toBeVisible();
    expect(await readFile(join(app.workspace, 'manual.txt'), 'utf8')).toBe('manual\n');
    sessionA = await app.sessionId();
  });

  await test.step('Never Ask from the overlay picker runs commands, writes and even risky commands without a card', async () => {
    await mkdir(join(app.workspace, 'build-cache'));
    await choosePermissionMode(app, 'Always Ask', 'Never Ask', 'permission-menu-open');
    model.script(
      bash('echo never > never.txt', { description: 'Routine write' }),
      call('Write', { path: 'never-write.md', content: 'written without asking\n' }),
      bash('rm -rf build-cache', { description: 'Clear the cache' }),
      say('Never Ask done.'),
    );
    const before = model.requests().length;
    await app.startTurn('Do everything without asking');
    await expect(transcript.getByText('Never Ask done.', { exact: true })).toBeVisible();
    await expect(runCommand).toHaveCount(0);
    await expect(app.window.getByText('Write file?')).toHaveCount(0);
    expect(model.requests()).toHaveLength(before + 4);
    expect(await readFile(join(app.workspace, 'never.txt'), 'utf8')).toBe('never\n');
    expect(await readFile(join(app.workspace, 'never-write.md'), 'utf8')).toBe('written without asking\n');
    expect(existsSync(join(app.workspace, 'build-cache'))).toBe(false);
    await app.snapshot('never-ask-ran-everything');
  });

  await test.step('Ask When Needed runs routine commands but stops a risky one, which can be rejected', async () => {
    await mkdir(join(app.workspace, 'keep-cache'));
    await choosePermissionMode(app, 'Never Ask', 'Ask When Needed');
    model.script(
      bash('echo routine > routine.txt', { description: 'Routine write' }),
      call('Write', { path: 'routine-write.md', content: 'routine\n' }),
      bash('rm -rf keep-cache', { description: 'Clear the cache' }),
      say('Risky command was rejected.'),
    );
    const before = model.requests().length;
    await app.startTurn('Do routine work, then clear the cache');
    await expect(runCommand).toBeVisible();
    await expect(app.window.getByText(/Danger: rm -rf/)).toBeVisible();
    expect(model.requests()).toHaveLength(before + 3);
    expect(await readFile(join(app.workspace, 'routine.txt'), 'utf8')).toBe('routine\n');
    expect(await readFile(join(app.workspace, 'routine-write.md'), 'utf8')).toBe('routine\n');
    await app.snapshot('ask-when-needed-risky-command');
    await app.window.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(transcript.getByText('Risky command was rejected.', { exact: true })).toBeVisible();
    expect(existsSync(join(app.workspace, 'keep-cache'))).toBe(true);
  });

  await test.step('the session keeps Ask When Needed across a relaunch', async () => {
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText('Write the manual marker')).toBeVisible({ timeout: 30_000 });
    if (!app.window.url().includes(sessionA)) await sidebar.getByText('Write the manual marker').click();
    await expect.poll(() => app.window.url()).toContain(sessionA);
    await expect(app.window.getByRole('list').first().getByText('Risky command was rejected.', { exact: true })).toBeVisible();
    await expect(permissionPill(app, 'Ask When Needed')).toBeVisible();
    await app.snapshot('mode-restored-after-relaunch');
  });

  await test.step('Settings default permission changes the config but not the existing session', async () => {
    await app.window.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = app.window.getByRole('dialog');
    await dialog.getByText('Agent & Sessions', { exact: true }).click();
    await expect(dialog.getByText('Only affects newly-created sessions')).toBeVisible();
    const row = dialog.locator('.row').filter({ hasText: 'Default permission' });
    await expect(row.getByRole('tab', { name: 'Always Ask' })).toHaveAttribute('aria-selected', 'true');
    await row.getByRole('tab', { name: 'Never Ask' }).click();
    await expect(row.getByRole('tab', { name: 'Never Ask' })).toHaveAttribute('aria-selected', 'true');
    await app.snapshot('settings-default-permission');
    await app.window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(permissionPill(app, 'Ask When Needed')).toBeVisible();
  });

  await test.step('a new session starts in the new default and runs a command without asking', async () => {
    await app.window.getByRole('button', { name: 'New Session' }).first().click();
    await expect.poll(() => app.window.url()).not.toContain(sessionA);
    await expect(permissionPill(app, 'Never Ask')).toBeVisible();
    model.script(bash('echo fresh > fresh.txt', { description: 'Routine write' }), say('Fresh session done.'));
    await app.startTurn('Write the fresh marker');
    await expect(app.window.getByRole('list').first().getByText('Fresh session done.', { exact: true })).toBeVisible();
    await expect(app.window.getByText('Run command?')).toHaveCount(0);
    const sessionB = await app.sessionId();
    expect(sessionB).not.toBe(sessionA);
    expect(await readFile(join(app.workspace, 'fresh.txt'), 'utf8')).toBe('fresh\n');
    await app.snapshot('new-session-uses-default');
    await sidebarOf(app).getByText('Write the manual marker').click();
    await expect.poll(() => app.window.url()).toContain(sessionA);
    await expect(permissionPill(app, 'Ask When Needed')).toBeVisible();
  });
});
