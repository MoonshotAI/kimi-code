import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from './fixtures/app';
import {
  activeScreen,
  expectTerminalText,
  runInTerminal,
  shellCommands as sh,
  shellEnv,
  shellName,
  sleepBinary,
  terminalPanel,
  terminalTabs,
  terminalText,
  test,
  waitForPrompt,
} from './fixtures/terminal';

const NOTE = 'term-note.txt';

test.use({ appEnv: shellEnv });

test('the terminal panel runs commands in tabs, guards running programs and keeps its height across a relaunch', async ({ app }) => {
  const window = app.window;
  const panel = terminalPanel(window);
  const tabs = terminalTabs(window);

  await test.step('Ctrl+` opens the panel with a shell in the workspace', async () => {
    await window.getByRole('combobox', { name: 'Message input' }).click();
    await window.keyboard.press('Control+Backquote');
    await expect(panel).toBeVisible();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await tabs.first().hover();
    await expect(window.getByRole('tooltip')).toHaveText(app.workspace);
    await waitForPrompt(window);
    await expect(tabs.first()).toHaveText(shellName);
  });

  await test.step('commands echo, print the workspace and write a file', async () => {
    await runInTerminal(window, sh.echo('hello-from-tab-one'));
    await expectTerminalText(window, /^hello-from-tab-one$/m);
    await runInTerminal(window, sh.pwd);
    await expectTerminalText(window, new RegExp(`^${app.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    await runInTerminal(window, sh.writeFile(NOTE, 'written by the terminal'));
    await expect.poll(() => readFile(join(app.workspace, NOTE), 'utf8').catch(() => null)).toBe('written by the terminal');
    await app.snapshot('first-tab-output');
  });

  await test.step('a second tab has its own shell and output', async () => {
    await panel.getByRole('button', { name: 'New terminal' }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await waitForPrompt(window);
    expect(await terminalText(window)).not.toContain('hello-from-tab-one');
    await runInTerminal(window, sh.echo('hello-from-tab-two'));
    await expectTerminalText(window, /^hello-from-tab-two$/m);
    await app.snapshot('second-tab');
  });

  await test.step('switching tabs shows each tab its own output', async () => {
    await tabs.first().click();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expectTerminalText(window, /^hello-from-tab-one$/m);
    expect(await terminalText(window)).not.toContain('hello-from-tab-two');
    await tabs.nth(1).click();
    await expectTerminalText(window, /^hello-from-tab-two$/m);
    expect(await terminalText(window)).not.toContain('hello-from-tab-one');
  });

  await test.step('an exited shell can be restarted with a clean screen', async () => {
    const restart = panel.getByRole('button', { name: 'Restart terminal' });
    await expect(restart).toBeHidden();
    await runInTerminal(window, sh.exit);
    await expectTerminalText(window, '[process exited with code 0]');
    await expect(restart).toBeVisible();
    await app.snapshot('second-tab-exited');
    await restart.click();
    await expect(restart).toBeHidden();
    await expect.poll(() => terminalText(window)).not.toContain('hello-from-tab-two');
    await waitForPrompt(window);
    await runInTerminal(window, sh.echo('after-restart'));
    await expectTerminalText(window, /^after-restart$/m);
    await expect(tabs).toHaveCount(2);
  });

  await test.step('closing a tab with a running program asks first', async () => {
    await runInTerminal(window, sh.sleep(300));
    const closeButtons = panel.getByRole('button', { name: 'Close terminal' });
    const dialog = window.getByRole('alertdialog').or(window.getByRole('dialog')).filter({ hasText: 'Close running terminals?' });
    await expect(tabs.nth(1)).toHaveText(sleepBinary);
    await closeButtons.nth(1).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(sleepBinary);
    await app.snapshot('close-guard');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(tabs).toHaveCount(2);
    await closeButtons.nth(1).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Terminate and close' }).click();
    await expect(dialog).toBeHidden();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expectTerminalText(window, /^hello-from-tab-one$/m);
  });

  await test.step('the panel resizes from the keyboard and collapses without losing the shell', async () => {
    const handle = window.getByRole('separator', { name: 'Resize terminal panel height' });
    const before = Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();
    await window.keyboard.press('ArrowUp');
    await window.keyboard.press('ArrowUp');
    await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
    await app.snapshot('resized');

    await panel.getByRole('button', { name: 'Collapse terminal panel' }).click();
    await expect(panel).toBeHidden();
    await window.getByRole('combobox', { name: 'Message input' }).click();
    await window.keyboard.press('Control+Backquote');
    await expect(panel).toBeVisible();
    await expect(tabs).toHaveCount(1);
    await expectTerminalText(window, /^hello-from-tab-one$/m);
    await runInTerminal(window, sh.echo('still-alive'));
    await expectTerminalText(window, /^still-alive$/m);
  });

  await test.step('after a relaunch the panel starts closed, keeps its height and opens a fresh shell', async () => {
    const height = await window.getByRole('separator', { name: 'Resize terminal panel height' }).getAttribute('aria-valuenow');
    await app.relaunch();
    const restored = app.window;
    await expect(restored.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    await expect(terminalPanel(restored)).toBeHidden();
    await restored.getByRole('combobox', { name: 'Message input' }).click();
    await restored.keyboard.press('Control+Backquote');
    await expect(terminalPanel(restored)).toBeVisible();
    await expect(terminalTabs(restored)).toHaveCount(1);
    await expect(restored.getByRole('separator', { name: 'Resize terminal panel height' })).toHaveAttribute('aria-valuenow', height!);
    await waitForPrompt(restored);
    expect(await terminalText(restored)).not.toContain('hello-from-tab-one');
    await expect(activeScreen(restored)).toBeVisible();
    await runInTerminal(restored, `cat ${NOTE}`);
    await expectTerminalText(restored, 'written by the terminal');
    await app.snapshot('after-relaunch');
  });
});
