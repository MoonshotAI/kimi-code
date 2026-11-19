import { held, say } from '@moonshot-ai/testkit/model';

import { expect, testWithProvider as test } from './fixtures/app';
import { createProject } from './fixtures/project';
import { sidebarOf } from './fixtures/sessions';

const PROMPT = 'Say hello';
const REPLY = ['Hello from ', 'the stub ', 'model, ', 'streamed in ', 'four chunks.'];
const FULL_REPLY = REPLY.join('');

test.use({ seedWorkspace: false });

test('[L0:desktop.first-turn] a first turn in a new workspace streams, finishes and survives a relaunch', { tag: '@smoke' }, async ({ app, provider }) => {
  await createProject(app);
  const sidebar = sidebarOf(app);
  await expect(sidebar.getByText('workspace', { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'New project', exact: true })).toBeHidden();
  await app.trustWorkspace();

  provider.script(held('first-chunk', say(REPLY), 1));
  await app.window.getByRole('combobox', { name: 'Message input' }).click();
  await app.window.keyboard.type(PROMPT);
  await app.window.keyboard.press('Enter');
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
