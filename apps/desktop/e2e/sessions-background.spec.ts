import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { bash, held, say } from './fixtures/model';
import { relaunchAndSettle, sendAndFinish, sessionRowById, sidebarOf, transcriptOf } from './fixtures/sessions';

const A = 'Watch the nightly build';
const A_REPLY = 'The nightly build is green.';
const B = 'Summarise the changelog';
const B_REPLY = 'Three fixes and one feature.';
const A_FOLLOW_UP = 'Clean the build cache';
const MARKER = 'cache-cleaned.txt';

test.use({ permissionMode: 'manual' });

test('a session keeps working in the background while another is used, and search and shortcuts move between sessions', async ({ app, model }) => {
  const sidebar = () => sidebarOf(app);
  let a = '';
  let b = '';

  await test.step('start a long turn in session A', async () => {
    model.script(held('nightly', say(A_REPLY)));
    const hold = model.hold('nightly');
    await app.startTurn(A);
    await hold.reached();
    a = await app.sessionId();
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
    await expect(sessionRowById(app, a).getByRole('status', { name: 'Loading' })).toBeVisible();
  });

  await test.step('Mod+N opens a new session; it runs while A is still busy', async () => {
    await app.window.keyboard.press('ControlOrMeta+n');
    await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
    await expect(transcriptOf(app).getByText(A)).toHaveCount(0);
    b = await sendAndFinish(app, model, B, B_REPLY);
    expect(b).not.toBe(a);
    expect(model.request(1).texts('user').some(text => text.includes(A))).toBe(false);
    await expect(sessionRowById(app, a).getByRole('status', { name: 'Loading' })).toBeVisible();
    await expect(sessionRowById(app, b).getByRole('status', { name: 'Loading' })).toHaveCount(0);
    await app.snapshot('a-running-in-background');
  });

  await test.step('when A finishes in the background its row turns unread until it is opened', async () => {
    model.hold('nightly').release();
    await expect(sessionRowById(app, a).getByRole('status', { name: 'Loading' })).toHaveCount(0);
    await expect(sessionRowById(app, a).getByTestId('session-unread')).toBeVisible();
    await expect(sessionRowById(app, b).getByTestId('session-unread')).toHaveCount(0);
    await app.snapshot('a-unread');
    await sidebar().getByText(A).click();
    await expect.poll(() => app.sessionId()).toBe(a);
    await expect(transcriptOf(app).getByText(A_REPLY, { exact: true })).toBeVisible();
    await expect(sessionRowById(app, a).getByTestId('session-unread')).toHaveCount(0);
  });

  await test.step('an approval waiting in A shows the Approve badge while B is open', async () => {
    model.script(bash(`echo cleaned > ${MARKER}`, { description: 'Clean the cache' }), say('Cache cleaned.'));
    await app.startTurn(A_FOLLOW_UP);
    await expect(app.window.getByText('Run command?')).toBeVisible();
    await sidebar().getByText(B).click();
    await expect.poll(() => app.sessionId()).toBe(b);
    await expect(transcriptOf(app).getByText(B_REPLY, { exact: true })).toBeVisible();
    await expect(app.window.getByText('Run command?')).toBeHidden();
    const badge = sessionRowById(app, a).getByText('Approve', { exact: true });
    await expect(badge).toBeVisible();
    await expect(sessionRowById(app, b).getByText('Approve', { exact: true })).toHaveCount(0);
    expect(existsSync(join(app.workspace, MARKER))).toBe(false);
    await app.snapshot('approve-badge-from-b');

    await sidebar().getByText(A).click();
    await app.window.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(transcriptOf(app).getByText('Cache cleaned.', { exact: true })).toBeVisible();
    await expect(badge).toHaveCount(0);
    expect(existsSync(join(app.workspace, MARKER))).toBe(true);
    expect(model.requests()).toHaveLength(4);
  });

  await test.step('Mod+K finds sessions by title and by workspace and opens one from the keyboard', async () => {
    await app.window.keyboard.press('ControlOrMeta+k');
    const dialog = app.window.getByRole('dialog', { name: 'Search sessions and projects' });
    const query = dialog.getByRole('textbox', { name: 'Search sessions and projects' });
    await expect(query).toBeFocused();
    await query.fill('changelog');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(dialog.getByRole('option')).toContainText(B);
    await query.fill('workspace');
    await expect(dialog.getByRole('option').filter({ hasText: A })).toHaveCount(1);
    await expect(dialog.getByRole('option').filter({ hasText: B })).toHaveCount(1);
    await app.snapshot('search-by-workspace');
    await query.fill('nightly');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await query.fill('');
    await expect(dialog.getByRole('option', { selected: true })).toHaveCount(1);
    const target = dialog.getByRole('option').filter({ hasText: B });
    for (let step = 0; step < 10 && await target.getAttribute('aria-selected') !== 'true'; step += 1) {
      await query.press('ArrowDown');
    }
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await query.press('Enter');
    await expect(dialog).toBeHidden();
    await expect.poll(() => app.sessionId()).toBe(b);
    await expect(transcriptOf(app).getByText(B_REPLY, { exact: true })).toBeVisible();
  });

  await test.step('Shift+Mod+[ and ] move to the sibling sessions', async () => {
    await app.window.keyboard.press('Shift+ControlOrMeta+BracketRight');
    await expect.poll(() => app.sessionId()).toBe(a);
    await expect(transcriptOf(app).getByText('Cache cleaned.', { exact: true })).toBeVisible();
    await app.window.keyboard.press('Shift+ControlOrMeta+BracketLeft');
    await expect.poll(() => app.sessionId()).toBe(b);
    await app.window.keyboard.press('Shift+ControlOrMeta+BracketLeft');
    await expect.poll(() => app.sessionId()).toBe(a);
  });

  await test.step('Mod+W closes the session view and Mod+N starts a fresh session', async () => {
    await app.window.keyboard.press('ControlOrMeta+w');
    await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
    await expect(transcriptOf(app).getByText(A_REPLY)).toHaveCount(0);
    await expect(sidebar().getByText(A)).toBeVisible();
    await sidebar().getByText(B).click();
    await expect.poll(() => app.sessionId()).toBe(b);
    await app.window.keyboard.press('ControlOrMeta+n');
    await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
    await expect(sidebar().locator('[data-session-id]')).toHaveCount(2);
  });

  await test.step('a reload keeps the session from the URL open', async () => {
    await sidebar().getByText(B).click();
    await expect.poll(() => app.sessionId()).toBe(b);
    await app.window.reload();
    await expect(transcriptOf(app).getByText(B_REPLY, { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await app.sessionId()).toBe(b);
  });

  await test.step('after a relaunch both sessions are back without stale running, unread or approval state', async () => {
    await relaunchAndSettle(app);
    await expect(sidebar().getByText(A)).toBeVisible();
    await expect(sidebar().getByText(B)).toBeVisible();
    await expect(sidebar().getByRole('status', { name: 'Loading' })).toHaveCount(0);
    await expect(sidebar().getByTestId('session-unread')).toHaveCount(0);
    await expect(sidebar().getByText('Approve', { exact: true })).toHaveCount(0);
  });

  await test.step('the sidebar opens the earlier session after the relaunch', async () => {
    await sidebar().getByText(B).click();
    await expect.poll(() => app.sessionId()).toBe(b);
    await expect(transcriptOf(app).getByText(B_REPLY, { exact: true })).toBeVisible();
    await app.snapshot('after-relaunch');
  });
});
