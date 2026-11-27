import { expect, test, type DesktopApp } from './fixtures/app';
import { held, httpError, messageProblems, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const FIRST = 'Draft the migration plan';
const RECOVERED = 'Here is the migration plan.';
const RATE_LIMITED = 'Add a rollback section';
const AFTER_RATE_LIMIT = 'Rollback: restore the previous schema snapshot.';
const AUTH = 'List the risky steps';
const CUT = 'Estimate the downtime';
const CUT_PARTIAL = ['Downtime is ', 'about five'];
const AFTER_CUT = 'Downtime is about five minutes.';
const FAILED_CARD = 'Model request failed — this turn was interrupted';

test.use({ extraConfig: '\n[loop_control]\nmax_attempts_per_step = 2\n' });

function failureCards(app: DesktopApp) {
  return app.window.getByText(FAILED_CARD, { exact: true });
}

function failedBadge(app: DesktopApp) {
  return sidebarOf(app).getByText('Failed', { exact: true });
}

test('model errors fail the turn with diagnostics, retry when allowed and Continue recovers', async ({ app, model }) => {
  const transcript = () => app.window.getByRole('list').first();
  let sessionId = '';

  await test.step('a 500 is retried once and then fails the turn', async () => {
    const retry = model.hold('errors-500-retry');
    model.script(httpError(500, 'upstream exploded'), held('errors-500-retry', say('never sent')), say(RECOVERED));
    await app.submit(FIRST);
    await retry.reached();
    expect(model.agentRequests()).toBe(2);
    await expect(app.window.getByRole('status').filter({ hasText: 'Requesting…' })).toBeVisible();
    await expect(failureCards(app)).toHaveCount(0);
    await app.snapshot('second-attempt-after-500');
    retry.fail(500);
    await expect(failureCards(app)).toHaveCount(1);
    await expect(app.window.getByText('stub error 500', { exact: true })).toBeVisible();
    await expect(app.window.getByText('provider.api_error · HTTP 500')).toBeVisible();
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect(failedBadge(app)).toBeVisible();
    expect(model.agentRequests()).toBe(2);
    sessionId = await app.sessionId();
    await app.snapshot('failed-after-500');
  });

  await test.step('Continue resends the conversation and the reply arrives', async () => {
    await app.window.getByRole('button', { name: 'Continue', exact: true }).and(app.window.locator(':not(.toc-row)')).click();
    await expect(transcript().getByText(RECOVERED, { exact: true })).toBeVisible();
    const request = model.request(2);
    expect(request.texts('user').filter(text => text === FIRST)).toHaveLength(1);
    expect(request.userTextsSinceReply.at(-1)).toBe('Continue');
    expect(messageProblems(request.messages)).toEqual([]);
    expect(model.agentRequests()).toBe(3);
    await expect(app.window.getByRole('button', { name: 'Continue', exact: true }).and(app.window.locator(':not(.toc-row)'))).toBeHidden();
    await expect(failedBadge(app)).toBeHidden();
    await app.snapshot('recovered-with-continue');
  });

  await test.step('a 429 is retried transparently', async () => {
    model.script(httpError(429, 'slow down'), say(AFTER_RATE_LIMIT));
    await app.startTurn(RATE_LIMITED);
    await expect(transcript().getByText(AFTER_RATE_LIMIT, { exact: true })).toBeVisible();
    expect(model.agentRequests()).toBe(5);
    await expect(app.window.getByText('slow down', { exact: true })).toHaveCount(0);
  });

  await test.step('a 401 fails at once as an authentication error', async () => {
    model.script(httpError(401, 'invalid api key'));
    await app.startTurn(AUTH);
    await expect(app.window.getByText('invalid api key', { exact: true })).toBeVisible();
    await expect(app.window.getByText('provider.auth_error · HTTP 401')).toBeVisible();
    await expect(app.window.getByRole('button', { name: 'Continue', exact: true }).and(app.window.locator(':not(.toc-row)'))).toBeVisible();
    await expect(failedBadge(app)).toBeVisible();
    expect(model.agentRequests()).toBe(6);
    await app.snapshot('failed-after-401');
  });

  await test.step('a stream cut mid-answer keeps the partial text and fails after the retry is cut too', async () => {
    model.script(say('Continuing.'));
    await app.window.getByRole('button', { name: 'Continue', exact: true }).and(app.window.locator(':not(.toc-row)')).click();
    await expect(transcript().getByText('Continuing.', { exact: true })).toBeVisible();
    const first = model.hold('errors-cut-first');
    const second = model.hold('errors-cut-second');
    model.script(
      held('errors-cut-first', say([...CUT_PARTIAL, ' never sent']), CUT_PARTIAL.length),
      held('errors-cut-second', say(['Retry ', 'never sent']), 1),
      say(AFTER_CUT),
    );
    await app.startTurn(CUT);
    await first.reached();
    await expect(transcript().getByText(/^Downtime is about five(?:\s+Retry)?$/)).toBeVisible();
    first.cut();
    await second.reached();
    second.cut();
    await expect(app.window.getByText('provider.connection_error')).toBeVisible();
    await expect(transcript().getByText(/^Downtime is about five(?:\s+Retry)?$/)).toBeVisible();
    await expect(transcript().getByText('Retry')).toBeVisible();
    await expect(failedBadge(app)).toBeVisible();
    await app.snapshot('failed-after-stream-cut');
  });

  await test.step('Continue after the cut finishes the answer with a clean history', async () => {
    const before = model.agentRequests();
    await app.window.getByRole('button', { name: 'Continue', exact: true }).and(app.window.locator(':not(.toc-row)')).click();
    await expect(transcript().getByText(AFTER_CUT, { exact: true })).toBeVisible();
    const request = model.request(before);
    expect(request.texts('user').filter(text => text === CUT)).toHaveLength(1);
    expect(messageProblems(request.messages)).toEqual([]);
    await expect(app.window.getByRole('button', { name: 'Continue', exact: true }).and(app.window.locator(':not(.toc-row)'))).toBeHidden();
    await app.snapshot('recovered-after-stream-cut');
  });

  await test.step('the failures and recoveries survive a relaunch', async () => {
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(FIRST, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
    if (await app.sessionId().catch(() => '') !== sessionId) await sidebar.getByText(FIRST, { exact: true }).click();
    await expect.poll(() => app.window.url()).toContain(sessionId);
    for (const text of [RECOVERED, AFTER_RATE_LIMIT, AFTER_CUT]) {
      await expect(transcript().getByText(text, { exact: true })).toBeVisible();
    }
    await expect(transcript().getByText(/^Downtime is about five(?:\s+Retry)?$/)).toBeVisible();
    await expect(transcript().getByText('Retry')).toBeVisible();
    await expect(transcript().getByText('Continue', { exact: true })).toHaveCount(3);
    await expect(failureCards(app)).toHaveCount(0);
    await expect(failedBadge(app)).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'Continue', exact: true }).and(app.window.locator(':not(.toc-row)'))).toBeHidden();
    await app.snapshot('errors-after-relaunch');
  });
});
