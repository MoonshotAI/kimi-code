import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { captureClipboardWrites } from './fixtures/clipboard';
import { answerNativeDialog } from './fixtures/native-dialog';
import { chooseTabMenuItem, expect, lines, solidPng, test, writeTree } from './fixtures/files';
import { call, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';
import { recordOpenPath } from './fixtures/transcript';

const FILES = ['a.ts', 'b.ts', 'c.ts', 'notes.md', 'logo.png'];
const PROMPT = 'Point me at the project files';
const LINKS = `Start with ${FILES.map(name => `[${name.split('.')[0]}](${name})`).join(', ')}.`;
const EDIT_PROMPT = 'Bump the constant in a.ts';
const EDIT_DONE = 'Bumped a to 42.';

test.use({
  permissionMode: 'yolo',
  repoFiles: {
    'a.ts': lines('export const a = 1;'),
    'b.ts': lines('export const b = 2;'),
    'c.ts': lines('export const c = 3;'),
    'notes.md': lines('# Release notes', '', '- first item'),
    'logo.png': solidPng(900, 600),
  },
});

test('file tabs open from links, cycle, preview markdown and images, go stale, persist and close in bulk', async ({ app, model }) => {
  const panel = () => app.window.getByRole('complementary', { name: 'Detail panel' });
  const tabNames = () => panel().getByRole('tablist').first().getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')));
  const fileTabs = () => tabNames().then(names => names.filter(name => FILES.includes(name ?? '')));
  const openLink = (name: string) => app.window.getByRole('list').first().getByRole('button', { name: `Link: ${name}` }).click();

  await test.step('links in the reply open one File tab per file', async () => {
    model.script(say(LINKS));
    await app.startTurn(PROMPT);
    for (const name of FILES) {
      await openLink(name);
      await expect(panel().getByRole('tab', { name, selected: true })).toBeVisible();
    }
    await expect.poll(fileTabs).toEqual(FILES);
    await app.snapshot('five-file-tabs');
  });

  await test.step('an image previews fitted, then at its actual size', async () => {
    const image = panel().getByRole('img', { name: 'logo.png' });
    await expect(panel().getByRole('tab', { name: 'Fit', selected: true })).toBeVisible();
    await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(900);
    expect(await image.evaluate(img => img.getBoundingClientRect().width)).toBeLessThan(900);
    await panel().getByRole('tab', { name: 'Actual' }).click();
    await expect(panel().getByRole('tab', { name: 'Actual', selected: true })).toBeVisible();
    await expect.poll(() => image.evaluate(img => img.clientWidth)).toBe(900);
    await app.snapshot('image-actual-size');
  });

  await test.step('Ctrl+Tab and Ctrl+Shift+Tab cycle through the tabs', async () => {
    await app.window.getByRole('combobox', { name: 'Message input' }).click();
    await app.window.keyboard.press('Control+Tab');
    await expect(panel().getByRole('tab', { name: 'a.ts', selected: true })).toBeVisible();
    await app.window.keyboard.press('Control+Tab');
    await expect(panel().getByRole('tab', { name: 'b.ts', selected: true })).toBeVisible();
    await app.window.keyboard.press('Control+Shift+Tab');
    await app.window.keyboard.press('Control+Shift+Tab');
    await expect(panel().getByRole('tab', { name: 'logo.png', selected: true })).toBeVisible();
    await app.window.keyboard.press('Control+Shift+Tab');
    await expect(panel().getByRole('tab', { name: 'notes.md', selected: true })).toBeVisible();
  });

  await test.step('markdown switches between rendered preview and source', async () => {
    await expect(panel().getByRole('tab', { name: 'Preview', selected: true })).toBeVisible();
    await expect(panel().getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
    await expect(panel().getByRole('listitem').filter({ hasText: 'first item' })).toBeVisible();
    await panel().getByRole('tab', { name: 'Source' }).click();
    await expect(panel().getByRole('heading', { name: 'Release notes' })).toBeHidden();
    await expect(panel().getByText('# Release notes')).toBeVisible();
    await expect(panel().getByText('- first item')).toBeVisible();
    await app.snapshot('markdown-source');
  });

  await test.step('Copy path copies the absolute path of the previewed file', async () => {
    await panel().getByRole('tab', { name: 'a.ts' }).click();
    await expect(panel().getByText('export const a = 1;')).toBeVisible();
    const clipboardWrites = await captureClipboardWrites(app);
    await panel().getByRole('button', { name: 'Choose application' }).click();
    await app.window.getByRole('menuitem', { name: 'Copy path' }).click();
    if (process.platform === 'win32') {
      await expect.poll(clipboardWrites).toHaveLength(1);
    } else {
      await expect.poll(clipboardWrites).toEqual([join(app.workspace, 'a.ts')]);
    }
    await expect(app.window.getByRole('menuitem', { name: 'Copy path' })).toBeHidden();
  });

  await test.step('an agent edit marks the open preview stale until it is refreshed', async () => {
    const refresh = panel().getByRole('button', { name: 'Refresh' });
    await expect(refresh).toBeHidden();
    model.script(call('Edit', { path: join(app.workspace, 'a.ts'), old_string: '= 1;', new_string: '= 42;' }), say(EDIT_DONE));
    await app.startTurn(EDIT_PROMPT);
    await expect(app.window.getByRole('list').first().getByText(EDIT_DONE, { exact: true })).toBeVisible();
    expect(readFileSync(join(app.workspace, 'a.ts'), 'utf8')).toBe(lines('export const a = 42;'));
    await expect(refresh).toBeVisible();
    await expect(panel().getByText('export const a = 1;')).toBeVisible();
    await app.snapshot('preview-stale');
    await refresh.click();
    await expect(panel().getByText('export const a = 42;')).toBeVisible();
    await expect(refresh).toBeHidden();
  });

  await test.step('Shift+Mod+B hides the panel and brings back the same tabs', async () => {
    await app.window.getByRole('combobox', { name: 'Message input' }).click();
    await app.window.keyboard.press('Shift+ControlOrMeta+B');
    await expect(panel()).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'Open right panel' })).toBeVisible();
    await app.window.keyboard.press('Shift+ControlOrMeta+B');
    await expect(panel().getByRole('tab', { name: 'a.ts', selected: true })).toBeVisible();
    await expect.poll(fileTabs).toEqual(FILES);
  });

  await test.step('the tabs, their order and the active tab survive a relaunch', async () => {
    const sessionUrl = app.window.url();
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
    if (app.window.url() !== sessionUrl) await sidebar.getByText(PROMPT).click();
    await expect(panel().getByRole('tab', { name: 'a.ts', selected: true })).toBeVisible();
    await expect.poll(fileTabs).toEqual(FILES);
    await expect(panel().getByText('export const a = 42;')).toBeVisible();
    await app.snapshot('tabs-after-relaunch');
  });

  await test.step('the tab menu closes tabs to the right, other tabs and then all tabs', async () => {
    await chooseTabMenuItem(app, panel().getByRole('tab', { name: 'c.ts' }), 'Close Tabs to the Right');
    await expect.poll(fileTabs).toEqual(['a.ts', 'b.ts', 'c.ts']);
    await chooseTabMenuItem(app, panel().getByRole('tab', { name: 'b.ts' }), 'Close Other Tabs');
    await expect.poll(tabNames).toEqual(['b.ts']);
    await expect(panel().getByRole('tab', { name: 'b.ts', selected: true })).toBeVisible();
    await expect(panel().getByText('export const b = 2;')).toBeVisible();
    await openLink('notes.md');
    await expect.poll(tabNames).toEqual(['b.ts', 'notes.md']);
    await app.snapshot('two-tabs-left');
    await chooseTabMenuItem(app, panel().getByRole('tab', { name: 'b.ts' }), 'Close All Tabs');
    await expect(panel()).toBeHidden();
    await app.window.getByRole('button', { name: 'Open right panel' }).click();
    await expect(panel().getByRole('group', { name: 'Quick open' })).toBeVisible();
    await expect(panel().getByRole('tab')).toHaveCount(0);
    await app.snapshot('all-tabs-closed');
  });
});

test('Copy path copies the native absolute path of the previewed file', async ({ app, model }) => {
  const panel = app.window.getByRole('complementary', { name: 'Detail panel' });
  model.script(say('Start with [a](a.ts).'));
  await app.startTurn(PROMPT);
  await app.window.getByRole('list').first().getByRole('button', { name: 'Link: a.ts' }).click();
  await expect(panel.getByText('export const a = 1;')).toBeVisible();
  const clipboardWrites = await captureClipboardWrites(app);
  await panel.getByRole('button', { name: 'Choose application' }).click();
  await app.window.getByRole('menuitem', { name: 'Copy path' }).click();
  await expect.poll(clipboardWrites).toEqual([join(app.workspace, 'a.ts')]);
});

test('tilde links preview and open files from the OS home', async ({ app, model, scratch }) => {
  const home = join(scratch, 'os-home');
  const common = join(home, 'agent-workspace', 'rules', 'common.md');
  writeTree(home, {
    'agent-workspace/rules/common.md': lines('# Shared rules', '', '[Nested](~/agent-workspace/rules/nested.md)'),
    'agent-workspace/rules/nested.md': lines('# Nested rules'),
  });
  const panel = app.window.getByRole('complementary', { name: 'Detail panel' });
  model.script(say('Read [common.md](~/agent-workspace/rules/common.md).'));
  await app.startTurn(PROMPT);
  const link = app.window.locator('[data-mention-path="~/agent-workspace/rules/common.md"], [data-file-path="~/agent-workspace/rules/common.md"]');

  await link.click();
  const sharedRules = panel.getByRole('heading', { name: 'Shared rules', level: 1 });
  await expect(sharedRules.or(panel.getByText('Only files inside the current project can be previewed'))).toBeVisible();
  await app.snapshot('tilde-file-preview');
  await expect(sharedRules).toBeVisible();
  await panel.locator('[data-mention-path="~/agent-workspace/rules/nested.md"]').click();
  await expect(panel.getByRole('heading', { name: 'Nested rules', level: 1 })).toBeVisible();

  const openedPaths = await recordOpenPath(app);
  await answerNativeDialog(app, 'openPath', '');
  await link.click({ button: 'right' });
  await app.window.getByRole('menuitem', { name: 'Open with', exact: true }).click();
  await app.window.getByRole('menuitem', { name: 'Open in default app', exact: true }).click();
  await expect.poll(openedPaths).toEqual([common]);
});

test('Open in default app passes the native absolute path to the system opener', async ({ app, model }) => {
  const notes = join(app.workspace, 'notes.md');
  const panel = app.window.getByRole('complementary', { name: 'Detail panel' });
  model.script(say('Open [notes.md](notes.md).'));
  await app.startTurn(PROMPT);
  await app.window.getByRole('list').first().getByRole('button', { name: 'Link: notes.md' }).click();
  await expect(panel.getByRole('heading', { name: 'Release notes', level: 1 })).toBeVisible();
  const openedPaths = await recordOpenPath(app);
  const showTree = panel.getByRole('button', { name: 'Show file tree' });
  if (await showTree.isVisible()) await showTree.click();
  const noteRow = panel.locator('[data-file-path]').filter({ hasText: 'notes.md' }).first();
  await expect(noteRow).toBeVisible();
  await answerNativeDialog(app, 'openPath', '');
  await noteRow.click({ button: 'right' });
  await app.window.getByRole('menuitem', { name: 'Open with', exact: true }).click();
  await app.window.getByRole('menuitem', { name: 'Open in default app', exact: true }).click();
  await expect.poll(openedPaths).toEqual([notes]);
});
