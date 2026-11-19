import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { agentBadge, browse } from './fixtures/browser';
import { held, type StubModel } from './fixtures/model';

const DIALOG_REMINDER = 'The built-in browser had page dialogs you have not seen';

function dialogReminders(model: StubModel, from: number): string[] {
  return model.requests().slice(from).flatMap(request => request.remindersSinceReply).filter(reminder => reminder.startsWith(DIALOG_REMINDER));
}

test('undelivered dialog records reach the next turn once, follow the session and are dropped with it', async ({ app, agent, model, pages }) => {
  let control!: Page;
  let controlBar!: Locator;
  let pageDialog!: Locator;
  const running = app.window.getByRole('button', { name: /^Interrupt/ });
  const attention = app.window.getByRole('complementary').getByText('Approve', { exact: true });
  let alertTab = '';
  let alertPage: Page | undefined;

  await test.step('an alert opens after the last tool call and the turn ends with it pending', async () => {
    alertTab = await agent.openTab(pages.url('alert.html'));
    alertPage = await app.page(candidate => candidate.startsWith(pages.url('alert.html')), 'alert fixture');
    await expect(alertPage.getByText('Idle')).toBeVisible();
    control = await app.controlSurface();
    controlBar = control.getByRole('toolbar', { name: 'Agent is in control' });
    pageDialog = (await app.overlay()).getByRole('dialog', { name: /says$/ });
    const click = await agent.click(alertTab, { role: 'button', name: 'Sync in the background' });
    expect(click.ok).toBe(true);
    expect(click.pendingDialogs).toBeUndefined();

    await expect(pageDialog).toBeVisible({ timeout: 15_000 });
    await expect(pageDialog).toContainText('Sync finished');
    await expect(agentBadge(pageDialog)).toBeVisible();
    await expect(controlBar).toBeVisible();
    await app.snapshot('alert-after-last-tool-call');

    model.releaseTurns();
    await expect(controlBar).toBeHidden();
    await expect(running).toBeHidden();
    await expect(pageDialog).toBeVisible();
    await expect(agentBadge(pageDialog)).toBeHidden();
    await expect(attention).toBeVisible();
    await app.snapshot('turn-ended-alert-pending');
  });

  await test.step('the next turn is told about the pending alert exactly once', async () => {
    const second = model.agentRequests();
    await app.startAgentTurn('Continue with the browser.');
    const reminders = dialogReminders(model, second);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain(`Tab ${alertTab} "Background sync"`);
    expect(reminders[0]).toContain('- alert "Sync finished" from ' + pages.origin);
    expect(reminders[0]).toContain('is still waiting for an answer; the user can answer it in the browser panel.');
    expect(reminders[0]!.split('Sync finished')).toHaveLength(2);

    model.releaseTurns();
    await expect(running).toBeHidden();
    const third = model.agentRequests();
    await app.startAgentTurn('Keep going.');
    expect(model.agentRequests()).toBeGreaterThan(third);
    expect(dialogReminders(model, third)).toEqual([]);

    await pageDialog.getByRole('button', { name: 'OK' }).click();
    await expect(pageDialog).toBeHidden();
    await expect(alertPage!.getByText('Sync acknowledged')).toBeVisible();
    const resumed = await agent.run('browser.activate_tab', { tabId: alertTab });
    expect(resumed.ok).toBe(true);
    const state = await agent.run('tab.get_state', { tabId: alertTab });
    expect(state.pendingDialogs).toBeUndefined();
    expect([...(resumed.handledDialogs ?? []), ...(state.handledDialogs ?? [])]).toEqual([
      expect.objectContaining({ kind: 'alert', message: 'Sync finished', outcome: 'accepted', answerer: 'user' }),
    ]);
    await expect(controlBar).toBeVisible();
    await expect(pageDialog).toBeHidden();
    await expect(attention).toBeHidden();
    await app.snapshot('indicator-without-stale-dialog');
  });

  let confirmTab = '';
  let confirmPage: Page | undefined;
  await test.step('a confirm answered outside agent control is carried into the next control', async () => {
    confirmTab = await agent.openTab(pages.url('confirm.html'));
    confirmPage = await app.page(candidate => candidate.startsWith(pages.url('confirm.html')), 'confirm fixture');
    await expect(confirmPage.getByText('No decision yet')).toBeVisible();
    const click = await agent.click(confirmTab, { role: 'button', name: 'Delete draft' });
    expect(click.pendingDialogs).toEqual([expect.objectContaining({ kind: 'confirm', message: 'Delete the draft?', answerer: 'agent' })]);
    model.releaseTurns();
    await expect(controlBar).toBeHidden();
    await expect(running).toBeHidden();

    const fourth = model.agentRequests();
    model.script(held('check-draft', browse('browser.activate_tab', { tabId: confirmTab }, 'Checking the draft page.'), 1));
    const reply = model.hold('check-draft');
    await app.window.getByRole('combobox').first().click();
    await app.window.keyboard.type('Check the draft page.');
    await app.window.keyboard.press('Enter');
    await expect.poll(() => model.agentRequests()).toBeGreaterThan(fourth);
    const pending = dialogReminders(model, fourth);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain(`Tab ${confirmTab} "Draft settings"`);
    expect(pending[0]).toContain('- confirm "Delete the draft?" from ' + pages.origin);
    expect(pending[0]).toContain('is still waiting for an answer');
    expect(pending[0]).not.toContain('Sync finished');

    await expect(pageDialog).toContainText('Delete the draft?');
    await expect(agentBadge(pageDialog)).toBeHidden();
    await pageDialog.getByRole('button', { name: 'OK' }).click();
    await expect(pageDialog).toBeHidden();
    await expect(confirmPage!.getByText('Draft deleted')).toBeVisible();

    reply.release();
    await expect(app.window.getByText('Take control of tab')).toBeVisible();
    await app.window.getByRole('button', { name: 'Approve', exact: true }).click();
    await model.waitForHeldTurn();
    const messages = model.requests().at(-1)!.messages;
    const toolResult = JSON.stringify(messages.at(-1));
    expect(messages.at(-1)?.role).toBe('tool');
    expect(toolResult).toContain('handledDialogs');
    expect(toolResult).toContain('Delete the draft?');
    await expect(controlBar).toBeVisible();
    await expect(control.locator('.control-records-badge')).toBeVisible();
    await control.getByRole('button', { name: 'Handled page dialogs' }).click();
    const history = control.getByRole('dialog', { name: 'Page dialogs this session' });
    await expect(history).toBeVisible();
    const carried = history.getByRole('listitem').filter({ hasText: 'Delete the draft?' });
    await expect(carried).toContainText('Confirmation');
    await expect(carried).toContainText('Accepted by you');
    await app.snapshot('popover-with-carried-record');
  });

  await test.step('the chat message lists the dialog under Sources', async () => {
    model.releaseTurns();
    await expect(controlBar).toBeHidden();
    await expect(running).toBeHidden();
    const pill = app.window.getByRole('button', { name: /1 page dialog/ });
    await expect(pill).toBeVisible();
    await pill.click();
    const sources = app.window.getByRole('region', { name: 'Pages browsed in this reply' });
    const group = sources.getByRole('list', { name: 'Page dialogs' });
    await expect(group).toBeVisible();
    const row = group.getByRole('listitem').filter({ hasText: 'Delete the draft?' });
    await expect(row).toContainText('Confirmation');
    await expect(row).toContainText(`${pages.origin} · Accepted by you`);
    await app.snapshot('sources-dialogs-group');
  });

  await test.step('deleting the session detaches its pending dialog and drops its records', async () => {
    await app.startAgentTurn('Try deleting the draft again.');
    expect((await agent.run('browser.activate_tab', { tabId: confirmTab })).ok).toBe(true);
    const click = await agent.click(confirmTab, { role: 'button', name: 'Delete draft' });
    expect(click.pendingDialogs).toEqual([expect.objectContaining({ kind: 'confirm', message: 'Delete the draft?', answerer: 'agent' })]);
    await expect(pageDialog).toBeVisible();
    model.releaseTurns();
    await expect(controlBar).toBeHidden();
    await expect(running).toBeHidden();
    await expect(pageDialog).toContainText('Delete the draft?');
    await expect(agentBadge(pageDialog)).toBeHidden();

    const row = app.window.getByRole('complementary').getByText('Use the browser to check the fixture page.');
    await row.click({ button: 'right' });
    await app.window.getByRole('menuitem', { name: 'Delete' }).click();
    const confirmDelete = (await app.overlay()).getByRole('dialog', { name: 'Delete session' });
    await expect(confirmDelete).toBeVisible();
    await confirmDelete.getByRole('button', { name: 'Permanently delete' }).click();
    await expect(app.window.getByText('Session deleted')).toBeVisible();
    await expect(pageDialog).toBeHidden();
    await app.snapshot('after-session-delete');

    const next = model.agentRequests();
    const fresh = await app.startAgentTurn('Start over in a new session.');
    expect(dialogReminders(model, next)).toEqual([]);
    const state = await fresh.run('browser.get_state');
    expect(state.ok).toBe(true);
    expect(state.pendingDialogs).toBeUndefined();
    expect(state.handledDialogs).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('confirm.html');
    expect(JSON.stringify(model.requests().slice(next).map(request => request.messages))).not.toContain('Delete the draft?');
    await expect(pageDialog).toBeHidden();
  });
});
