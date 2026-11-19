import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { answerNativeDialog } from './fixtures/native-dialog';
import { createProject } from './fixtures/project';
import { expectOrder, relaunchAndSettle, sendAndFinish, sidebarOf, transcriptOf } from './fixtures/sessions';

const FIRST = 'Sketch the public API';
const SECOND = 'Wire the storage layer';
const RENAMED = 'Backend service';

test('a second workspace is added through the project dialog, organised in the sidebar, survives a relaunch and can be removed and re-added', async ({ app, model, scratch }) => {
  const project = join(scratch, 'second-project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# second project\n');
  const group = (name: string) => sidebarOf(app).locator('[data-ws-id]').filter({ has: app.window.getByText(name, { exact: true }) });
  const collapsed = (name: string) => group(name).locator('[inert]');
  const groups = () => sidebarOf(app).locator('[data-ws-id]');
  let firstSession = '';
  let secondSession = '';

  await test.step('start a session in the seeded workspace', async () => {
    firstSession = await sendAndFinish(app, model, FIRST, 'First reply.');
    await expect(group('workspace').getByText(FIRST)).toBeVisible();
    await expect(groups()).toHaveCount(1);
  });

  await test.step('an invalid folder is rejected in the project dialog before the real folder is added', async () => {
    await answerNativeDialog(app, 'showOpenDialog', { canceled: false, filePaths: [join(scratch, 'missing-folder')] });
    await app.window.keyboard.press('ControlOrMeta+o');
    const dialog = app.window.getByRole('dialog', { name: 'New project' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Click to add folders you can read and write' }).click();
    await expect(dialog.getByRole('textbox')).toHaveValue('missing-folder');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(groups()).toHaveCount(1);

    await answerNativeDialog(app, 'showOpenDialog', { canceled: false, filePaths: [project] });
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await dialog.getByRole('button', { name: 'Click to add folders you can read and write' }).click();
    await expect(dialog.getByRole('textbox')).toHaveValue('second-project');
    await app.snapshot('new-project-dialog');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(group('second-project')).toBeVisible();
    await app.trustWorkspace();
    await expect(groups()).toHaveCount(2);
  });

  await test.step('New session in this project starts a session rooted in the new folder', async () => {
    const header = group('second-project');
    await header.getByText('second-project', { exact: true }).hover();
    await header.getByRole('button', { name: 'New session in this project' }).click();
    await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
    secondSession = await sendAndFinish(app, model, SECOND, 'Second reply.');
    await expect(group('second-project').getByText(SECOND)).toBeVisible();
    await expect(group('workspace').getByText(SECOND)).toHaveCount(0);
    expect(model.request(1).texts('system').join('\n')).toContain(project);
    expect(model.request(0).texts('system').join('\n')).not.toContain(project);
    await app.snapshot('two-workspaces');
  });

  await test.step('switch between the flat list and grouping, and between manual and recent-activity order', async () => {
    const options = sidebarOf(app).getByRole('button', { name: 'List options' });
    await options.click();
    await app.window.getByRole('menuitem', { name: 'Flat list' }).click();
    await expect(group('workspace')).toHaveCount(0);
    await expectOrder(sidebarOf(app), [SECOND, 'second-project', FIRST, 'workspace']);
    await app.snapshot('flat-list');

    await options.click();
    await app.window.getByRole('menuitem', { name: 'Group by project' }).click();
    await expect(group('workspace')).toBeVisible();
    await options.click();
    await app.window.getByRole('menuitem', { name: 'Recent activity' }).click();
    await expectOrder(sidebarOf(app), ['second-project', SECOND, 'workspace', FIRST]);

    await sidebarOf(app).getByText(FIRST).click();
    await expect.poll(() => app.sessionId()).toBe(firstSession);
    await sendAndFinish(app, model, 'Add pagination to the API', 'Pagination reply.');
    await expectOrder(sidebarOf(app), ['workspace', FIRST, 'second-project', SECOND]);
  });

  await test.step('rename the new workspace from its menu', async () => {
    await group('second-project').getByRole('button', { name: 'Options' }).click({ force: true });
    await app.window.getByRole('menuitem', { name: 'Rename' }).click();
    const input = sidebarOf(app).getByRole('textbox');
    await expect(input).toHaveValue('second-project');
    await input.fill(RENAMED);
    await input.press('Enter');
    await expect(group(RENAMED)).toBeVisible();
    await expect(sidebarOf(app).getByText('second-project', { exact: true })).toHaveCount(0);
  });

  await test.step('collapse and expand all projects, then leave one collapsed', async () => {
    await sidebarOf(app).getByRole('button', { name: 'Collapse all projects' }).click();
    await expect(collapsed('workspace')).toContainText(FIRST);
    await expect(collapsed(RENAMED)).toContainText(SECOND);
    await app.snapshot('collapsed-all');
    await sidebarOf(app).getByRole('button', { name: 'Expand all projects' }).click();
    await expect(collapsed('workspace')).toHaveCount(0);
    await expect(collapsed(RENAMED)).toHaveCount(0);
    await expect(sidebarOf(app).getByRole('button', { name: 'Collapse all projects' })).toBeVisible();

    await group(RENAMED).getByText(RENAMED, { exact: true }).click();
    await expect(collapsed(RENAMED)).toContainText(SECOND);
    await expect(collapsed('workspace')).toHaveCount(0);
  });

  await test.step('grouping, order, names and the collapsed group survive a relaunch, which reopens the most recent session', async () => {
    await group(RENAMED).getByText(RENAMED, { exact: true }).click();
    await sidebarOf(app).getByText(SECOND).click();
    await expect.poll(() => app.sessionId()).toBe(secondSession);
    await group(RENAMED).getByText(RENAMED, { exact: true }).click();
    await expect(collapsed(RENAMED)).toContainText(SECOND);
    await relaunchAndSettle(app);
    await expect(group(RENAMED)).toBeVisible({ timeout: 30_000 });
    await expectOrder(sidebarOf(app), ['workspace', FIRST, RENAMED]);
    await expect(collapsed(RENAMED)).toContainText(SECOND);
    await expect(collapsed('workspace')).toHaveCount(0);
    await expect.poll(() => app.sessionId()).toBe(firstSession);
    await expect(transcriptOf(app).getByText('Pagination reply.', { exact: true })).toBeVisible();
    await app.snapshot('after-relaunch');
  });

  await test.step('remove the project and add its folder again', async () => {
    await group(RENAMED).getByRole('button', { name: 'Options' }).click({ force: true });
    await app.window.getByRole('menuitem', { name: 'Remove project' }).click();
    const confirm = app.window.getByRole('dialog').filter({ hasText: `Remove "${RENAMED}" from the sidebar?` });
    await expect(confirm).toContainText('its sessions cannot be recovered');
    await app.snapshot('remove-workspace-confirm');
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(group(RENAMED)).toHaveCount(0);
    await expect(sidebarOf(app).getByText(SECOND)).toHaveCount(0);
    await expect(groups()).toHaveCount(1);

    await createProject(app, project);
    await expect(group('second-project')).toBeVisible();
    await expect(groups()).toHaveCount(2);
    await app.snapshot('workspace-re-added');
  });
});

test('every restored turn keeps its message timestamps', async ({ app, model }) => {
  await sendAndFinish(app, model, FIRST, 'First reply.');
  await sendAndFinish(app, model, SECOND, 'Second reply.');
  await expect(transcriptOf(app).getByText(/^\d\d:\d\d$/)).toHaveCount(4);
  await relaunchAndSettle(app);
  await expect(transcriptOf(app).getByText('Second reply.', { exact: true })).toBeVisible();
  await expect(transcriptOf(app).getByText(/^\d\d:\d\d$/)).toHaveCount(4);
});
