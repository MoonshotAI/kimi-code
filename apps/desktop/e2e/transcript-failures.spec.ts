import { expect, test } from './fixtures/app';
import { held, httpError, messageProblems, say } from './fixtures/model';
import { relaunchAndSettle, waitForSettledReply } from './fixtures/transcript';

const FAILING = 'Summarize the failing deploy';
const RESUMED = 'The deploy failed on the migration step.';
const STOPPED = 'Draft the incident timeline';
const STOPPED_PARTIAL = ['At 09:00 the alert ', 'fired and'];
const DROPPED = 'List the affected regions';
const DROPPED_PARTIAL = ['Affected: ', 'eu-west '];
const DROPPED_REPLY = 'and us-east.';
const FLAKY = 'Check the rollback status';
const FLAKY_REPLY = 'The rollback finished cleanly.';
const FAILURE_TITLE = 'Model request failed — this turn was interrupted';

test('failed, stopped and dropped turns render their markers, resume with Continue, and keep them after a relaunch', { tag: '@quarantine' }, async ({ app, model }) => {
  const transcript = () => app.window.getByRole('list').first();
  const interrupt = () => app.window.getByRole('button', { name: 'Interrupt', exact: true });
  const failure = () => app.window.getByRole('alert').filter({ hasText: FAILURE_TITLE });

  await test.step('a model error ends the turn with a failure block that names the error and offers Continue', async () => {
    model.script(httpError(400, 'stub rejected the deploy summary'));
    await app.startTurn(FAILING);
    await expect(failure()).toBeVisible();
    await expect(failure()).toContainText('stub rejected the deploy summary');
    await expect(failure()).toContainText('HTTP 400');
    await expect(failure().getByRole('button', { name: 'Continue' })).toBeVisible();
    await expect(interrupt()).toBeHidden();
    await expect(transcript().getByText(FAILING, { exact: true })).toBeVisible();
    expect(model.requests()).toHaveLength(1);
    await app.snapshot('failed-turn');
  });

  await test.step('after a relaunch the failure block is restored with its error and Continue button', async () => {
    await relaunchAndSettle(app, FAILING);
    await expect(failure()).toBeVisible({ timeout: 30_000 });
    await expect(failure()).toContainText('stub rejected the deploy summary');
    await expect(transcript().getByText(FAILING, { exact: true })).toBeVisible();
    expect(model.requests()).toHaveLength(1);
  });

  await test.step('Continue after the relaunch resumes the conversation, clears the failure block, and sends the prompt only once', async () => {
    model.script(say(RESUMED));
    await failure().getByRole('button', { name: 'Continue' }).click();
    await waitForSettledReply(app.window, RESUMED);
    await expect(failure()).toHaveCount(0);
    await expect(transcript().getByText('Continue', { exact: true })).toHaveCount(0);
    const resumed = model.request(1);
    expect(resumed.userTextsSinceReply.join('\n')).toContain('Continue');
    expect(resumed.texts('user').filter(text => text.includes(FAILING))).toHaveLength(1);
    expect(messageProblems(resumed.messages)).toEqual([]);
    await app.snapshot('continued');
  });

  await test.step('a stream dropped mid-reply is retried with the partial text kept as context', async () => {
    const hold = model.hold('dropped-midway');
    model.script(held('dropped-midway', say([...DROPPED_PARTIAL, 'never sent']), DROPPED_PARTIAL.length), say(DROPPED_REPLY));
    const before = model.requests().length;
    await app.startTurn(DROPPED);
    await hold.reached();
    await expect(transcript().getByText(DROPPED_PARTIAL.join('').trim())).toBeVisible();
    hold.cut();
    await expect(transcript().getByText(DROPPED_REPLY, { exact: false })).toBeVisible();
    await expect(interrupt()).toBeHidden();
    const retry = model.request(before + 1);
    expect(retry.texts('assistant').at(-1)).toBe(DROPPED_PARTIAL.join(''));
    expect(retry.texts('user').filter(text => text === DROPPED)).toHaveLength(1);
    expect(messageProblems(retry.messages)).toEqual([]);
    await expect(transcript().getByText('never sent')).toHaveCount(0);
    await expect(failure()).toHaveCount(0);
    expect(model.requests()).toHaveLength(before + 2);
  });

  await test.step('a transient server error is retried quietly and the turn completes without a failure block', async () => {
    model.script(httpError(500, 'stub overloaded'), say(FLAKY_REPLY));
    const before = model.requests().length;
    await app.startTurn(FLAKY);
    await waitForSettledReply(app.window, FLAKY_REPLY);
    await expect(failure()).toHaveCount(0);
    expect(model.requests()).toHaveLength(before + 2);
    expect(model.request(before + 1).texts('user').filter(text => text === FLAKY)).toHaveLength(1);
    expect(messageProblems(model.request(before + 1).messages)).toEqual([]);
    await app.snapshot('retried');
  });

  await test.step('stopping a streaming reply leaves the partial text and a "Manually stopped" marker', async () => {
    const hold = model.hold('stop-midway');
    model.script(held('stop-midway', say([...STOPPED_PARTIAL, ' the on-call engineer joined.']), STOPPED_PARTIAL.length));
    const streaming = await app.startTurn(STOPPED);
    await hold.reached();
    const partial = STOPPED_PARTIAL.join('');
    await expect(transcript().getByText(partial, { exact: true })).toBeVisible();
    await interrupt().click();
    await expect.poll(() => streaming.aborted).toBe(true);
    await expect(interrupt()).toBeHidden();
    await expect(transcript().getByRole('status').filter({ hasText: 'Manually stopped' })).toBeVisible();
    await expect(transcript().getByText(partial, { exact: true })).toBeVisible();
    await expect(failure()).toHaveCount(0);
    await app.snapshot('manually-stopped');
  });

  await test.step('after a second relaunch the stopped turn keeps its partial reply in order', async () => {
    const requests = model.requests().length;
    await relaunchAndSettle(app, FAILING);
    const restored = transcript();
    await expect(restored.getByText(STOPPED_PARTIAL.join(''), { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(restored.getByText(RESUMED, { exact: true })).toBeAttached();
    await expect(restored.getByText(DROPPED_REPLY, { exact: false })).toBeAttached();
    await expect(restored.getByText(FLAKY_REPLY, { exact: true })).toBeAttached();
    await expect(failure()).toHaveCount(0);
    const text = await restored.innerText();
    const order = [FAILING, RESUMED, DROPPED, FLAKY, FLAKY_REPLY, STOPPED, STOPPED_PARTIAL.join('')].map(part => text.indexOf(part));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(model.requests()).toHaveLength(requests);
    await app.snapshot('restored-after-stop');
  });
});

test('a stopped turn keeps its "Manually stopped" marker after a relaunch', async ({ app, model }) => {
  const transcript = () => app.window.getByRole('list').first();
  const stopped = () => transcript().getByRole('status').filter({ hasText: 'Manually stopped' });
  const hold = model.hold('stop-midway');
  model.script(held('stop-midway', say([...STOPPED_PARTIAL, ' the on-call engineer joined.']), STOPPED_PARTIAL.length));
  await app.startTurn(STOPPED);
  await hold.reached();
  await app.window.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expect(stopped()).toBeVisible();

  await relaunchAndSettle(app, STOPPED);
  await expect(transcript().getByText(STOPPED_PARTIAL.join(''), { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(stopped()).toHaveCount(1);
});
