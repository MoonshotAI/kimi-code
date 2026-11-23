import { expect, test } from './fixtures/app';
import { agentBadge } from './fixtures/browser';

test('the agent recovers from a select that never answered, then leaves edited pages through history and a popup', async ({ app, agent, pages }) => {
  const regionUrl = pages.url('undetermined-region.html');
  const editorUrl = pages.url('popup-leave.html');
  const nextUrl = pages.url('next.html');
  const tabId = await agent.openTab(regionUrl);
  const region = await app.page(candidate => candidate.startsWith(regionUrl), 'region fixture');
  await expect(region.getByText('No region change yet')).toBeVisible();
  const overlay = await app.overlay();
  const control = await app.controlSurface();
  const toolbar = control.getByRole('toolbar', { name: 'Agent is in control' });
  const alert = overlay.getByRole('dialog', { name: /says$/ });
  const leaveDialog = overlay.getByRole('dialog', { name: 'Leave page' });
  const message = 'Shipping to Europe changes the delivery date';
  let alertId = '';

  await test.step('a select whose change handler opens an alert returns with the alert pending', async () => {
    const result = await agent.selectOption(tabId, { role: 'combobox', name: 'Region' }, 'eu');
    expect(result.ok).toBe(true);
    expect(result.pendingDialogs).toEqual([
      expect.objectContaining({ tabId, kind: 'alert', origin: pages.origin, message, answerer: 'agent' }),
    ]);
    alertId = result.pendingDialogs![0]!.dialogId!;
    expect(result.notices).toEqual([
      `The page opened an alert dialog (dialogId ${alertId}) during this operation and is waiting for an answer. Answer it with page.dialog.respond before other page operations. This operation may still be applied, fully or partly, once the dialog is answered; read the page state again before retrying it.`,
    ]);
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(message);
    await expect(agentBadge(alert)).toBeVisible();
    await expect(toolbar).toBeVisible();
    await app.snapshot('alert-under-agent-control');
  });

  await test.step('the agent answers the alert and the change applies exactly once', async () => {
    const answer = await agent.run('page.dialog.respond', { tabId, dialogId: alertId, accept: true });
    expect(answer.ok).toBe(true);
    expect(answer.handledDialogs).toEqual([
      expect.objectContaining({ kind: 'alert', origin: pages.origin, message, outcome: 'accepted', answerer: 'agent' }),
    ]);
    await expect(alert).toBeHidden();
    const text = await agent.run('page.text.snapshot', { tabId });
    expect(text.ok).toBe(true);
    expect(JSON.stringify(text)).toContain('Region changes: 1');
    const state = await agent.run('page.elements.snapshot', { tabId });
    expect(state.elements?.elements).toContainEqual(expect.objectContaining({ role: 'combobox', name: 'Region' }));
    await expect(region.getByLabel('Region')).toHaveValue('eu');
    await expect(region.getByText('Region changes: 1')).toBeVisible();
    expect((await agent.run('tab.get_state', { tabId })).pendingDialogs).toBeUndefined();
    await app.snapshot('page-after-alert-answered');
  });

  await test.step('a select whose change handler stops responding ends undetermined and applies once', async () => {
    const result = await agent.selectOption(tabId, { role: 'combobox', name: 'Region' }, 'asia');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ACTION_UNDETERMINED');
    expect(result.pendingDialogs).toBeUndefined();
    const text = await agent.run('page.text.snapshot', { tabId });
    expect(text.ok).toBe(true);
    expect(JSON.stringify(text)).toContain('Region changes: 2');
    await expect(region.getByLabel('Region')).toHaveValue('asia');
    await expect(region.getByText('Region changes: 2')).toBeVisible();
    await app.snapshot('page-after-undetermined-select');
  });

  await test.step('going back from an edited page waits for Leave, then repeats the history navigation', async () => {
    expect((await agent.run('tab.navigate', { tabId, url: editorUrl })).ok).toBe(true);
    expect((await agent.run('tab.wait_for_load', { tabId, state: 'complete' })).ok).toBe(true);
    const editor = await app.page(candidate => candidate.startsWith(editorUrl), 'editor fixture');
    expect((await agent.typeText(tabId, { role: 'textbox', name: 'Notes' }, 'Draft notes')).ok).toBe(true);
    await expect(editor.getByLabel('Notes')).toHaveValue('Draft notes');

    const back = await agent.run('tab.go_back', { tabId });
    expect(back.ok).toBe(false);
    expect(back.pendingDialogs).toEqual([
      expect.objectContaining({ tabId, kind: 'beforeunload', origin: pages.origin, answerer: 'agent' }),
    ]);
    expect(back.pendingDialogs![0]!.retryAfterAccept).toBeUndefined();
    await expect(leaveDialog).toBeVisible();
    await expect(agentBadge(leaveDialog)).toBeVisible();
    expect((await agent.run('tab.get_state', { tabId })).tab?.url).toBe(editorUrl);
    await app.snapshot('leave-dialog-for-history-back');

    await leaveDialog.getByRole('button', { name: 'Leave' }).click();
    await expect(leaveDialog).toBeHidden();
    await expect.poll(async () => (await agent.run('tab.get_state', { tabId })).tab?.url).toBe(regionUrl);
    const previous = await app.page(candidate => candidate.startsWith(regionUrl), 'region fixture after going back');
    await expect(previous.getByRole('heading', { name: 'Shipping region' })).toBeVisible();
    await app.snapshot('page-after-leaving-through-history');
  });

  await test.step('a popup navigation blocked by an edited page is replayed after Leave', async () => {
    expect((await agent.run('tab.navigate', { tabId, url: editorUrl })).ok).toBe(true);
    expect((await agent.run('tab.wait_for_load', { tabId, state: 'complete' })).ok).toBe(true);
    const editor = await app.page(candidate => candidate.startsWith(editorUrl), 'editor fixture again');
    expect((await agent.typeText(tabId, { role: 'textbox', name: 'Notes' }, 'More notes')).ok).toBe(true);
    await expect(editor.getByLabel('Notes')).toHaveValue('More notes');

    expect((await agent.click(tabId, { role: 'button', name: 'Open preview' })).ok).toBe(true);
    await expect.poll(async () => (await agent.run('tab.get_state', { tabId })).pendingDialogs).toEqual([
      expect.objectContaining({ tabId, kind: 'beforeunload', origin: pages.origin, answerer: 'agent' }),
    ]);
    await expect(leaveDialog).toBeVisible();
    await expect(leaveDialog).toContainText(`Next page: ${nextUrl}`);

    await leaveDialog.getByRole('button', { name: 'Leave' }).click();
    await expect(leaveDialog).toBeHidden();
    await expect.poll(async () => (await agent.run('tab.get_state', { tabId })).tab?.url).toBe(nextUrl);
    const next = await app.page(candidate => candidate.startsWith(nextUrl), 'next fixture');
    await expect(next.getByRole('heading', { name: 'Next page' })).toBeVisible();
    await app.snapshot('page-after-leaving-popup-navigation');
  });
});
