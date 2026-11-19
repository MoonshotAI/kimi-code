import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { held, messageProblems, say } from './fixtures/model';

const PROMPT = 'Audit the dependency tree';
const PARTIAL = 'Scanning the lockfile';

test('Esc closes the top layer first and only a double Esc stops the running turn', async ({ app, model }) => {
  await writeFile(join(app.workspace, 'release-notes.md'), '# Release notes\n');
  const hold = model.hold('audit');
  model.script(held('audit', say([PARTIAL, ' and the manifests.']), 1));
  const streaming = await app.startTurn(PROMPT);
  await hold.reached();
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(PARTIAL, { exact: true })).toBeVisible();
  const interrupt = app.window.getByRole('button', { name: 'Interrupt', exact: true });
  const armed = app.window.getByRole('button', { name: 'Press Esc again to interrupt' });
  const input = app.window.getByRole('combobox', { name: 'Message input' });
  const stillRunning = async (): Promise<void> => {
    await expect(interrupt).toBeVisible();
    await expect(armed).toHaveCount(0);
    await expect(transcript.getByRole('status').filter({ hasText: 'Manually stopped' })).toHaveCount(0);
    expect(streaming.aborted).toBe(false);
  };

  const picker = app.window.getByRole('button', { name: 'stub' });
  await picker.click();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await app.window.keyboard.press('Escape');
  await stillRunning();
  const overlay = await app.overlay();
  const modelMenu = overlay.getByRole('menu');
  await expect(modelMenu.getByRole('menuitemradio', { name: 'stub' })).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(modelMenu).toBeHidden();
  await stillRunning();

  await input.click();
  await app.window.keyboard.type('/');
  const menu = app.window.getByRole('listbox');
  await expect(menu.getByRole('option', { name: /^\/compact / })).toBeVisible();
  await app.window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).toHaveText('/');
  await stillRunning();

  await app.window.keyboard.press('Backspace');
  await app.window.keyboard.type('@release-notes');
  await expect(menu.getByRole('option', { name: /release-notes\.md/ })).toBeVisible();
  await app.window.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(input).toHaveText('@release-notes');
  await stillRunning();

  await app.window.keyboard.press('ControlOrMeta+a');
  await app.window.keyboard.press('Backspace');
  await expect(input).toHaveText('');
  await app.window.keyboard.press('Escape');
  await expect(armed).toBeVisible();
  await expect(app.window.getByRole('status').filter({ hasText: 'Working…' })).toBeVisible();
  expect(streaming.aborted).toBe(false);
  await app.window.keyboard.press('Escape');
  await expect.poll(() => streaming.aborted, { message: 'waiting for the client to close the streaming request' }).toBe(true);
  await expect(armed).toBeHidden();
  await expect(interrupt).toBeHidden();
  await expect(transcript.getByRole('status').filter({ hasText: 'Manually stopped' })).toBeVisible();
  await app.snapshot('manually-stopped');
  await expect(transcript.getByText(PARTIAL, { exact: true })).toBeVisible();
  await expect(transcript.getByText(PROMPT, { exact: true })).toHaveCount(1);
  expect(model.requests()).toHaveLength(1);
  expect(model.aborts()).toBe(1);
  expect(messageProblems(streaming.messages)).toEqual([]);
  await expect(app.window.getByRole('alert')).toHaveCount(0);
});
