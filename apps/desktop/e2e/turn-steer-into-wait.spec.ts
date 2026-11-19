import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { bash, held, messageProblems, say, waitFor } from './fixtures/model';

const P1 = 'Start the build and wait for it';
const Q = 'Check the logs while it runs';
const REPLY = 'Checking the logs while the build keeps running.';
const JOB = 'build';
const DONE = 'The build finished.';

test.use({ permissionMode: 'yolo' });

test('a message sent during WaitFor waits in the queue until Ctrl+S steers it, which ends the wait and keeps the background task running', async ({ app, model }) => {
  const answer = model.hold('answer');
  model.script(
    bash(`touch ${JOB}.started; while [ ! -f ${JOB}.gate ]; do sleep 0.1; done; touch ${JOB}.done`, { description: 'Start the build', background: true }),
    waitFor(90),
    held('answer', say(REPLY)),
    say(DONE),
  );
  await app.startTurn(P1);
  const transcript = app.window.getByRole('list').first();
  const waitLine = transcript.getByRole('listitem').filter({ hasText: /^Wait/ });
  await expect(waitLine.getByText('Waiting for any background task')).toBeVisible();
  expect(model.requests()).toHaveLength(2);
  await expect.poll(() => existsSync(join(app.workspace, `${JOB}.started`)), { message: 'waiting for the background build to start' }).toBe(true);

  const input = app.window.getByRole('combobox', { name: 'Message input' });
  await input.click();
  await app.window.keyboard.type(Q);
  await app.window.keyboard.press('ControlOrMeta+Enter');
  await expect(app.window.getByText('1 waiting to send')).toBeVisible();
  await expect(waitLine.getByText('Waiting for any background task')).toBeVisible();
  await expect(waitLine.getByText('Wait interrupted by new input', { exact: true })).toHaveCount(0);
  expect(model.requests()).toHaveLength(2);

  const steeredAt = Date.now();
  await app.window.keyboard.press('ControlOrMeta+s');
  await expect(waitLine.getByText('Wait interrupted by new input', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - steeredAt).toBeLessThan(15_000);
  await app.snapshot('wait-interrupted');
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  await expect(transcript.getByText(Q, { exact: true })).toHaveCount(1);

  const next = await answer.reached();
  expect(next.index).toBe(2);
  expect(next.userTextsSinceReply).toEqual([Q]);
  expect(next.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call_e2e_1_0')).toBe(true);
  expect(next.texts('user').filter(text => text.includes(Q))).toHaveLength(1);
  expect(messageProblems(next.messages)).toEqual([]);
  await expect(app.window.getByRole('button', { name: 'Bash 1 running' })).toBeVisible();
  expect(existsSync(join(app.workspace, `${JOB}.done`))).toBe(false);

  answer.release();
  await expect(transcript.getByText(REPLY, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Bash 1 running' })).toBeVisible();
  expect(existsSync(join(app.workspace, `${JOB}.done`))).toBe(false);

  await writeFile(join(app.workspace, `${JOB}.gate`), '');
  await expect.poll(() => existsSync(join(app.workspace, `${JOB}.done`)), { message: 'waiting for the background build to finish on its own' }).toBe(true);
  await expect(transcript.getByText(DONE, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  await expect(transcript.getByText(Q, { exact: true })).toHaveCount(1);
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  const requests = model.requests();
  expect(requests).toHaveLength(4);
  expect(requests[3]!.userTextsSinceReply.some(text => text.includes(Q))).toBe(false);
  expect(requests[3]!.texts('user').filter(text => text.includes(Q))).toHaveLength(1);
  expect(model.aborts()).toBe(0);
  await expect(app.window.getByRole('alert')).toHaveCount(0);
});
