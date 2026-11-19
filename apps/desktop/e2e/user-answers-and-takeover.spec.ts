import { expect, test } from './fixtures/app';
import { agentBadge } from './fixtures/browser';

test('the user answers and declines page dialogs, then takes the browser over by mouse and by closing the tab', async ({ app, agent, model, pages }) => {
  const url = pages.url('takeover-desk.html');
  const tabId = await agent.openTab(url);
  const page = await app.page(candidate => candidate.startsWith(url), 'takeover desk fixture');
  await expect(page.getByText('No decision yet')).toBeVisible();
  const overlay = await app.overlay();
  const control = await app.controlSurface();
  const toolbar = control.getByRole('toolbar', { name: 'Agent is in control' });
  const dialog = overlay.getByRole('dialog', { name: /says$/ });

  await test.step('the user cancels a confirm the agent opened', async () => {
    const click = await agent.click(tabId, { role: 'button', name: 'Delete draft' });
    expect(click.ok).toBe(true);
    expect(click.pendingDialogs).toEqual([
      expect.objectContaining({ tabId, kind: 'confirm', origin: pages.origin, message: 'Delete the draft?', answerer: 'agent' }),
    ]);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Delete the draft?');
    await expect(agentBadge(dialog)).toBeVisible();
    await expect(toolbar).toBeVisible();
    await app.snapshot('confirm-under-agent-control');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Draft kept')).toBeVisible();
    const after = await agent.run('tab.get_state', { tabId });
    expect(after.ok).toBe(true);
    expect(after.pendingDialogs).toBeUndefined();
    expect(after.handledDialogs).toEqual([
      expect.objectContaining({ kind: 'confirm', origin: pages.origin, message: 'Delete the draft?', outcome: 'dismissed', answerer: 'user' }),
    ]);
    await expect(toolbar).toBeVisible();

    await expect(control.locator('.control-records-badge')).toHaveText('1');
    await control.getByRole('button', { name: 'Handled page dialogs' }).click();
    const history = control.getByRole('dialog', { name: 'Page dialogs this session' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history.getByRole('listitem')).toContainText(['Confirmation']);
    await expect(history.getByRole('listitem')).toContainText(['Dismissed by you']);
    await app.snapshot('confirm-dismissed-by-user-record');
    await control.getByRole('button', { name: 'Handled page dialogs' }).click();
    await expect(history).toBeHidden();
  });

  await test.step('the user takes over by mouse while a confirm waits for the agent', async () => {
    const click = await agent.click(tabId, { role: 'button', name: 'Delete draft' });
    expect(click.ok).toBe(true);
    expect(click.pendingDialogs).toEqual([expect.objectContaining({ tabId, kind: 'confirm', answerer: 'agent' })]);
    await expect(agentBadge(dialog)).toBeVisible();

    await control.getByRole('button', { name: 'Take over' }).click();
    await expect(toolbar).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(agentBadge(dialog)).toBeHidden();
    const blocked = await agent.run('tab.get_state', { tabId });
    expect(blocked.ok).toBe(false);
    expect(blocked.error?.code).toBe('BROWSER_USER_TAKEOVER');
    await app.snapshot('confirm-after-takeover');

    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Draft deleted')).toBeVisible();
  });

  await test.step('in a new turn the user closes the tab while an alert waits for the agent', async () => {
    model.releaseTurns();
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    const next = await app.startAgentTurn('Check the status of the draft desk.');
    expect((await next.run('browser.activate_tab', { tabId })).ok).toBe(true);
    const click = await next.click(tabId, { role: 'button', name: 'Show status' });
    expect(click.ok).toBe(true);
    expect(click.pendingDialogs).toEqual([
      expect.objectContaining({ tabId, kind: 'alert', message: 'Everything is up to date', answerer: 'agent' }),
    ]);
    await expect(dialog).toBeVisible();
    await expect(agentBadge(dialog)).toBeVisible();
    await expect(toolbar).toBeVisible();

    const tab = app.window.locator('div').filter({ has: app.window.getByRole('tab', { name: 'Draft desk' }) }).last();
    await tab.getByRole('button', { name: 'Close tab' }).click();
    await expect(app.window.getByRole('tab', { name: 'Draft desk' })).toBeHidden();
    await expect(dialog).toBeHidden();
    await expect(toolbar).toBeHidden();

    const after = await next.run('tab.get_state', { tabId });
    expect(after.ok).toBe(false);
    expect(after.error?.code).toBe('BROWSER_USER_TAKEOVER');
    expect(after.pendingDialogs).toBeUndefined();
    expect(after.handledDialogs).toBeUndefined();
    expect(after.notices).toBeUndefined();
    await app.snapshot('panel-after-tab-closed');
  });
});
