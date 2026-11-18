import { expect, test } from './fixtures/app';
import { agentBadge } from './fixtures/browser';

test('the user answers a delayed alert the agent is waiting on, then a page alert outside agent control', async ({ app, agent, model, pages }) => {
  const url = pages.url('alert.html');

  const tabId = await agent.openTab(url);
  const page = await app.page(candidate => candidate.startsWith(url), 'alert fixture');
  await expect(page.getByText('Idle')).toBeVisible();

  const click = await agent.click(tabId, { role: 'button', name: 'Sync in the background' });
  expect(click.ok).toBe(true);
  expect(click.pendingDialogs).toBeUndefined();

  await expect.poll(async () => (await agent.run('tab.get_state', { tabId })).pendingDialogs, { timeout: 15_000 }).toEqual([
    expect.objectContaining({ tabId, kind: 'alert', origin: pages.origin, message: 'Sync finished', answerer: 'agent' }),
  ]);

  const overlay = await app.overlay();
  const dialog = overlay.getByRole('dialog', { name: /says$/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Sync finished');
  await expect(agentBadge(dialog)).toBeVisible();
  const control = await app.controlSurface();
  await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeVisible();
  await app.snapshot('async-alert-under-agent-control');

  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Sync acknowledged')).toBeVisible();
  await app.snapshot('async-alert-answered-by-user');

  const next = await agent.run('tab.get_state', { tabId });
  expect(next.ok).toBe(true);
  expect(next.pendingDialogs).toBeUndefined();
  expect(next.handledDialogs).toEqual([
    expect.objectContaining({ kind: 'alert', origin: pages.origin, message: 'Sync finished', outcome: 'accepted', answerer: 'user' }),
  ]);

  model.releaseTurns();
  await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeHidden();

  const userDialog = overlay.getByRole('dialog', { name: /says$/ });
  await Promise.all([
    page.getByRole('button', { name: 'Show status' }).click(),
    (async () => {
      await expect(userDialog).toBeVisible();
      await expect(userDialog).toContainText('Everything is up to date');
      await expect(agentBadge(userDialog)).toBeHidden();
      await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeHidden();
      await app.snapshot('alert-outside-agent-control');
      await userDialog.getByRole('button', { name: 'OK' }).click();
      await expect(userDialog).toBeHidden();
    })(),
  ]);
  await expect(page.getByText('Status acknowledged')).toBeVisible();
  await app.snapshot('alert-answered-outside-agent-control');
});
