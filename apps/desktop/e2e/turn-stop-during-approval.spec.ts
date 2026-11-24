import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { bash, messageProblems, say } from './fixtures/model';

const P1 = 'Record that the deploy was approved';
const P2 = 'Never mind, just say hi';
const MARKER = 'approval-marker.txt';
const REPLY = 'Hi there.';
const INTERRUPTION_NOTE = 'The previous turn was interrupted by the user before completion';

test.use({ permissionMode: 'manual' });

test('stopping a turn while a command waits for approval drops the command and the next prompt works', { tag: '@quarantine' }, async ({ app, model }) => {
  model.script(bash(`echo approved > ${MARKER}`, { description: 'Write the marker' }), say(REPLY));
  await app.startTurn(P1);
  const transcript = app.window.getByRole('list').first();
  const approve = app.window.getByRole('button', { name: 'Approve', exact: true });
  await expect(app.window.getByText('Run command?')).toBeVisible();
  await app.snapshot('approval-pending');
  await expect(approve).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  expect(existsSync(join(app.workspace, MARKER))).toBe(false);

  await app.window.getByRole('button', { name: 'Minimize', exact: true }).click();
  await expect(approve).toBeHidden();
  await app.window.keyboard.press('Escape');
  await app.window.keyboard.press('Escape');
  await expect(app.window.getByText('Run command?')).toBeHidden();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  await expect(app.window.getByRole('status').filter({ hasText: /Working…|Requesting…/ })).toHaveCount(0);
  await expect(app.window.getByRole('alert')).toHaveCount(0);
  expect(model.requests()).toHaveLength(1);

  await expect(transcript.getByRole('status').filter({ hasText: 'Manually stopped' })).toBeVisible();
  await expect(transcript.getByRole('status', { name: 'running' })).toHaveCount(0);

  const next = await app.startTurn(P2);
  await expect(transcript.getByText(REPLY, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  await expect(approve).toBeHidden();
  expect(next.userTextsSinceReply).toEqual([P1, P2]);
  expect(next.remindersSinceReply.some(reminder => reminder.includes(INTERRUPTION_NOTE))).toBe(true);
  expect(next.texts('user').filter(text => text === P1)).toHaveLength(1);
  expect(messageProblems(next.messages)).toEqual([]);
  expect(model.requests()).toHaveLength(2);
  expect(existsSync(join(app.workspace, MARKER))).toBe(false);
});
