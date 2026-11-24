import { expect, test } from './fixtures/app';
import { agentBadge } from './fixtures/browser';

test('the agent stays on a page with unsaved edits, then leaves it, and a POST form is not submitted twice', async ({ app, agent, pages }) => {
  const url = pages.url('leave.html');
  const nextUrl = pages.url('next.html');

  const tabId = await agent.openTab(url);
  const page = await app.page(candidate => candidate.startsWith(url), 'leave fixture');
  expect((await agent.typeText(tabId, { role: 'textbox', name: 'Draft' }, 'Unsaved notes')).ok).toBe(true);
  await expect(page.getByLabel('Draft')).toHaveValue('Unsaved notes');

  const blocked = await agent.run('tab.navigate', { tabId, url: nextUrl });
  expect(blocked.ok).toBe(false);
  expect(blocked.error?.code).toBe('NAVIGATION_FAILED');
  expect(blocked.pendingDialogs).toEqual([
    expect.objectContaining({ tabId, kind: 'beforeunload', origin: pages.origin, answerer: 'agent' }),
  ]);
  expect(blocked.pendingDialogs![0]!.retryAfterAccept).toBeUndefined();
  const stayId = blocked.pendingDialogs![0]!.dialogId!;

  const overlay = await app.overlay();
  const dialog = overlay.getByRole('dialog', { name: 'Leave page' });
  await expect(dialog).toBeVisible();
  await expect(agentBadge(dialog)).toBeVisible();
  await expect(dialog).toContainText(`Next page: ${nextUrl}`);
  const control = await app.controlSurface();
  await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeVisible();
  await app.snapshot('leave-page-dialog-under-agent-control');

  const stay = await agent.run('page.dialog.respond', { tabId, dialogId: stayId, accept: false });
  expect(stay.ok).toBe(true);
  expect(stay.handledDialogs).toEqual([
    expect.objectContaining({ kind: 'beforeunload', origin: pages.origin, outcome: 'stayed', answerer: 'agent' }),
  ]);
  await expect(dialog).toBeHidden();
  const stayed = await agent.run('tab.get_state', { tabId });
  expect(stayed.tab?.url).toBe(url);
  await expect(page.getByLabel('Draft')).toHaveValue('Unsaved notes');
  await app.snapshot('stayed-on-page-with-edits');

  const again = await agent.run('tab.navigate', { tabId, url: nextUrl });
  expect(again.ok).toBe(false);
  expect(again.pendingDialogs).toEqual([expect.objectContaining({ tabId, kind: 'beforeunload', answerer: 'agent' })]);
  const leaveId = again.pendingDialogs![0]!.dialogId!;
  await expect(dialog).toBeVisible();

  const leave = await agent.run('page.dialog.respond', { tabId, dialogId: leaveId, accept: true });
  expect(leave.ok).toBe(true);
  expect(leave.handledDialogs).toEqual([
    expect.objectContaining({ kind: 'beforeunload', origin: pages.origin, outcome: 'left', answerer: 'agent' }),
  ]);
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await agent.run('tab.get_state', { tabId })).tab?.url).toBe(nextUrl);
  const next = await app.page(candidate => candidate.startsWith(nextUrl), 'next fixture');
  await expect(next.getByRole('heading', { name: 'Next page' })).toBeVisible();
  await app.snapshot('left-to-next-page');

  const formUrl = pages.url('form.html');
  expect((await agent.run('tab.navigate', { tabId, url: formUrl })).ok).toBe(true);
  expect((await agent.run('tab.wait_for_load', { tabId, state: 'complete' })).ok).toBe(true);
  const form = await app.page(candidate => candidate.startsWith(formUrl), 'form fixture');
  expect((await agent.typeText(tabId, { role: 'textbox', name: 'Comment' }, 'Looks good')).ok).toBe(true);
  await expect(form.getByLabel('Comment')).toHaveValue('Looks good');

  expect((await agent.click(tabId, { role: 'button', name: 'Send feedback' })).ok).toBe(true);

  let postDialogId: string | undefined;
  await expect.poll(async () => {
    const pending = (await agent.run('tab.get_state', { tabId })).pendingDialogs;
    postDialogId = pending?.[0]?.dialogId;
    return pending;
  }).toEqual([expect.objectContaining({ tabId, kind: 'beforeunload', answerer: 'agent', retryAfterAccept: true })]);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This page was submitting a form. After you choose Leave, submit it again.');
  await app.snapshot('leave-page-dialog-for-form-submission');

  const leaveForm = await agent.run('page.dialog.respond', { tabId, dialogId: postDialogId!, accept: true });
  expect(leaveForm.ok).toBe(true);
  expect(leaveForm.handledDialogs).toEqual([
    expect.objectContaining({ kind: 'beforeunload', origin: pages.origin, outcome: 'accepted', answerer: 'agent' }),
  ]);
  expect(leaveForm.notices).toContain('Leaving the page is allowed now; repeat the action that navigates away.');
  await expect(dialog).toBeHidden();
  expect((await agent.run('tab.get_state', { tabId })).tab?.url).toBe(formUrl);
  const kept = await agent.run('page.elements.snapshot', { tabId });
  expect(kept.elements?.elements).toContainEqual(expect.objectContaining({ role: 'textbox', name: 'Comment', value: 'Looks good' }));
  expect(pages.requests().filter(request => request.method !== 'GET')).toEqual([]);
  await app.snapshot('form-kept-after-leave-without-resubmit');
});
