import { expect, test, type DesktopApp } from './fixtures/app';
import { captureClipboardWrites } from './fixtures/clipboard';
import { clickAppMenu, routeServerTraffic, type Outage } from './fixtures/lifecycle';
import { messageProblems, say, type StubModel } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const FIRST = 'Check the deploy script';
const FIRST_REPLY = 'The deploy script looks fine.';
const OFFLINE = 'Sent while offline';
const BACK = 'Back online now';
const BACK_REPLY = 'Connection restored, continuing.';
const CANNOT_CONNECT = 'Cannot connect';

async function routedApp(app: DesktopApp): Promise<Outage> {
  const outage = await routeServerTraffic(app);
  await app.window.reload();
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
  return outage;
}

test('losing the server shows connection errors with diagnostics and the app recovers without losing the conversation', async ({ app, model }) => {
  const transcript = () => app.window.getByRole('list').first();
  const toast = () => app.window.getByRole('status').filter({ hasText: CANNOT_CONNECT });
  let outage: Outage | undefined;
  let sessionId = '';

  await test.step('a first turn completes over the routed connection', async () => {
    outage = await routedApp(app);
    model.script(say(FIRST_REPLY));
    await app.startTurn(FIRST);
    await expect(transcript().getByText(FIRST_REPLY, { exact: true })).toBeVisible();
    sessionId = await app.sessionId();
    await app.snapshot('connected-first-turn');
  });

  await test.step('sending during an outage fails with a connection toast and copyable diagnostics', async () => {
    await outage!.down();
    const before = model.agentRequests();
    await app.submit(OFFLINE);
    await expect(toast()).toBeVisible();
    await expect(toast()).toContainText('No response from the Kimi Code service.');
    await toast().getByRole('button', { name: 'Show details' }).click();
    await expect(toast().getByText('sendPrompt', { exact: true })).toBeVisible();
    await expect(toast().getByText('disconnected', { exact: true })).toBeVisible();
    await expect(toast().getByText(`POST /sessions/${sessionId}/prompts`, { exact: true })).toBeVisible();
    await app.snapshot('send-failed-details');
    const copiedTexts = await captureClipboardWrites(app);
    await toast().getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(toast().getByRole('button', { name: 'Copied' })).toBeVisible();
    const [copied] = await copiedTexts();
    expect(copied).toContain(CANNOT_CONNECT);
    expect(copied).toContain('Operation: sendPrompt');
    expect(copied).toContain(`Session ID: ${sessionId}`);
    expect(copied).toContain('Failure phase: fetch');
    expect(model.agentRequests()).toBe(before);
  });

  await test.step('Retry Connection reloads the session once the server is back', async () => {
    outage!.up();
    await clickAppMenu(app, 'Retry Connection');
    await expect(toast()).toBeHidden();
    await expect(transcript().getByText(FIRST_REPLY, { exact: true })).toBeVisible();
    await expect(transcript().getByText(FIRST, { exact: true })).toBeVisible();
    await expect.poll(() => app.window.url()).toContain(sessionId);
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
    await app.snapshot('reconnected-after-retry');
  });

  await test.step('sending works again and the model sees no trace of the failed send', async () => {
    model.script(say(BACK_REPLY));
    const composer = app.window.getByRole('combobox', { name: 'Message input' });
    await expect(composer).toHaveText(OFFLINE);
    await composer.click();
    await app.window.keyboard.press('ControlOrMeta+a');
    await app.window.keyboard.press('Delete');
    const request = await app.startTurn(BACK);
    await expect(transcript().getByText(BACK_REPLY, { exact: true })).toBeVisible();
    expect(request.texts('user').filter(text => !text.startsWith('<system-reminder>'))).toEqual([FIRST, BACK]);
    expect(request.texts('assistant')).toEqual([FIRST_REPLY]);
    expect(messageProblems(request.messages)).toEqual([]);
  });

  await test.step('a reload during an outage shows the connecting screen with the issue', async () => {
    await outage!.down();
    await app.window.reload();
    const loading = app.window.getByRole('status', { name: 'Connecting…' }).first();
    await expect(loading).toBeVisible();
    await expect(loading).toContainText('Cannot connect');
    await expect(loading).toContainText(/\(retry \d+\)/);
    await app.snapshot('connecting-during-outage');
  });

  await test.step('the app reconnects on its own and restores the same session', async () => {
    outage!.up();
    await expect(app.window.getByRole('status', { name: 'Connecting…' }).first()).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => app.window.url()).toContain(sessionId);
    for (const text of [FIRST, FIRST_REPLY, BACK, BACK_REPLY]) {
      await expect(transcript().getByText(text, { exact: true })).toBeVisible();
    }
    await expect(transcript().getByText(OFFLINE, { exact: true })).toHaveCount(0);
    await app.snapshot('recovered-after-outage');
  });

  await test.step('the transcript after a relaunch matches what was really sent', async () => {
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(FIRST, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
    if (!app.window.url().includes(sessionId)) await sidebar.getByText(FIRST, { exact: true }).click();
    const restored = transcript();
    await expect(restored.getByText(BACK_REPLY, { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const text of [FIRST, BACK]) await expect(restored.getByText(text, { exact: true })).toHaveCount(1);
    await expect(restored.getByText(OFFLINE, { exact: true })).toHaveCount(0);
    const text = await restored.innerText();
    const order = [FIRST, FIRST_REPLY, BACK, BACK_REPLY].map(part => text.indexOf(part));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(model.agentRequests()).toBe(2);
  });
});

async function sendDuringOutage(app: DesktopApp, model: StubModel): Promise<void> {
  const outage = await routedApp(app);
  model.script(say(FIRST_REPLY));
  await app.startTurn(FIRST);
  await expect(app.window.getByText(FIRST_REPLY, { exact: true })).toBeVisible();
  await outage.down();
  await app.submit(OFFLINE);
  await expect(app.window.getByRole('status').filter({ hasText: CANNOT_CONNECT })).toBeVisible();
}

test('a send that fails during an outage is not shown as sent', async ({ app, model }) => {
  await sendDuringOutage(app, model);
  await expect(app.window.getByRole('list').first().getByText(OFFLINE, { exact: true })).toHaveCount(0);
});

test('a send that fails during an outage gives the text back to the composer', async ({ app, model }) => {
  await sendDuringOutage(app, model);
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toHaveText(OFFLINE);
});
