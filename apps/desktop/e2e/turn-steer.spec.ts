import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { bash, held, messageProblems, say, think } from './fixtures/model';
import { closeSettings } from './fixtures/settings';

const P1 = 'Run the slow build';
const S1 = 'Use the release profile instead';
const Q1 = 'Also check binary size';
const GATE_1 = 'steer-gate-1';
const GATE_2 = 'steer-gate-2';
const REPLY_2 = 'Checked the binary size too.';
const P2 = 'Audit auth session handling';
const S2_FIRST = 'Check token refresh race first';
const S2_SECOND = 'Keep legacy cookie support too';
const REPLY_3 = 'Audited token refresh and legacy cookies.';

test.use({ permissionMode: 'yolo' });

test('Enter steers by default with a one-time composer tip, and Mod+Enter queues for Ctrl+S steering', async ({ app, model }) => {
  model.script(
    bash(`while [ ! -f ${GATE_1} ]; do sleep 0.1; done; echo build ok`, { description: 'Slow build' }),
    bash(`while [ ! -f ${GATE_2} ]; do sleep 0.1; done; echo size ok`, { description: 'Size check' }),
    say(REPLY_2),
  );
  await app.startTurn(P1);
  const transcript = app.window.getByRole('list').first();
  const build1 = transcript.getByRole('listitem').filter({ hasText: `while [ ! -f ${GATE_1} ]` });
  const build2 = transcript.getByRole('listitem').filter({ hasText: `while [ ! -f ${GATE_2} ]` });
  await expect(build1.getByRole('status', { name: 'running' })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();

  await app.submit(S1);
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  await expect(transcript.getByText(S1, { exact: true })).toHaveCount(1);

  const tip = app.window.getByRole('status').filter({ hasText: 'Messages sent while running now steer into the current turn by default.' });
  await expect(tip).toBeVisible();
  await tip.getByRole('button', { name: 'Settings' }).click();
  await expect(tip).toBeHidden();

  const dialog = app.window.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  const highlightedRow = dialog.locator('[data-setting-highlighted="true"]');
  await expect(highlightedRow).toBeVisible();
  await expect(highlightedRow.getByRole('tablist', { name: 'Send while running' }).getByRole('tab', { name: 'Steer' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => dialog.locator('.body').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await closeSettings(app.window);

  await writeFile(join(app.workspace, GATE_1), '');
  const second = await model.waitForRequest(1);
  expect(second.userTextsSinceReply).toEqual([S1]);
  expect(messageProblems(second.messages)).toEqual([]);
  await expect(build2.getByRole('status', { name: 'running' })).toBeVisible();

  const input = app.window.getByRole('combobox', { name: 'Message input' });
  await input.click();
  await app.window.keyboard.type(Q1);
  await app.window.keyboard.press('ControlOrMeta+Enter');
  await expect(app.window.getByText('1 waiting to send')).toBeVisible();
  await expect(tip).toHaveCount(0);
  await app.snapshot('one-queued');
  await expect(app.window.getByRole('button', { name: Q1, exact: true })).toBeVisible();
  await app.window.keyboard.press('ControlOrMeta+s');
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  await expect(transcript.getByText(Q1, { exact: true })).toHaveCount(1);

  await writeFile(join(app.workspace, GATE_2), '');
  const third = await model.waitForRequest(2);
  expect(third.userTextsSinceReply).toEqual([Q1]);
  expect(messageProblems(third.messages)).toEqual([]);
  await expect(transcript.getByText(REPLY_2, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  expect(model.requests()).toHaveLength(3);
  expect(model.aborts()).toBe(0);

  await app.window.reload();
  const reloaded = app.window.getByRole('list').first();
  await expect(reloaded.getByText(REPLY_2, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(reloaded.getByText(P1, { exact: true })).toHaveCount(1);
  await expect(reloaded.getByText(S1, { exact: true })).toHaveCount(1);
  await expect(reloaded.getByText(Q1, { exact: true })).toHaveCount(1);
  await expect(tip).toHaveCount(0);

  const think1 = model.hold('think-1');
  const think2 = model.hold('think-2');
  const reply3 = model.hold('reply-3');
  model.script(
    held('think-1', think(['Inspecting auth session flow…', 'more']), 1),
    held('think-2', think(['Checking token refresh race…', 'more']), 1),
    held('reply-3', say(REPLY_3), 0),
  );

  const receipts = reloaded.getByRole('status').filter({ hasText: /^(Read|Unread)$/ });
  await app.submit(P2);
  await think1.reached();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();

  await app.submit(S2_FIRST);
  await think2.reached();
  await expect(reloaded.getByText(S2_FIRST, { exact: true })).toHaveCount(1);
  await expect(receipts).toHaveCount(0);

  await app.submit(S2_SECOND);
  await reply3.reached();
  await expect(reloaded.getByText(S2_SECOND, { exact: true })).toHaveCount(1);
  await expect(receipts).toHaveCount(1);

  reply3.release();
  await expect(reloaded.getByText(REPLY_3, { exact: true })).toBeVisible();
  await expect(receipts).toHaveCount(0);
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  expect(model.aborts()).toBe(2);
});
