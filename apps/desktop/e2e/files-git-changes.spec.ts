import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { changedRows, diffRows, expect, git, lines, test } from './fixtures/files';
import { bash, call, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const GREET = lines('export const greet = (name: string): string => `Hi ${name}`;');
const PROMPT = 'Add a greeter, refresh the readme and drop the legacy file';
const DONE = 'Greeter added, readme refreshed, legacy file removed.';
const COMMIT_PROMPT = 'Commit everything';
const COMMIT_DONE = 'Committed all changes.';
const COMMIT_MESSAGE = 'Ship the greeter';
const GIT_FLAGS = '-c user.name=Kimi -c user.email=kimi@example.invalid -c commit.gpgsign=false -c core.hooksPath=/dev/null';

test.use({
  permissionMode: 'yolo',
  repoFiles: { 'README.md': lines('# Demo', 'Old intro line.'), 'legacy.txt': lines('one', 'two'), 'docs/guide.md': lines('# Guide'), 'src/index.ts': lines("export * from './greet';") },
});

test('the git Changes view tracks agent edits, external edits and a commit across list, tree and a relaunch', async ({ app, model }) => {
  const at = (path: string): string => join(app.workspace, path);
  const transcript = app.window.getByRole('list').first();
  const panel = () => app.window.getByRole('complementary', { name: 'Detail panel' });
  const row = (path: string) => panel().locator(`button[data-file-path="${path}"]`);
  const openChanges = () => app.window.keyboard.press('Control+Shift+G');

  await test.step('the agent adds, edits and deletes files in one turn', async () => {
    model.script(
      call('Write', { path: at('src/greet.ts'), content: GREET }),
      call('Edit', { path: at('README.md'), old_string: 'Old intro line.', new_string: 'New intro line.' }),
      bash('rm legacy.txt', { description: 'Drop the legacy file' }),
      say(DONE),
    );
    await app.startTurn(PROMPT);
    await expect(transcript.getByText(DONE, { exact: true })).toBeVisible();
    await expect(transcript.getByText('2 files changed', { exact: true })).toBeVisible();
    expect(git(app.workspace, 'status', '--porcelain', '--untracked-files=all').trimEnd().split('\n').toSorted()).toEqual([' D legacy.txt', ' M README.md', '?? src/greet.ts']);
    await expect(app.window.getByRole('complementary', { name: 'Session info' }).getByText('main', { exact: true })).toBeVisible();
  });

  await test.step('Ctrl+Shift+G lists every working tree change with its status', async () => {
    await app.window.getByRole('combobox', { name: 'Message input' }).click();
    await openChanges();
    await expect(panel().getByRole('tab', { name: 'Changes', selected: true })).toBeVisible();
    await expect(panel().getByRole('button', { name: 'Switch file tree root' })).toHaveText(basename(app.workspace));
    await expect(panel().getByText('3 files', { exact: true })).toBeVisible();
    await expect(panel().getByRole('tab', { name: 'List', selected: true })).toBeVisible();
    await expect(row('README.md')).toHaveText('MREADME.md');
    await expect(row('legacy.txt')).toHaveText('−legacy.txt');
    await expect(row('src/greet.ts')).toHaveText('+src/greet.ts');
    await app.snapshot('changes-list');
  });

  await test.step('the tree view groups files under folders that collapse', async () => {
    await panel().getByRole('tab', { name: 'Tree' }).click();
    await expect(panel().getByRole('tab', { name: 'Tree', selected: true })).toBeVisible();
    const folder = panel().getByRole('button', { name: 'src', exact: true });
    await expect(folder).toBeVisible();
    await expect(row('src/greet.ts')).toHaveText('+greet.ts');
    await app.snapshot('changes-tree');
    await folder.click();
    await expect(row('src/greet.ts')).toBeHidden();
    await expect(row('README.md')).toBeVisible();
    await folder.click();
    await expect(row('src/greet.ts')).toBeVisible();
  });

  await test.step('each change opens its diff and Back returns to the tree', async () => {
    await row('README.md').click();
    await expect.poll(async () => changedRows(await diffRows(panel()))).toEqual(['-Old intro line.', '+New intro line.']);
    await expect(panel().getByRole('button', { name: 'Open file' })).toBeVisible();
    await app.snapshot('changes-diff-modified');
    await panel().getByRole('button', { name: 'Back' }).click();
    await expect(panel().getByRole('tab', { name: 'Tree', selected: true })).toBeVisible();

    await row('legacy.txt').click();
    await expect.poll(async () => changedRows(await diffRows(panel()))).toEqual(['-one', '-two']);
    await expect(panel().getByRole('button', { name: 'Open file' })).toBeHidden();
    await panel().getByRole('button', { name: 'Back' }).click();

    await row('src/greet.ts').click();
    await expect.poll(async () => changedRows(await diffRows(panel()))).toEqual([`+${GREET.trimEnd()}`]);
    await panel().getByRole('button', { name: 'Back' }).click();
    await expect(row('src/greet.ts')).toBeVisible();
  });

  await test.step('a file written outside the app shows up when the view is refreshed', async () => {
    writeFileSync(at('docs/notes.txt'), lines('external note'));
    await expect(row('docs/notes.txt')).toHaveCount(0);
    await openChanges();
    await expect(row('docs/notes.txt')).toHaveText('+notes.txt');
    await expect(panel().getByText('4 files', { exact: true })).toBeVisible();
    await expect(panel().getByRole('button', { name: 'docs', exact: true })).toBeVisible();
    await app.snapshot('changes-external-file');
  });

  await test.step('committing everything through the agent leaves a clean working tree', async () => {
    model.script(bash(`git add -A && git ${GIT_FLAGS} commit -q -m "${COMMIT_MESSAGE}"`, { description: 'Commit all changes' }), say(COMMIT_DONE));
    await app.startTurn(COMMIT_PROMPT);
    await expect(transcript.getByText(COMMIT_DONE, { exact: true })).toBeVisible();
    await expect(panel().getByText('Working tree clean, no changes')).toBeVisible();
    await expect(panel().locator('button[data-file-path]')).toHaveCount(0);
    expect(git(app.workspace, 'status', '--porcelain')).toBe('');
    expect(git(app.workspace, 'log', '-1', '--format=%s').trim()).toBe(COMMIT_MESSAGE);
    expect(git(app.workspace, 'show', '--name-status', '--format=', 'HEAD').trimEnd().split('\n').toSorted())
      .toEqual(['A\tdocs/notes.txt', 'A\tsrc/greet.ts', 'D\tlegacy.txt', 'M\tREADME.md']);
    await app.snapshot('changes-clean');
  });

  await test.step('after a relaunch the Changes tab and the tree mode come back', async () => {
    const sessionUrl = app.window.url();
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
    if (app.window.url() !== sessionUrl) await sidebar.getByText(PROMPT).click();
    await expect(panel().getByRole('tab', { name: 'Changes', selected: true })).toBeVisible();
    await expect(panel().getByText('Working tree clean, no changes')).toBeVisible();
    writeFileSync(at('src/greet.ts'), lines('export const greet = (name: string): string => `Hello ${name}`;'));
    await app.window.getByRole('combobox', { name: 'Message input' }).click();
    await openChanges();
    await expect(panel().getByRole('tab', { name: 'Tree', selected: true })).toBeVisible();
    await expect(row('src/greet.ts')).toHaveText('Mgreet.ts');
    await expect(panel().getByText('1 file', { exact: true })).toBeVisible();
    await row('src/greet.ts').click();
    await expect.poll(async () => changedRows(await diffRows(panel()))).toEqual([
      '-export const greet = (name: string): string => `Hi ${name}`;',
      '+export const greet = (name: string): string => `Hello ${name}`;',
    ]);
    await app.snapshot('changes-after-relaunch');
  });
});
