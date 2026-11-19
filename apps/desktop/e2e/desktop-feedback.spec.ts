import { expect, test, type DesktopApp } from './fixtures/app';
import type { StubModel } from './fixtures/model';
import { sendAndFinish, sessionRowById } from './fixtures/sessions';

const envelope = (data: unknown) => ({ code: 0, msg: '', data });

test('submits global and reply feedback with opt-in attachments', async ({ app, model }) => {
  const page = app.window;
  const feedbackRequests: Array<{ path: string; method: string; body: unknown }> = [];
  const uploaded: Array<{ kind: string | null; bytes: Buffer }> = [];
  const sessionUploads: Array<{ path: string; body: unknown }> = [];
  let signedIn = false;
  let failSubmission = true;
  let failDiagnostics = true;
  let nextFeedbackId = 21;

  await page.route('**/api/v1/meta', (route) => route.fulfill({ json: envelope({
    server_version: '2.6.3', capabilities: {}, experimental_flags: { desktop_feedback: true },
  }) }));
  await page.route('**/api/v1/auth', (route) => route.fulfill({ json: envelope({
    models_ready: true, providers_count: 1, managed_provider: signedIn ? { status: 'authenticated' } : null,
  }) }));
  await page.route('**/api/v1/oauth/userinfo*', (route) => route.fulfill({ json: envelope({ kind: 'error' }) }));
  await page.route('**/api/v1/feedback**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith('/attachments/session')) {
      sessionUploads.push({ path, body: request.postDataJSON() });
      await route.fulfill({ json: envelope({ upload_id: sessionUploads.length }) });
      return;
    }
    if (path.endsWith('/attachments')) {
      const kind = url.searchParams.get('kind');
      uploaded.push({ kind, bytes: request.postDataBuffer() ?? Buffer.alloc(0) });
      if (kind === 'diagnostics' && failDiagnostics) {
        failDiagnostics = false;
        await route.fulfill({ status: 503, json: { code: 50000, msg: 'Offline' } });
        return;
      }
      await route.fulfill({ json: envelope({ upload_id: uploaded.length }) });
      return;
    }
    feedbackRequests.push({ path, method: request.method(), body: request.postDataJSON() });
    if (failSubmission) {
      failSubmission = false;
      await route.fulfill({ status: 500, json: { code: 50000, msg: 'Offline' } });
      return;
    }
    const feedbackId = request.method() === 'POST' ? nextFeedbackId++ : Number(path.split('/').at(-1));
    await route.fulfill({ json: envelope({ feedback_id: feedbackId }) });
  });
  await page.reload();

  const feedbackButton = page.getByRole('button', { name: 'Send feedback' });
  await feedbackButton.click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Kimi Code' })).toBeVisible();
  expect(feedbackRequests).toHaveLength(0);

  signedIn = true;
  await page.reload();
  await feedbackButton.click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await expect(dialog).toHaveCSS('width', '560px');
  await expect(dialog).toHaveCSS('height', '484px');
  await expect(dialog.getByRole('checkbox', { name: /Include diagnostic logs/ })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Include this conversation/ })).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Description' }).fill('A reproducible issue');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const input = page.getByRole('combobox', { name: 'Message input' });
  await input.fill('/feedback');
  await input.press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Description' })).toHaveValue('A reproducible issue');
  await app.snapshot('global-feedback');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Try again');
  await expect(dialog.getByRole('textbox', { name: 'Description' })).toHaveValue('A reproducible issue');
  await dialog.getByRole('button', { name: 'Resubmit' }).click();
  const receipt = (id: number) => page.locator('.feedback-receipt-toast').filter({ hasText: String(id) });
  await expect(dialog).toBeHidden();
  await expect(receipt(21)).toBeVisible();
  await receipt(21).getByRole('button', { name: 'Copy feedback ID' }).click();
  await expect(receipt(21).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(feedbackRequests.map(({ body }) => body)).toEqual([
    { kind: 'global', source: 'command', category: 'bug', content: 'A reproducible issue', client: 'desktop', upload_session: false, upload_logs: false },
    { kind: 'global', source: 'command', category: 'bug', content: 'A reproducible issue', client: 'desktop', upload_session: false, upload_logs: false },
  ]);
  expect(uploaded).toHaveLength(0);

  const answer = model.queueReply(['A completed', ' answer.'], { holdAfterFirstChunk: true });
  await app.submit('Inspect the issue');
  await expect(page.getByText('A completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Good response' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Poor response' })).toBeHidden();
  answer.release();
  await expect(page.getByText('A completed answer.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Poor response' }).click();
  const details = page.getByRole('dialog', { name: 'What could be better?' });
  await expect(details).toHaveCSS('width', '400px');
  await expect(details.getByRole('checkbox', { name: 'Also upload this conversation' })).not.toBeChecked();
  await app.snapshot('reply-feedback');
  const replyDescription = details.getByRole('textbox');
  const replySubmit = details.getByRole('button', { name: 'Submit', exact: true });
  const initialHeight = await details.evaluate(el => el.clientHeight);
  const longDescription = `${'Example feedback. '.repeat(10)}\n`.repeat(12);
  await replyDescription.fill(longDescription);
  await expect.poll(() => details.evaluate(el => el.clientHeight)).toBeGreaterThan(initialHeight);
  await expect(replySubmit).toBeDisabled();
  await replyDescription.press('Tab');
  await expect.poll(() => details.evaluate(el => el.clientHeight)).toBe(initialHeight);
  await expect(replyDescription).toHaveJSProperty('scrollTop', 0);
  await replyDescription.click();
  await expect.poll(() => details.evaluate(el => el.clientHeight)).toBeGreaterThan(initialHeight);
  await expect(replyDescription).toHaveValue(longDescription);
  const uploadLabel = details.getByText('Also upload this conversation', { exact: true });
  await uploadLabel.click();
  await expect(details.getByRole('checkbox')).toBeChecked();
  await uploadLabel.click();
  await replyDescription.fill('');
  await details.getByRole('button', { name: 'Incorrect or incomplete' }).click();
  await replySubmit.click();
  await expect(receipt(22)).toBeVisible();
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: 'Remove dislike' }).click();
  await expect(page.getByRole('button', { name: 'Poor response' })).toBeVisible();
  expect(feedbackRequests.slice(2)).toEqual([
    { path: '/api/v1/feedback', method: 'POST', body: { kind: 'turn', rating: 'down', session_id: await app.sessionId(), turn_id: expect.any(String), reply_id: expect.any(String), client: 'desktop' } },
    { path: '/api/v1/feedback/22', method: 'PATCH', body: { kind: 'details', reasons: ['incorrect'], upload_session: false } },
    { path: '/api/v1/feedback/22', method: 'PATCH', body: { kind: 'cancel' } },
  ]);

  await feedbackButton.click();
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Issue with an attachment');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const picker = dialog.locator('input[type="file"]');
  const emptyImage = { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) };
  const validImage = { name: 'screen.png', mimeType: 'image/png', buffer: image };
  await picker.setInputFiles([emptyImage, { name: 'empty.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(0) }, validImage]);
  await expect(dialog.getByRole('button', { name: /^Remove empty/ })).toHaveCount(0, { timeout: 3000 });
  await expect(dialog.getByRole('alert')).toHaveText('Empty files can’t be attached.');
  await dialog.getByRole('button', { name: 'Remove screen.png' }).click();
  await expect(dialog.getByRole('alert')).toBeHidden();
  await picker.setInputFiles(emptyImage);
  await expect(dialog.getByRole('alert')).toHaveText('Empty files can’t be attached.');
  await picker.setInputFiles(validImage);
  await expect(dialog.getByRole('alert')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Remove screen.png' })).toBeVisible();
  await dialog.getByText('Include diagnostic logs', { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /Include diagnostic logs/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(receipt(23)).toBeVisible();
  const uploadFailure = page.getByRole('alert').filter({ hasText: 'Couldn’t upload diagnostic logs' });
  await expect(uploadFailure).toBeVisible();
  await expect.poll(() => uploaded.map(({ kind }) => kind)).toEqual(['media', 'diagnostics']);
  expect(uploaded[0]?.bytes.includes(image)).toBe(true);
  expect(uploaded[1]?.bytes.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  const submitCount = feedbackRequests.length;
  await uploadFailure.getByRole('button', { name: 'Retry upload' }).click();
  await expect.poll(() => uploaded.map(({ kind }) => kind)).toEqual(['media', 'diagnostics', 'diagnostics']);
  await expect(uploadFailure).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Uploaded diagnostic logs' })).toBeVisible();
  expect(feedbackRequests).toHaveLength(submitCount);
  expect(feedbackRequests.at(-1)?.body).toMatchObject({ client: 'desktop', upload_logs: true, upload_session: false });

  const originalSession = await app.sessionId();
  await feedbackButton.click();
  await dialog.getByRole('button', { name: 'Feature request' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /^New Session/ }).first().click();
  model.queueReply(['The next answer.']);
  await app.submit('Start another conversation');
  await expect(page.getByText('The next answer.', { exact: true })).toBeVisible();
  const nextSession = await app.sessionId();
  expect(nextSession).not.toBe(originalSession);
  await feedbackButton.click();
  await expect(dialog.getByRole('button', { name: 'Feature request' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Keep the original conversation');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(receipt(24)).toBeVisible();
  expect(feedbackRequests.at(-1)?.body).toMatchObject({ session_id: originalSession, category: 'suggestion', upload_session: false });

  const conversationOption = dialog.getByRole('checkbox', { name: 'Include this conversation' });
  const conversationLabel = dialog.getByText('Include this conversation', { exact: true });
  await feedbackButton.click();
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Attach the conversation I choose');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sessionRowById(app, originalSession).click();
  await expect(page.getByText('A completed answer.', { exact: true })).toBeVisible();
  await feedbackButton.click();
  await conversationLabel.click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await feedbackButton.click();
  await expect(conversationOption).toBeChecked();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(receipt(25)).toBeVisible();
  await expect.poll(() => sessionUploads).toHaveLength(1);
  expect(sessionUploads).toEqual([{ path: '/api/v1/feedback/25/attachments/session', body: { session_id: originalSession } }]);
  expect(feedbackRequests.at(-1)?.body).toMatchObject({ session_id: originalSession, upload_session: true });

  await feedbackButton.click();
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Keep the text across conversations');
  await conversationLabel.click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /^New Session/ }).first().click();
  await feedbackButton.click();
  await expect(conversationOption).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sessionRowById(app, nextSession).click();
  await expect(page.getByText('The next answer.', { exact: true })).toBeVisible();
  await feedbackButton.click();
  await expect(conversationOption).not.toBeChecked();
  await expect(dialog.getByRole('textbox', { name: 'Description' })).toHaveValue('Keep the text across conversations');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(receipt(26)).toBeVisible();
  expect(feedbackRequests.at(-1)?.body).toMatchObject({ session_id: originalSession, upload_session: false });
  expect(sessionUploads).toHaveLength(1);

  await page.route('**/api/v1/feedback', (route) => route.fulfill({
    json: { code: 40112, msg: 'The feedback service did not authorize this operation.', data: null },
  }));
  await page.getByRole('button', { name: 'Good response' }).click();
  await expect(page.getByText('The feedback service denied access', { exact: true })).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole('dialog', { name: 'Sign in to Kimi Code' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Good response' })).toBeVisible();

  await feedbackButton.click();
  const description = dialog.getByRole('textbox', { name: 'Description' });
  await description.fill('Keep this draft if access is denied');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The feedback service denied access');
  await expect(description).toHaveValue('Keep this draft if access is denied');
  await expect(page.getByRole('dialog', { name: 'Sign in to Kimi Code' })).toBeHidden();

  signedIn = false;
  await page.reload();
  await page.getByRole('button', { name: 'Poor response' }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Kimi Code' })).toBeVisible();
  await expect(details).toBeHidden();
});

const hostId = 'example';
const hostProxy = `/api/v1/hosts/${hostId}/proxy`;
type OwnedRecord = { host_id?: string };
type SessionDirectory = OwnedRecord & { items?: OwnedRecord[]; groups?: (OwnedRecord & { sessions: OwnedRecord[] })[] };

async function openSshConversation(app: DesktopApp, model: StubModel, flags: { local: boolean; remote: boolean }) {
  const page = app.window;
  const reply = 'The remote task finished.';
  const sessionId = await sendAndFinish(app, model, 'Check the task', reply);
  const requests: Array<{ path: string; body: unknown }> = [];
  await page.addInitScript(prefix => {
    window.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(String(url).replace(prefix, ''), protocols);
      }
    };
  }, hostProxy);
  await page.route(`**${hostProxy}/**`, route => route.continue({ url: route.request().url().replace(hostProxy, '') }));
  await page.route('**/api/v1/hosts', route => route.fulfill({ json: envelope({ hosts: [{
    id: hostId, host: 'example.test', enabled: true, status: 'ready',
  }] }) }));
  await page.route(url => url.searchParams.get('hosts') === 'include' && /\/(workspaces|sessions)(\/[^/]+)?$/.test(url.pathname), async route => {
    const local = new URL(route.request().url());
    local.searchParams.delete('hosts');
    const data = await page.evaluate(async url => (await (await fetch(url)).json() as { data: SessionDirectory }).data, local.href);
    for (const group of data.groups ?? []) {
      group.host_id = hostId;
      for (const session of group.sessions) session.host_id = hostId;
    }
    for (const item of data.items ?? []) item.host_id = hostId;
    if (local.pathname.endsWith(`/sessions/${sessionId}`)) data.host_id = hostId;
    await route.fulfill({ json: envelope(data) });
  });
  await page.route('**/api/v1/meta', route => route.fulfill({ json: envelope({
    server_version: '2.6.3', capabilities: {}, experimental_flags: { desktop_feedback: route.request().url().includes(hostProxy) ? flags.remote : flags.local },
  }) }));
  await page.route('**/api/v1/auth', route => route.fulfill({ json: envelope({
    models_ready: true, providers_count: 1, managed_provider: { status: 'authenticated' },
  }) }));
  await page.route('**/api/v1/oauth/userinfo*', route => route.fulfill({ json: envelope({
    kind: 'ok', userInfo: { userId: 'example-user', nickname: 'Example user' },
  }) }));
  await page.route('**/api/v1/feedback**', route => {
    requests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.fulfill({ json: envelope({ feedback_id: 31, upload_id: 32 }) });
  });
  const remoteSessionRead = page.waitForRequest(request => request.url().includes(`${hostProxy}/api/v1/sessions/${sessionId}`));
  await page.reload();
  await remoteSessionRead;
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  return { sessionId, requests };
}

test('local feedback remains available when the SSH conversation host disables it', async ({ app, model }) => {
  const { requests } = await openSshConversation(app, model, { local: true, remote: false });
  const page = app.window;
  await expect(page.getByRole('button', { name: 'Good response' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Poor response' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send feedback' })).toBeVisible();
  const input = page.getByRole('combobox', { name: 'Message input' });
  await input.fill('/feedback');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Include this conversation/ })).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Description' }).fill('A desktop issue');
  await app.snapshot('ssh-conversation-with-local-feedback');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.locator('.feedback-receipt-toast')).toContainText('31');
  expect(requests).toEqual([{ path: '/api/v1/feedback', body: expect.objectContaining({ kind: 'global', source: 'command', upload_session: false }) }]);
});

test('the SSH conversation accepts reply feedback when local feedback is disabled', async ({ app, model }) => {
  const { sessionId, requests } = await openSshConversation(app, model, { local: false, remote: true });
  const page = app.window;
  await expect(page.getByRole('button', { name: 'Send feedback' })).toHaveCount(0);
  const input = page.getByRole('combobox', { name: 'Message input' });
  await input.fill('/');
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option', { name: /\/feedback/i })).toHaveCount(0);
  await input.press('Escape');
  await input.fill('');
  await page.getByRole('button', { name: 'Good response' }).click();
  await expect(page.getByRole('button', { name: 'Remove like' })).toBeVisible();
  await app.snapshot('ssh-reply-feedback-without-local-feedback');
  expect(requests).toEqual([{ path: `${hostProxy}/api/v1/feedback`, body: expect.objectContaining({ kind: 'turn', session_id: sessionId, rating: 'up' }) }]);
});

test('attaches an SSH conversation to the locally submitted feedback', async ({ app, model }) => {
  const { sessionId, requests } = await openSshConversation(app, model, { local: true, remote: true });
  const page = app.window;
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Include this conversation');
  await dialog.getByText('Include this conversation', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => requests).toEqual([
    { path: '/api/v1/feedback', body: expect.objectContaining({ kind: 'global', session_id: sessionId, upload_session: true, upload_logs: false }) },
    { path: '/api/v1/feedback/31/attachments/session', body: { session_id: sessionId, host_id: hostId } },
  ]);
});
