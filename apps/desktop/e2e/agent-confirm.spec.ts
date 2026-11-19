import { expect, test } from './fixtures/app';
import { agentBadge } from './fixtures/browser';

test('the agent answers a confirm dialog it opened while the user watches', async ({ app, agent, pages }) => {
  const url = pages.url('confirm.html');

  const tabId = await agent.openTab(url);
  const page = await app.page(candidate => candidate.startsWith(url), 'confirm fixture');
  await expect(page.getByText('No decision yet')).toBeVisible();

  const click = await agent.click(tabId, { role: 'button', name: 'Delete draft' });
  expect(click.ok).toBe(true);
  expect(click.pendingDialogs).toEqual([
    expect.objectContaining({ tabId, kind: 'confirm', origin: pages.origin, message: 'Delete the draft?', answerer: 'agent' }),
  ]);
  const dialogId = click.pendingDialogs![0]!.dialogId!;

  const blocked = await agent.run('page.text.snapshot', { tabId });
  expect(blocked.ok).toBe(false);
  expect(blocked.error?.code).toBe('DIALOG_OPEN');
  expect(blocked.pendingDialogs?.map(dialog => dialog.dialogId)).toEqual([dialogId]);

  const overlay = await app.overlay();
  const dialog = overlay.getByRole('dialog', { name: /says$/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Delete the draft?');
  await expect(agentBadge(dialog)).toBeVisible();
  const control = await app.controlSurface();
  await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeVisible();
  await app.snapshot('confirm-open-under-agent-control');

  const answer = await agent.run('page.dialog.respond', { tabId, dialogId, accept: true });
  expect(answer.ok).toBe(true);
  expect(answer.dialog).toEqual(expect.objectContaining({ dialogId, kind: 'confirm', outcome: 'accepted' }));
  expect(answer.handledDialogs).toEqual([
    expect.objectContaining({ kind: 'confirm', origin: pages.origin, outcome: 'accepted', answerer: 'agent' }),
  ]);
  await expect(page.getByText('Draft deleted')).toBeVisible();
  await expect(dialog).toBeHidden();
  await app.snapshot('confirm-accepted-by-agent');

  const next = await agent.run('tab.get_state', { tabId });
  expect(next.ok).toBe(true);
  expect(next.pendingDialogs).toBeUndefined();
  expect(next.handledDialogs).toBeUndefined();

  await expect(control.locator('.control-records-badge')).toHaveText('1');
  await app.snapshot('records-badge');
  await control.getByRole('button', { name: 'Handled page dialogs' }).click();
  const history = control.getByRole('dialog', { name: 'Page dialogs this session' });
  await expect(history).toBeVisible();
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history.getByRole('listitem')).toContainText(['Confirmation']);
  await expect(history.getByRole('listitem')).toContainText(['Accepted by the agent']);
  await expect(history.getByRole('listitem')).toContainText(['Delete the draft?']);
  await app.snapshot('records-popover-open');
  await expect(control.locator('.control-records-badge')).toBeHidden();
});
