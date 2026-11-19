import { expect, test, type DesktopApp } from './fixtures/app';
import { clickAppMenu, enableQuitConfirm } from './fixtures/lifecycle';
import { held, messageProblems, say, type StubModel } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const WARM_UP = 'Summarize the README';
const WARM_UP_REPLY = 'The README explains the build and release flow.';
const LONG_TASK = 'Refactor the parser module';
const PARTIAL = ['Step one: ', 'rename the parser module.'];
const FOLLOW_UP = 'Pick up where you left off';
const FOLLOW_UP_REPLY = 'Resuming with step two: update the imports.';
const QUIT = 'Quit Kimi Code';

async function waitForRelaunch(app: DesktopApp, prompt: string): Promise<void> {
  await expect(sidebarOf(app).getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
}

async function openSession(app: DesktopApp, prompt: string): Promise<string> {
  await sidebarOf(app).getByText(prompt, { exact: true }).click();
  await expect(app.window.getByRole('list').first().getByText(prompt, { exact: true })).toBeVisible();
  return app.sessionId();
}

async function startHeldTurn(app: DesktopApp, model: StubModel, holdName: string) {
  const hold = model.hold(holdName);
  model.script(held(holdName, say([...PARTIAL, ' Step two: update the imports.']), PARTIAL.length), say(FOLLOW_UP_REPLY));
  const request = await app.startTurn(LONG_TASK);
  await hold.reached();
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(PARTIAL.join(''), { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
  return { hold, request };
}

test('quitting asks only while a turn runs, cancel keeps it running and confirm exits cleanly', async ({ app, model }) => {
  const sidebar = () => sidebarOf(app);
  const quitDialog = () => app.window.getByRole('dialog').filter({ hasText: 'Quit Kimi Code?' });

  await test.step('an idle app quits from the menu without asking', async () => {
    model.script(say(WARM_UP_REPLY));
    await app.startTurn(WARM_UP);
    await expect(app.window.getByRole('list').first().getByText(WARM_UP_REPLY, { exact: true })).toBeVisible();
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect(sidebar().getByRole('status', { name: 'Loading' })).toHaveCount(0);
    await app.snapshot('idle-before-quit');
    await enableQuitConfirm(app);
    await clickAppMenu(app, QUIT);
    expect(await app.waitForExit()).toBe(0);
  });

  await test.step('the relaunched app keeps the finished conversation', async () => {
    await app.relaunch();
    await waitForRelaunch(app, WARM_UP);
    await openSession(app, WARM_UP);
    await expect(app.window.getByRole('list').first().getByText(WARM_UP_REPLY, { exact: true })).toBeVisible();
    expect(model.agentRequests()).toBe(1);
    await app.snapshot('relaunched-after-idle-quit');
  });

  const { request } = await test.step('a long turn streams part of its answer', async () => {
    await app.window.getByRole('button', { name: /^New Session/ }).click();
    const started = await startHeldTurn(app, model, 'quit-confirm-turn');
    await expect(sidebar().getByText(LONG_TASK, { exact: true })).toBeVisible();
    await expect(sidebar().getByRole('status', { name: 'Loading' })).toHaveCount(1);
    return started;
  });

  await test.step('quitting asks for confirmation and cancel keeps the turn running', async () => {
    await enableQuitConfirm(app);
    await clickAppMenu(app, QUIT);
    await expect(quitDialog()).toBeVisible();
    await expect(quitDialog()).toContainText('Sessions are still in progress on this machine and will be interrupted if you quit.');
    await expect(quitDialog().getByRole('button', { name: 'Quit' })).toBeVisible();
    await app.snapshot('quit-confirm-dialog');
    await quitDialog().getByRole('button', { name: 'Cancel' }).click();
    await expect(quitDialog()).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
    await expect(app.window.getByRole('list').first().getByText(PARTIAL.join(''), { exact: true })).toBeVisible();
    expect(app.electron.process().exitCode).toBeNull();
    expect(request.aborted).toBe(false);
    await app.snapshot('quit-cancelled-turn-running');
  });

  await test.step('quitting again and confirming exits with code 0 and drops the model stream', async () => {
    await clickAppMenu(app, QUIT);
    await expect(quitDialog()).toBeVisible();
    await quitDialog().getByRole('button', { name: 'Quit' }).click();
    expect(await app.waitForExit()).toBe(0);
    await expect.poll(() => request.aborted, { message: 'waiting for the quit to close the streaming request' }).toBe(true);
  });

  await test.step('after relaunch the interrupted session is idle and keeps the prompt', async () => {
    await app.relaunch();
    await waitForRelaunch(app, LONG_TASK);
    await openSession(app, LONG_TASK);
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect(sidebar().getByRole('status', { name: 'Loading' })).toHaveCount(0);
    await expect(sidebar().getByText(WARM_UP, { exact: true })).toBeVisible();
    await app.snapshot('relaunched-after-confirmed-quit');
  });

  await test.step('a follow-up prompt resumes with the original request in context', async () => {
    const before = model.agentRequests();
    const next = await app.startTurn(FOLLOW_UP);
    await expect(app.window.getByRole('list').first().getByText(FOLLOW_UP_REPLY, { exact: true })).toBeVisible();
    expect(next.texts('user').filter(text => text === LONG_TASK)).toHaveLength(1);
    expect(next.userTextsSinceReply).toContain(FOLLOW_UP);
    expect(next.texts('user')).not.toContain(WARM_UP);
    expect(messageProblems(next.messages)).toEqual([]);
    expect(model.agentRequests()).toBe(before + 1);
    await app.snapshot('follow-up-after-quit');
  });
});
