import type { Locator, Page } from '@playwright/test';
import { held, say } from '@moonshot-ai/testkit/model';

import { expect, testWithProvider, type DesktopApp } from './fixtures/app';
import { captureClipboardWrites } from './fixtures/clipboard';
import { sessionRowById } from './fixtures/sessions';

const envelope = (data: unknown) => ({ code: 0, msg: '', data });

async function openAccountMenu(page: Page): Promise<Locator> {
  await page.locator('.user-menu-trigger').click();
  return page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: /^Settings/ }) });
}

async function openAccountFeedback(page: Page): Promise<void> {
  const menu = await openAccountMenu(page);
  await menu.getByRole('menuitem', { name: 'Feedback', exact: true }).click();
}

function themeColor(page: Page, name: string): Promise<string> {
  return page.evaluate(property => {
    const swatch = document.createElement('span');
    swatch.style.color = getComputedStyle(document.documentElement).getPropertyValue(property);
    return swatch.style.color;
  }, name);
}

async function expectSelectedFeedbackPillOnHover(pill: Locator): Promise<void> {
  const page = pill.page();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.mouse.move(0, 0);
    await expect(pill).toHaveCSS('color', await themeColor(page, '--color-accent'));
    const selected = await pill.screenshot({ animations: 'disabled', scale: 'css' });
    await pill.hover();
    expect((await pill.screenshot({ animations: 'disabled', scale: 'css' })).equals(selected)).toBe(true);
  }
}

async function expectStableEditorOnFocus(input: Locator, editor = input): Promise<void> {
  await expect(input).not.toBeFocused();
  const box = await editor.boundingBox();
  if (!box) throw new Error('Feedback editor is not visible');
  const clip = { x: box.x + 8, y: box.y + 8, width: box.width - 16, height: box.height - 16 };
  const capture = () => input.page().screenshot({ clip, caret: 'hide', animations: 'disabled' });
  const idle = await capture();
  await input.click();
  await expect(input).toBeFocused();
  expect(await editor.boundingBox()).toEqual(box);
  expect((await capture()).equals(idle), 'Text and counter stay in place on focus').toBe(true);
}

async function expectVisibleCheckmark(app: DesktopApp, checkbox: Locator): Promise<void> {
  const icon = checkbox.locator('..').locator('.ui-check__box');
  const png = await icon.screenshot({ scale: 'css', animations: 'disabled' });
  const pixels = await app.electron.evaluate(({ nativeImage }, data) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
    const { width, height } = image.getSize();
    const icon = image.crop({ x: width - 16, y: height - 16, width: 16, height: 16 });
    const fill = icon.crop({ x: 7, y: 4, width: 1, height: 1 }).toBitmap();
    const peakContrast = (x: number, y: number, width = 1, height = 1) =>
      icon.crop({ x, y, width, height }).toBitmap().reduce((peak, channel, i) =>
        Math.max(peak, Math.abs(channel - fill[i % 4]!)), 0);
    return {
      surface: peakContrast(0, 0),
      shortStroke: peakContrast(4, 7, 2, 2),
      bend: peakContrast(6, 9, 3, 2),
      longStroke: peakContrast(9, 5, 3, 3),
    };
  }, png.toString('base64'));
  const minimumContrast = Math.max(32, pixels.surface / 4);
  expect(pixels.shortStroke, 'short stroke of the checkmark').toBeGreaterThan(minimumContrast);
  expect(pixels.bend, 'bend of the checkmark').toBeGreaterThan(minimumContrast);
  expect(pixels.longStroke, 'long stroke of the checkmark').toBeGreaterThan(minimumContrast);
}

testWithProvider('submits global and reply feedback with opt-in attachments', async ({ app, provider }) => {
  const page = app.window;
  const feedbackRequests: Array<{ path: string; method: string; body: unknown }> = [];
  const uploaded: Array<{ kind: string | null; bytes: Buffer }> = [];
  const sessionUploads: Array<{ path: string; body: unknown }> = [];
  let signedIn = false;
  let failSubmission = true;
  let failDiagnostics = true;
  let nextFeedbackId = 21;
  let releaseDiagnostics!: () => void;
  const pendingDiagnostics = new Promise<void>(resolve => { releaseDiagnostics = resolve; });

  await page.route('**/api/v1/client-configs/feedback_form', route => route.fulfill({ status: 404 }));
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
      if (kind === 'diagnostics') {
        if (failDiagnostics) {
          failDiagnostics = false;
          await route.fulfill({ status: 503, json: { code: 50000, msg: 'Offline' } });
          return;
        }
        await pendingDiagnostics;
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

  await expect(page.getByRole('button', { name: 'Send feedback', exact: true })).toHaveCount(0);
  const account = await openAccountMenu(page);
  const preferences = account.getByRole('menuitem').filter({ hasText: /Settings|Appearance|Language|Feedback/ });
  await expect(preferences).toHaveText([/^Settings/, /^Appearance/, /^Language/, 'Feedback']);
  const menuIcons = preferences.locator(':scope > :first-child');
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect.poll(() => menuIcons.evaluateAll(icons => {
      const colors = icons.map(icon => {
        const path = icon.querySelector('path');
        if (!path) return getComputedStyle(icon).backgroundColor;
        const { fill, stroke } = getComputedStyle(path);
        return fill === 'none' ? stroke : fill;
      });
      return [...new Set(colors)];
    })).toHaveLength(1);
  }
  await account.getByRole('menuitem', { name: 'Feedback', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Kimi Code' })).toBeVisible();
  expect(feedbackRequests).toHaveLength(0);

  signedIn = true;
  await page.reload();
  await openAccountFeedback(page);
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  const guideUrl = 'https://www.kimi.com/code/docs/en/kimi-code/feedback.html';
  await expect(dialog.getByRole('link', { name: 'Learn more', exact: true })).toHaveAttribute('href', guideUrl);
  await expectSelectedFeedbackPillOnHover(dialog.getByRole('button', { name: 'Bug', exact: true }));
  const notice = dialog.locator('.global-feedback-note');
  await expect(notice).toHaveText('The feedback content you select and submit will be used to identify issues and improve Kimi Code. Learn more');
  await expect(dialog).toHaveCSS('width', '560px');
  await expect(dialog).toHaveCSS('height', '502px');
  await expect(dialog.getByRole('checkbox', { name: /Submit diagnostic logs/ })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Submit this conversation/ })).toHaveCount(0);
  const description = dialog.getByRole('textbox', { name: 'Description' });
  await expectStableEditorOnFocus(description);
  await description.fill('A reproducible issue');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  const input = page.getByRole('combobox', { name: 'Message input' });
  await input.fill('/feedback');
  await input.press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Description' })).toHaveValue('A reproducible issue');
  await app.snapshot('global-feedback');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Couldn’t submit feedback, please try again');
  await expect(dialog.getByRole('textbox', { name: 'Description' })).toHaveValue('A reproducible issue');
  await dialog.getByRole('button', { name: 'Resubmit' }).click();
  const receipt = (id: number) => page.getByRole('status').filter({ has: page.getByText(`Feedback submitted · ID ${id}`, { exact: true }) });
  await expect(dialog).toBeHidden();
  await expect(receipt(21)).toBeVisible();
  await receipt(21).hover();
  const surfaces: string[] = [];
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    const surface = await themeColor(page, '--color-surface-raised');
    await expect(receipt(21)).toHaveCSS('background-color', surface);
    surfaces.push(surface);
  }
  expect(surfaces[0]).not.toBe(surfaces[1]);
  const clipboardWrites = await captureClipboardWrites(app);
  await receipt(21).getByRole('button', { name: 'Copy ID', exact: true }).click();
  await expect(receipt(21).getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect.poll(clipboardWrites).toEqual(['21']);
  await receipt(21).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(receipt(21)).toBeHidden();
  expect(feedbackRequests.map(({ body }) => body)).toEqual([
    { kind: 'global', source: 'command', category: 'bug', content: 'A reproducible issue', client: 'desktop', upload_session: false, upload_logs: false },
    { kind: 'global', source: 'command', category: 'bug', content: 'A reproducible issue', client: 'desktop', upload_session: false, upload_logs: false },
  ]);
  expect(uploaded).toHaveLength(0);

  provider.script(held('first-chunk', say(['A completed', ' answer.']), 1));
  await app.submit('Inspect the issue');
  const firstChunk = provider.hold('first-chunk');
  await firstChunk.reached();
  try {
    await expect(page.getByText('A completed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Good response' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Poor response' })).toBeHidden();
  } finally {
    firstChunk.release();
  }
  await expect(page.getByText('A completed answer.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Poor response' }).click();
  const details = page.getByRole('dialog', { name: 'What could be better?' });
  await expect(details.getByRole('link', { name: 'Learn more about what you submit' })).toHaveAttribute('href', guideUrl);
  await expect(details).toHaveCSS('width', '400px');
  await expect(details.getByRole('checkbox', { name: 'Also submit this conversation' })).not.toBeChecked();
  const heading = details.getByText('What could be better?', { exact: true });
  for (const [colorScheme, fontSize, lineHeight, sectionGap] of [
    ['dark', '14px', '20px', '12px'],
    ['light', '16px', '24px', '16px'],
  ] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(heading).toHaveCSS('font-size', fontSize);
    await expect(heading).toHaveCSS('line-height', lineHeight);
    await expect(details).toHaveCSS('row-gap', sectionGap);
    await expect(details.getByRole('group')).toHaveCSS('gap', '8px');
  }
  await app.snapshot('reply-feedback');
  const replyDescription = details.getByRole('textbox');
  const replyEditor = details.locator('.feedback-editor');
  await expectStableEditorOnFocus(replyDescription, replyEditor);
  await replyDescription.fill('Some feedback');
  await replyDescription.press('Tab');
  await expectStableEditorOnFocus(replyDescription, replyEditor);
  const replyEditorBox = await replyEditor.boundingBox();
  if (!replyEditorBox) throw new Error('Feedback editor is not visible');
  await replyDescription.press('Tab');
  await expect(replyDescription).not.toBeFocused();
  await replyEditor.click({ position: { x: replyEditorBox.width / 2, y: replyEditorBox.height / 2 } });
  await expect(replyDescription).toBeFocused();
  await replyDescription.press('Tab');
  await expect(replyDescription).not.toBeFocused();
  await replyEditor.locator('.feedback-count').click();
  await expect(replyDescription).toBeFocused();
  const replySubmit = details.getByRole('button', { name: 'Submit', exact: true });
  await expect(replySubmit).toBeDisabled();
  const incorrect = details.getByRole('button', { name: 'Incorrect or incomplete' });
  await incorrect.click();
  await expectSelectedFeedbackPillOnHover(incorrect);
  await expect(replySubmit).toBeEnabled();
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
  const replyConversationLabel = details.getByText('Also submit this conversation', { exact: true });
  await replyConversationLabel.click();
  await expect(details.getByRole('checkbox')).toBeChecked();
  await expectVisibleCheckmark(app, details.getByRole('checkbox'));
  await replyConversationLabel.click();
  await replyDescription.fill('');
  await expect(replySubmit).toBeEnabled();
  const retryDetail = 'Details to keep after a failed submission';
  await replyDescription.fill(retryDetail);
  failSubmission = true;
  await replySubmit.click();
  const failedUpdate = page.getByRole('status').filter({ hasText: 'Couldn’t submit feedback, please try again' });
  await failedUpdate.getByRole('button', { name: 'Dismiss' }).click();
  await expect(failedUpdate).toBeHidden();
  await expect(replyDescription).toHaveValue(retryDetail);
  await expect(incorrect).toHaveAttribute('aria-pressed', 'true');
  await replyDescription.fill('');
  await details.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(receipt(22)).toBeVisible();
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: 'Remove dislike' }).click();
  await expect(page.getByRole('button', { name: 'Poor response' })).toBeVisible();
  expect(feedbackRequests.slice(2)).toEqual([
    { path: '/api/v1/feedback', method: 'POST', body: { kind: 'turn', rating: 'down', session_id: await app.sessionId(), turn_id: expect.any(String), reply_id: expect.any(String), client: 'desktop' } },
    { path: '/api/v1/feedback/22', method: 'PATCH', body: { kind: 'details', reasons: ['incorrect'], content: retryDetail, upload_session: false } },
    { path: '/api/v1/feedback/22', method: 'PATCH', body: { kind: 'details', reasons: ['incorrect'], upload_session: false } },
    { path: '/api/v1/feedback/22', method: 'PATCH', body: { kind: 'cancel' } },
  ]);

  await openAccountFeedback(page);
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Issue with an attachment');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const picker = dialog.locator('input[type="file"]');
  const emptyImage = { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) };
  const validImage = { name: 'screen.png', mimeType: 'image/png', buffer: image };
  await picker.setInputFiles([emptyImage, { name: 'empty.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(0) }, validImage]);
  await expect(dialog.getByRole('button', { name: /^Remove empty/ })).toHaveCount(0, { timeout: 3000 });
  await expect(dialog.getByRole('alert')).toHaveText('Empty files can’t be attached');
  await dialog.getByRole('button', { name: 'Remove screen.png' }).click();
  await expect(dialog.getByRole('alert')).toBeHidden();
  await picker.setInputFiles(emptyImage);
  await expect(dialog.getByRole('alert')).toHaveText('Empty files can’t be attached');
  await picker.setInputFiles(validImage);
  await expect(dialog.getByRole('alert')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Remove screen.png' })).toBeVisible();
  await dialog.getByText('Submit diagnostic logs', { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /Submit diagnostic logs/ })).toBeChecked();
  await expectVisibleCheckmark(app, dialog.getByRole('checkbox', { name: /Submit diagnostic logs/ }));
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(receipt(23)).toBeVisible();
  const uploadFailure = page.getByRole('status').filter({ hasText: 'Couldn’t submit diagnostic logs' });
  await expect(uploadFailure).toBeVisible();
  await expect(receipt(23)).toBeVisible();
  await expect.poll(() => uploaded.map(({ kind }) => kind)).toEqual(['media', 'diagnostics']);
  expect(uploaded[0]?.bytes.includes(image)).toBe(true);
  expect(uploaded[1]?.bytes.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  const submitCount = feedbackRequests.length;
  const uploading = page.getByRole('status').filter({ hasText: 'Submitting…' });
  try {
    await uploadFailure.getByRole('button', { name: 'Retry submission' }).click();
    await expect.poll(() => uploaded.map(({ kind }) => kind)).toEqual(['media', 'diagnostics', 'diagnostics']);
    await expect(uploadFailure).toBeHidden();
    await expect(uploading.locator('.ui-spinner')).toBeVisible();
  } finally {
    releaseDiagnostics();
  }
  await expect(page.getByRole('status').filter({ hasText: 'Submitted diagnostic logs' })).toBeVisible();
  await expect(uploading).toBeHidden();
  expect(feedbackRequests).toHaveLength(submitCount);
  expect(feedbackRequests.at(-1)?.body).toMatchObject({ client: 'desktop', upload_logs: true, upload_session: false });

  const originalSession = await app.sessionId();
  await openAccountFeedback(page);
  await dialog.getByRole('button', { name: 'Feature request' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /^New Session/ }).first().click();
  provider.script(say('The next answer.'));
  await app.submit('Start another conversation');
  await expect(page.getByText('The next answer.', { exact: true })).toBeVisible();
  const nextSession = await app.sessionId();
  expect(nextSession).not.toBe(originalSession);
  await openAccountFeedback(page);
  await expect(dialog.getByRole('button', { name: 'Feature request' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Keep the original conversation');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(receipt(24)).toBeVisible();
  expect(feedbackRequests.at(-1)?.body).toMatchObject({ session_id: originalSession, category: 'suggestion', upload_session: false });

  const conversationOption = dialog.getByRole('checkbox', { name: 'Submit this conversation' });
  const conversationLabel = dialog.getByText('Submit this conversation', { exact: true });
  await openAccountFeedback(page);
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Attach the conversation I choose');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sessionRowById(app, originalSession).click();
  await expect(page.getByText('A completed answer.', { exact: true })).toBeVisible();
  await openAccountFeedback(page);
  await conversationLabel.click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await openAccountFeedback(page);
  await expect(conversationOption).toBeChecked();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(receipt(25)).toBeVisible();
  await expect.poll(() => sessionUploads).toHaveLength(1);
  expect(sessionUploads).toEqual([{ path: '/api/v1/feedback/25/attachments/session', body: { session_id: originalSession } }]);
  expect(feedbackRequests.at(-1)?.body).toMatchObject({ session_id: originalSession, upload_session: true });

  await openAccountFeedback(page);
  await dialog.getByRole('textbox', { name: 'Description' }).fill('Keep the text across conversations');
  await conversationLabel.click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: /^New Session/ }).first().click();
  await openAccountFeedback(page);
  await expect(conversationOption).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await sessionRowById(app, nextSession).click();
  await expect(page.getByText('The next answer.', { exact: true })).toBeVisible();
  await openAccountFeedback(page);
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

  await openAccountFeedback(page);
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
