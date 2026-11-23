import { basename } from 'node:path';
import { expect, test } from './fixtures/app';
import { held, say } from './fixtures/model';
import { expectOrder, relaunchAndSettle, rowMenu, sendAndFinish, sessionRow, sessionRowById, sidebarOf, transcriptOf } from './fixtures/sessions';

const ALPHA = 'Plan the release train';
const BETA = 'Draft the migration guide';
const GAMMA = 'Audit the flaky tests';
const RENAMED = 'Release checklist';
const ROCKET = '🚀';
const FORK_FOLLOW_UP = 'Continue the guide in the fork';

test('sessions are created, renamed, decorated, pinned, forked, archived, restored and deleted, and the result survives a relaunch', async ({ app, model }) => {
  const sidebar = sidebarOf(app);
  const ids: Record<string, string> = {};
  let fork = '';

  await test.step('create three sessions from the New Session button', async () => {
    ids[ALPHA] = await sendAndFinish(app, model, ALPHA, 'Alpha reply.');
    for (const [prompt, reply] of [[BETA, 'Beta reply.'], [GAMMA, 'Gamma reply.']] as const) {
      await sidebar.getByRole('button', { name: /^New Session/ }).click();
      await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
      await expect(transcriptOf(app).getByText(prompt)).toHaveCount(0);
      ids[prompt] = await sendAndFinish(app, model, prompt, reply);
    }
    await expectOrder(sidebar, [GAMMA, BETA, ALPHA]);
    for (const title of [ALPHA, BETA, GAMMA]) await expect(sessionRowById(app, ids[title]!)).toContainText(title);
    expect(new Set(Object.values(ids)).size).toBe(3);
    await app.snapshot('three-sessions');
  });

  await test.step('rename one session and give another an emoji', async () => {
    await (await rowMenu(app, GAMMA)).getByRole('menuitem', { name: 'Rename' }).click();
    const input = sidebar.getByRole('textbox');
    await expect(input).toHaveValue(GAMMA);
    await input.fill(RENAMED);
    await input.press('Enter');
    await expect(sidebar.getByText(RENAMED, { exact: true })).toBeVisible();
    await expect(sidebar.getByText(GAMMA, { exact: true })).toHaveCount(0);

    await (await rowMenu(app, BETA)).getByRole('menuitem', { name: 'Set Emoji…' }).click();
    const picker = app.window.getByRole('dialog', { name: 'Pick an emoji' });
    await picker.getByPlaceholder('Search emoji').fill('rocket');
    await picker.getByRole('button', { name: ROCKET, exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(sessionRow(app, BETA).getByRole('button', { name: 'Set Emoji…' })).toHaveText(ROCKET);
    await app.snapshot('renamed-and-emoji');
  });

  await test.step('pin the oldest session into the Pinned section', async () => {
    await (await rowMenu(app, ALPHA)).getByRole('menuitem', { name: 'Pin' }).click();
    await expect(sidebar.getByText('Pinned', { exact: true })).toBeVisible();
    await expectOrder(sidebar, ['Pinned', ALPHA, RENAMED, BETA]);
    await sessionRow(app, ALPHA).hover();
    await expect(sessionRow(app, ALPHA).getByRole('button', { name: 'Unpin' })).toBeVisible();
    await app.snapshot('pinned');
  });

  await test.step('fork from an earlier turn; only the retained transcript reaches the next request', async () => {
    await sidebar.getByText(BETA).click();
    await expect.poll(() => app.sessionId()).toBe(ids[BETA]);
    await sendAndFinish(app, model, 'Beta second prompt', 'Beta second reply.');
    const assistantMessage = transcriptOf(app).locator('.a-msg').first();
    const messageMeta = assistantMessage.locator('.a-msg-meta');
    await expect(messageMeta).toHaveCSS('opacity', '1');
    await app.snapshot('fork-actions');
    const forkButtons = transcriptOf(app).getByRole('button', { name: 'Fork from here' });
    await expect(forkButtons).toHaveCount(2);
    await forkButtons.first().click();
    await expect.poll(() => app.sessionId()).not.toBe(ids[BETA]);
    const forkId = await app.sessionId();
    expect(Object.values(ids)).not.toContain(forkId);
    await expect(transcriptOf(app).getByText(BETA, { exact: true })).toBeVisible();
    await expect(transcriptOf(app).getByText('Beta reply.', { exact: true })).toBeVisible();
    await expect(transcriptOf(app).getByText('Beta second prompt', { exact: true })).toHaveCount(0);
    await expect(transcriptOf(app).getByText('Beta second reply.', { exact: true })).toHaveCount(0);
    await expect(sessionRowById(app, forkId)).toBeVisible();

    model.script(say('Fork reply.'));
    const request = await app.startTurn(FORK_FOLLOW_UP);
    expect(request.texts('user').some(text => text.includes(BETA))).toBe(true);
    expect(request.texts('user').some(text => text.includes('Beta second prompt'))).toBe(false);
    expect(request.texts('assistant')).toContain('Beta reply.');
    expect(request.texts('assistant')).not.toContain('Beta second reply.');
    expect(request.userTextsSinceReply).toEqual([FORK_FOLLOW_UP]);
    await expect(transcriptOf(app).getByText('Fork reply.', { exact: true })).toBeVisible();
    await expect(sessionRowById(app, forkId)).toContainText(BETA);
    fork = forkId;
    await app.snapshot('forked');
  });

  await test.step('archive with the toast, undo it, then archive for real', async () => {
    const row = sessionRow(app, RENAMED);
    await row.hover();
    await row.getByRole('button', { name: 'Archive' }).click();
    await expect(row).toHaveCount(0);
    const undo = app.window.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();
    await expect(app.window.getByRole('status').filter({ has: undo }).locator('..')).toHaveCSS('opacity', '1');
    await app.snapshot('archive-toast');
    await undo.click();
    await expect(row).toHaveCount(1);

    await (await rowMenu(app, RENAMED)).getByRole('menuitem', { name: 'Archive' }).click();
    await expect(row).toHaveCount(0);
  });

  await test.step('restore the archived session from Settings → Archived Sessions', async () => {
    await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = app.window.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Archived Sessions' }).click();
    await expect(settings.getByText(RENAMED, { exact: true })).toBeVisible();
    await expect(settings.getByText(basename(app.workspace), { exact: true })).toBeVisible();
    await expect(settings.getByText(/^Archived \d{4}-/)).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Restore' })).toHaveCount(1);
    await app.snapshot('archived-settings');
    await settings.getByRole('button', { name: 'Restore' }).click();
    await expect(settings.getByText(RENAMED)).toHaveCount(0);
    await settings.getByRole('button', { name: 'Close (Esc)' }).click();
    await expect(settings).toBeHidden();
    await expect(sessionRow(app, RENAMED)).toHaveCount(1);
  });

  await test.step('delete the fork after confirming', async () => {
    await (await rowMenu(app, sessionRowById(app, fork))).getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = app.window.getByRole('dialog', { name: 'Delete session' });
    await expect(confirm).toContainText('This cannot be undone');
    await app.snapshot('delete-confirm');
    await confirm.getByRole('button', { name: 'Permanently delete' }).click();
    await expect(confirm).toBeHidden();
    await expect(app.window.getByText('Session deleted')).toBeVisible();
    await expect(sessionRowById(app, fork)).toHaveCount(0);
  });

  await test.step('fork the first running prompt while the source continues', async () => {
    await sidebar.getByRole('button', { name: /^New Session/ }).click();
    model.script(held('first-running-fork', say('Running answer')));
    await app.startTurn('First running question');
    await model.waitForHeldTurn();
    const runningSource = await app.sessionId();
    await (await rowMenu(app, sessionRowById(app, runningSource))).getByRole('menuitem', { name: 'Fork session' }).click();
    await expect.poll(() => app.sessionId()).not.toBe(runningSource);
    const runningFork = await app.sessionId();
    await expect(transcriptOf(app).getByText('First running question', { exact: true })).toBeVisible();
    await expect(transcriptOf(app).getByText('Running answer', { exact: true })).toHaveCount(0);

    model.releaseTurns();
    await sessionRowById(app, runningSource).click();
    await expect(transcriptOf(app).getByText('Running answer', { exact: true })).toBeVisible();

    for (const id of [runningFork, runningSource]) {
      await (await rowMenu(app, sessionRowById(app, id))).getByRole('menuitem', { name: 'Delete' }).click();
      const confirm = app.window.getByRole('dialog', { name: 'Delete session' });
      await confirm.getByRole('button', { name: 'Permanently delete' }).click();
      await expect(confirm).toBeHidden();
      await expect(sessionRowById(app, id)).toHaveCount(0);
    }
  });

  await test.step('pinned, order, titles and emoji survive a relaunch', async () => {
    await sidebar.getByText(ALPHA).click();
    await expect.poll(() => app.sessionId()).toBe(ids[ALPHA]);
    await relaunchAndSettle(app);
    const restored = sidebarOf(app);
    await expect(restored.getByText('Pinned', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expectOrder(restored, ['Pinned', ALPHA, BETA, RENAMED]);
    await expect(sessionRow(app, BETA).getByRole('button', { name: 'Set Emoji…' })).toHaveText(ROCKET);
    await expect(sessionRowById(app, fork)).toHaveCount(0);
    await app.snapshot('after-relaunch');
  });

  await test.step('with the tabbed list, Mark as done moves a session to Done and Mark as open brings it back', async () => {
    await sidebarOf(app).getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = app.window.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Lab' }).click();
    await settings.getByRole('switch', { name: 'Tabbed session list' }).click();
    await settings.getByRole('button', { name: 'Close (Esc)' }).click();
    await expect(settings).toBeHidden();

    await (await rowMenu(app, BETA)).getByRole('menuitem', { name: 'Mark as done' }).click();
    await expect(sidebarOf(app).getByText(BETA)).toHaveCount(0);
    await sidebarOf(app).getByRole('tab', { name: 'Done' }).click();
    await expect(sidebarOf(app).getByText(BETA)).toBeVisible();
    await expect(sidebarOf(app).getByText(ALPHA)).toHaveCount(0);
    await app.snapshot('done-tab');

    await (await rowMenu(app, BETA)).getByRole('menuitem', { name: 'Mark as open' }).click();
    await expect(sidebarOf(app).getByText(BETA)).toHaveCount(0);
    await sidebarOf(app).getByRole('tab', { name: 'Open' }).click();
    await expect(sidebarOf(app).getByText(BETA)).toBeVisible();
    await expect(sidebarOf(app).getByText(ALPHA)).toBeVisible();
  });
});
