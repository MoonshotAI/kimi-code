import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { held, say } from '@moonshot-ai/testkit/model';

import { expect, test, testWithProvider } from './fixtures/app';
import { answerNativeDialog } from './fixtures/native-dialog';
import { createProject } from './fixtures/project';
import { sidebarOf } from './fixtures/sessions';

const PROMPT = 'Say hello';
const REPLY = ['Hello from ', 'the stub ', 'model, ', 'streamed in ', 'four chunks.'];
const FULL_REPLY = REPLY.join('');

test.use({ seedWorkspace: false });

testWithProvider('[L0:desktop.first-turn] a first turn in a new workspace streams, finishes and survives a relaunch', { tag: '@smoke' }, async ({ app, provider }) => {
  await createProject(app);
  const sidebar = sidebarOf(app);
  await expect(sidebar.getByText('workspace', { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'New project', exact: true })).toBeHidden();
  await app.trustWorkspace();

  provider.script(held('first-chunk', say(REPLY), 1));
  await app.window.getByRole('combobox', { name: 'Message input' }).click();
  await app.window.keyboard.type(PROMPT);
  await app.window.keyboard.press('Enter');
  await expect(app.window.getByRole('combobox', { name: 'Message input' }).getByRole('paragraph')).toHaveText(['']);
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(PROMPT, { exact: true })).toBeVisible();
  await expect(transcript.getByText(REPLY[0]!.trim(), { exact: true })).toBeVisible();
  await expect(app.window.getByRole('status').filter({ hasText: 'Working…' })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
  await expect(sidebar.getByText(PROMPT)).toBeVisible();
  await expect(sidebar.getByRole('status', { name: 'Loading' })).toBeVisible();
  await app.snapshot('streaming-held');

  provider.hold('first-chunk').release();
  await expect(transcript.getByText(FULL_REPLY, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('status').filter({ hasText: 'Working…' })).toBeHidden();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  await expect(sidebar.getByRole('status', { name: 'Loading' })).toBeHidden();
  await expect(sidebar.getByText(PROMPT)).toBeVisible();
  const sessionUrl = app.window.url();
  expect(sessionUrl).toMatch(/\/sessions\/[^/?#]+/);
  expect(provider.requests('main')).toHaveLength(1);
  await app.snapshot('turn-finished');

  const composer = app.window.getByRole('combobox', { name: 'Message input' });
  await composer.fill('My next question');
  await expect(composer).toHaveText('My next question');
  await composer.fill('');

  await app.relaunch();
  const restoredSidebar = sidebarOf(app);
  await expect(restoredSidebar.getByText('workspace', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(restoredSidebar.getByText(PROMPT)).toBeVisible();
  if (app.window.url() !== sessionUrl) await restoredSidebar.getByText(PROMPT).click();
  await expect.poll(() => app.window.url()).toBe(sessionUrl);
  const restored = app.window.getByRole('list').first();
  await expect(restored.getByText(PROMPT, { exact: true })).toBeVisible();
  await expect(restored.getByText(FULL_REPLY, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  expect(provider.requests('main')).toHaveLength(1);
  await app.snapshot('restored-after-relaunch');
});

test('a prompt submitted before the first project survives project creation and is sent after trust', async ({ app, model }) => {
  model.queueReply(['First project ready.']);
  const composer = app.window.getByRole('combobox', { name: 'Message input' });
  await composer.click();
  await app.window.keyboard.type(PROMPT);
  await app.window.getByRole('button', { name: 'Send ↵', exact: true }).click();
  const required = app.window.getByRole('dialog').filter({ hasText: 'Choose a workspace first' });
  await expect(required).toBeVisible();
  await expect(composer.getByRole('paragraph')).toHaveText([PROMPT]);
  await required.getByRole('button', { name: 'New project', exact: true }).click();

  await answerNativeDialog(app, 'showOpenDialog', { canceled: false, filePaths: [app.workspace] });
  const dialog = app.window.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('button', { name: 'Click to add folders you can read and write' }).click();
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();

  const input = app.window.getByRole('combobox', { name: 'Message input' });
  await expect(input.getByRole('paragraph')).toHaveText([PROMPT]);
  await app.trustWorkspace();
  await input.click();
  await app.window.keyboard.press('Enter');

  const request = await model.waitForRequest(0);
  expect(request.userTextsSinceReply).toEqual([PROMPT]);
  await expect(app.window.getByRole('list').first().getByText(PROMPT, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('list').first().getByText('First project ready.', { exact: true })).toBeVisible();
  await expect(input.getByRole('paragraph')).toHaveText(['']);
});

test('a prompt survives dismissing the sign-in prompt before the first session', async ({ app, scratch }) => {
  await writeFile(join(scratch, 'home', 'config.toml'), '');
  await app.relaunch();

  const input = app.window.getByRole('combobox', { name: 'Message input' });
  await input.click();
  await app.window.keyboard.type(PROMPT);
  await app.window.getByRole('button', { name: 'Send ↵', exact: true }).dblclick();
  const required = app.window.getByRole('dialog').filter({ hasText: 'Sign in required' });
  await expect(required).toBeVisible();
  await expect(input.getByRole('paragraph')).toHaveText([PROMPT]);
  await required.getByRole('button', { name: 'Cancel', exact: true }).click();

  await expect(required).toBeHidden();
  await expect(input.getByRole('paragraph')).toHaveText([PROMPT]);
});
