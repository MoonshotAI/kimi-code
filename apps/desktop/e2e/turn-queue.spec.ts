import { expect, test } from './fixtures/app';
import { held, messageProblems, say } from './fixtures/model';
import { closeSettings, openSettings } from './fixtures/settings';

const P1 = 'Draft the release notes';
const Q1 = 'Also list the breaking changes';
const Q2 = 'Finally thank the contributors';
const P1_REPLY = ['Drafting the ', 'release notes now.'];
const Q1_REPLY = 'Breaking changes are listed.';
const Q2_REPLY = 'Contributors are thanked.';

test('messages queued during a running turn run once each, in order, after it', async ({ app, model }) => {
  const dialog = await openSettings(app.window, 'Agent & Sessions');
  const queueTab = dialog.getByRole('tablist', { name: 'Send while running' }).getByRole('tab', { name: 'Queue' });
  await queueTab.click();
  await expect(queueTab).toHaveAttribute('aria-selected', 'true');
  await closeSettings(app.window);

  const p1 = model.hold('p1');
  const q1 = model.hold('q1');
  const q2 = model.hold('q2');
  model.script(held('p1', say(P1_REPLY), 1), held('q1', say(Q1_REPLY)), held('q2', say(Q2_REPLY)));
  const first = await app.startTurn(P1);
  expect(first.userTextsSinceReply).toEqual([P1]);
  await p1.reached();
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(P1_REPLY[0]!.trim(), { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();

  await app.submit(Q1);
  await app.submit(Q2);
  await expect(app.window.getByText('2 waiting to send')).toBeVisible();
  await app.snapshot('two-queued');
  await expect(app.window.getByRole('button', { name: Q1, exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: Q2, exact: true })).toBeVisible();
  expect(model.requests()).toHaveLength(1);

  const interrupt = app.window.getByRole('button', { name: 'Interrupt', exact: true });
  const working = app.window.getByRole('status').filter({ hasText: /Working…|Requesting…/ }).first();
  p1.release();
  await q1.reached();
  await expect(transcript.getByText(P1_REPLY.join(''), { exact: true })).toBeVisible();
  await expect(app.window.getByText('1 waiting to send')).toBeVisible();
  await expect(interrupt).toBeVisible();
  await expect(working).toBeVisible();

  q1.release();
  await q2.reached();
  await expect(transcript.getByText(Q1_REPLY, { exact: true })).toBeVisible();
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  await expect(interrupt).toBeVisible();
  await expect(working).toBeVisible();

  q2.release();
  await expect(transcript.getByText(Q2_REPLY, { exact: true })).toBeVisible();
  await expect(interrupt).toBeHidden();
  await expect(app.window.getByRole('status').filter({ hasText: /Working…|Requesting…/ })).toHaveCount(0);

  const requests = model.requests();
  expect(requests).toHaveLength(3);
  expect(requests[1]!.userTextsSinceReply).toEqual([Q1]);
  expect(requests[2]!.userTextsSinceReply).toEqual([Q2]);
  expect(requests[2]!.texts('user').filter(text => text === Q1)).toHaveLength(1);
  expect(requests[2]!.texts('user').filter(text => text === Q2)).toHaveLength(1);
  for (const request of requests) expect(messageProblems(request.messages)).toEqual([]);
  expect(model.aborts()).toBe(0);

  const text = await transcript.innerText();
  const order = [P1, P1_REPLY.join(''), Q1, Q1_REPLY, Q2, Q2_REPLY].map(part => text.indexOf(part));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  for (const prompt of [P1, Q1, Q2]) await expect(transcript.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(app.window.getByRole('alert')).toHaveCount(0);
});
