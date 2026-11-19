import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { changedRows, diffRows, expect, lines, test } from './fixtures/files';
import { bash, call, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const README = lines('# Demo', '', 'Old intro line.', 'Keep me.');
const LEGACY = lines('one', 'two', 'three');
const GREET = lines('export function greet(name: string): string {', '  return `Hello, ${name}!`;', '}');
const P1 = 'Add a greeter and refresh the readme intro';
const P2 = 'Retire the legacy file';
const DONE1 = 'Added the greeter and updated the intro.';
const DONE2 = 'Removed legacy.txt.';

test.use({ permissionMode: 'yolo', repoFiles: { 'README.md': README, 'legacy.txt': LEGACY } });

test('per-turn file changes are summarised, diffed, opened, survive a relaunch and outlive an undo', async ({ app, model }) => {
  const at = (path: string): string => join(app.workspace, path);
  const transcript = app.window.getByRole('list').first();
  const panel = app.window.getByRole('complementary', { name: 'Detail panel' });

  await test.step('turn one writes a new file and edits the readme', async () => {
    model.script(
      call('Write', { path: at('src/greet.ts'), content: GREET }),
      call('Edit', { path: at('README.md'), old_string: 'Old intro line.', new_string: 'New intro line.\nSecond intro line.' }),
      say(DONE1),
    );
    await app.startTurn(P1);
    await expect(transcript.getByText(DONE1, { exact: true })).toBeVisible();
    const card = transcript.locator('.turn-files').filter({ hasText: '2 files changed' });
    await expect(card).toBeVisible();
    await expect(card.getByText('+5', { exact: true }).first()).toBeVisible();
    const readmeButton = card.getByRole('button', { name: 'README.md' });
    await expect(readmeButton).toBeVisible();
    await readmeButton.hover();
    await expect(readmeButton.locator('.tf-base')).toHaveCSS('text-decoration-line', 'underline');
    await expect(card.getByRole('listitem').filter({ hasText: 'README.md' })).toContainText('+2−1');
    const greetRow = card.getByRole('listitem').filter({ hasText: 'greet.ts' });
    await expect(greetRow.locator('.tf-base')).toHaveText('greet.ts');
    await expect(greetRow.locator('.tf-dir')).toHaveText('src');
    await expect(greetRow).toContainText('+3');
    await greetRow.locator('.tf-file').hover();
    await expect(greetRow.locator('.tf-base')).toHaveCSS('text-decoration-line', 'underline');
    await expect(greetRow.locator('.tf-dir')).toHaveCSS('text-decoration-line', 'underline');
    await card.locator('.tf-title').hover();
    await app.snapshot('turn-one-summary');

    expect(readFileSync(at('src/greet.ts'), 'utf8')).toBe(GREET);
    expect(readFileSync(at('README.md'), 'utf8')).toBe(lines('# Demo', '', 'New intro line.', 'Second intro line.', 'Keep me.'));
  });

  await test.step('turn two edits and then removes the legacy file', async () => {
    model.script(
      call('Edit', { path: at('legacy.txt'), old_string: 'two', new_string: 'TWO' }),
      bash('rm legacy.txt', { description: 'Remove legacy file' }),
      say(DONE2),
    );
    await app.startTurn(P2);
    await expect(transcript.getByText(DONE2, { exact: true })).toBeVisible();
    const card = transcript.locator('.turn-files').filter({ hasText: '1 file changed' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: 'legacy.txt' })).toContainText('−3');
    await expect(transcript.locator('.turn-files')).toHaveCount(2);
    expect(existsSync(at('legacy.txt'))).toBe(false);
    await app.snapshot('turn-two-summary');
  });

  await test.step('the readme row opens a Turn Diff tab with the exact line changes', async () => {
    await transcript.locator('.turn-files').filter({ hasText: '2 files changed' }).getByRole('button', { name: 'README.md' }).click();
    await expect(panel.getByRole('tab', { name: 'Turn Diff', selected: true })).toBeVisible();
    await expect(panel.locator('[data-file-path="README.md"]')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Open file' })).toBeVisible();
    await expect.poll(async () => changedRows(await diffRows(panel))).toEqual(['-Old intro line.', '+New intro line.', '+Second intro line.']);
    expect((await diffRows(panel)).map(row => row.text)).toEqual(expect.arrayContaining(['# Demo', 'Keep me.']));
    await app.snapshot('turn-diff-readme');
  });

  await test.step('the deleted file diff lists every removed line', async () => {
    await transcript.locator('.turn-files').filter({ hasText: '1 file changed' }).getByRole('button', { name: 'legacy.txt' }).click();
    await expect(panel.locator('[data-file-path="legacy.txt"]')).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'Turn Diff' })).toHaveCount(1);
    await expect.poll(async () => changedRows(await diffRows(panel))).toEqual(['-one', '-two', '-three']);
    await app.snapshot('turn-diff-deleted');
  });

  await test.step('Open file shows the new file content in a File tab', async () => {
    await transcript.locator('.turn-files').filter({ hasText: '2 files changed' }).getByRole('button', { name: 'src/greet.ts' }).click();
    await expect.poll(async () => changedRows(await diffRows(panel))).toEqual(GREET.trimEnd().split('\n').map(row => `+${row}`));
    await panel.getByRole('button', { name: 'Open file' }).click();
    await expect(panel.getByRole('tab', { name: 'greet.ts', selected: true })).toBeVisible();
    await expect(panel.getByText('return `Hello, ${name}!`;')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Open file' })).toBeHidden();
    await app.snapshot('file-tab-greet');
  });

  await test.step('summaries and the open file survive a relaunch', async () => {
    const sessionUrl = app.window.url();
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(P1)).toBeVisible({ timeout: 30_000 });
    if (app.window.url() !== sessionUrl) await sidebar.getByText(P1).click();
    const restored = app.window.getByRole('list').first();
    await expect(restored.getByText(DONE2, { exact: true })).toBeVisible();
    await expect(restored.locator('.turn-files').filter({ hasText: '2 files changed' })).toBeVisible();
    await expect(restored.locator('.turn-files').filter({ hasText: '1 file changed' })).toBeVisible();
    const restoredPanel = app.window.getByRole('complementary', { name: 'Detail panel' });
    await expect(restoredPanel.getByRole('tab', { name: 'greet.ts', selected: true })).toBeVisible();
    await expect(restoredPanel.getByText('return `Hello, ${name}!`;')).toBeVisible();
    await app.snapshot('restored-after-relaunch');
  });

  await test.step('undoing the second message puts it back in the composer and leaves the files alone', async () => {
    const list = app.window.getByRole('list').first();
    await list.getByRole('listitem').filter({ hasText: P2 }).first().hover();
    await list.getByRole('listitem').filter({ hasText: P2 }).first().getByRole('button', { name: 'Undo message' }).click();
    const dialog = app.window.getByRole('dialog', { name: 'Undo' });
    await expect(dialog).toContainText('File and code changes are not affected.');
    await app.snapshot('undo-confirm');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toBeHidden();
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toHaveText(P2);
    await expect(list.getByText(DONE2, { exact: true })).toBeHidden();
    await expect(list.locator('.turn-files')).toHaveCount(1);
    await expect(list.getByText(DONE1, { exact: true })).toBeVisible();
    await expect(list.getByRole('listitem').filter({ hasText: P2 })).toHaveCount(0);
    expect(existsSync(at('legacy.txt'))).toBe(false);
    expect(readFileSync(at('src/greet.ts'), 'utf8')).toBe(GREET);
    await app.snapshot('undone-second-turn');
  });

  await test.step('/undo removes the first message too without touching the workspace', async () => {
    const composer = app.window.getByRole('combobox', { name: 'Message input' });
    await composer.click();
    await app.window.keyboard.press('ControlOrMeta+a');
    await app.window.keyboard.press('Backspace');
    await app.window.keyboard.type('/undo');
    await app.window.keyboard.press('Enter');
    const list = app.window.getByRole('list').first();
    await expect(list.getByText(DONE1, { exact: true })).toBeHidden();
    await expect(list.locator('.turn-files')).toHaveCount(0);
    await expect(composer).toHaveText('');
    await expect(list.getByRole('listitem').filter({ hasText: P1 })).toHaveCount(0);
    expect(readFileSync(at('src/greet.ts'), 'utf8')).toBe(GREET);
    expect(readFileSync(at('README.md'), 'utf8')).toContain('New intro line.');
    expect(existsSync(at('legacy.txt'))).toBe(false);
    expect(model.requests()).toHaveLength(6);
    await app.snapshot('undone-first-turn');
  });
});
