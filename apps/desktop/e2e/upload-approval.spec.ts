import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserAgent, BrowserDialogEvent } from './fixtures/agent';
import { expect, test } from './fixtures/app';
import { agentBadge } from './fixtures/browser';
import { textOf } from './fixtures/model';
import { answerNativeDialog } from './fixtures/native-dialog';

async function newFileChooser(agent: BrowserAgent, tabId: string, seen: ReadonlySet<string>): Promise<BrowserDialogEvent> {
  let chooser: BrowserDialogEvent | undefined;
  await expect.poll(async () => {
    const state = await agent.run('tab.get_state', { tabId });
    chooser = state.pendingDialogs?.find(dialog => dialog.kind === 'file' && !seen.has(dialog.dialogId!));
    return chooser;
  }, { message: 'waiting for the file chooser to become a pending dialog' }).toBeDefined();
  return chooser!;
}

test('the agent uploads files and the user approves uploads from outside the workspace', async ({ app, agent, model, pages, scratch }) => {
  const outside = join(scratch, 'outside');
  await mkdir(outside, { recursive: true });
  const workspaceFile = join(app.workspace, 'workspace-receipt.txt');
  const deniedFile = join(outside, 'private-notes.txt');
  const approvedFile = join(outside, 'outside-receipt.txt');
  const userFile = join(outside, 'user-receipt.txt');
  await Promise.all([workspaceFile, deniedFile, approvedFile, userFile].map(path => writeFile(path, 'receipt\n')));
  const url = pages.url('upload.html');
  const seen = new Set<string>();

  const tabId = await agent.openTab(url);
  const page = await app.page(candidate => candidate.startsWith(url), 'upload fixture');
  await expect(page.getByText('No receipt yet')).toBeVisible();
  const received = page.getByRole('list', { name: 'Received files' }).getByRole('listitem');
  const overlay = await app.overlay();

  expect((await agent.click(tabId, { name: 'Receipt' })).ok).toBe(true);
  const first = await newFileChooser(agent, tabId, seen);
  seen.add(first.dialogId!);
  expect(first).toEqual(expect.objectContaining({ tabId, kind: 'file', origin: pages.origin, answerer: 'agent' }));
  await expect(overlay.getByRole('dialog', { name: `${pages.origin} wants a file` })).toBeVisible();
  await app.snapshot('file-chooser-under-agent-control');

  const attached = await agent.run('page.dialog.respond', { tabId, dialogId: first.dialogId, accept: true, files: [workspaceFile] });
  expect(attached.ok, JSON.stringify(attached.error)).toBe(true);
  expect(attached.handledDialogs).toEqual([
    expect.objectContaining({ kind: 'file', origin: pages.origin, outcome: 'uploaded', answerer: 'agent', files: [workspaceFile] }),
  ]);
  await expect(received).toHaveText(['workspace-receipt.txt']);
  await app.snapshot('workspace-file-uploaded-by-agent');

  expect((await agent.click(tabId, { name: 'Receipt' })).ok).toBe(true);
  const second = await newFileChooser(agent, tabId, seen);
  seen.add(second.dialogId!);
  const waiting = await agent.run('page.dialog.respond', { tabId, dialogId: second.dialogId, accept: true, files: [deniedFile] });
  expect(waiting.ok).toBe(false);
  expect(waiting.error?.code).toBe('WAITING_FOR_USER');
  const approval = overlay.getByRole('dialog', { name: 'Allow upload?' });
  await expect(approval).toBeVisible();
  await expect(approval).toContainText(deniedFile);
  await expect(approval).toContainText(pages.origin);
  await app.snapshot('upload-approval-open');
  const pendingApproval = await agent.run('tab.get_state', { tabId });
  const upload = pendingApproval.pendingDialogs?.find(dialog => dialog.kind === 'upload');
  expect(upload).toEqual(expect.objectContaining({ kind: 'upload', origin: pages.origin, answerer: 'user' }));

  await approval.getByRole('button', { name: 'Deny' }).click();
  await expect(approval).toBeHidden();
  await expect(page.getByText('Picker cancelled 1 time(s)')).toBeVisible();
  await app.snapshot('upload-denied-by-user');
  await expect(received).toHaveText(['workspace-receipt.txt']);
  const afterDeny = await agent.run('tab.get_state', { tabId });
  expect(afterDeny.ok).toBe(true);
  expect(afterDeny.pendingDialogs).toBeUndefined();
  expect(afterDeny.handledDialogs).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'upload', origin: pages.origin, outcome: 'denied', answerer: 'user', files: [deniedFile] }),
    expect.objectContaining({ kind: 'file', origin: pages.origin, outcome: 'dismissed', answerer: 'user' }),
  ]));
  const again = await agent.run('page.dialog.respond', { tabId, dialogId: second.dialogId, accept: true, files: [deniedFile] });
  expect(again.ok).toBe(false);
  expect(again.error?.code).toBe('DIALOG_NOT_FOUND');
  await expect(approval).toBeHidden();

  expect((await agent.click(tabId, { name: 'Receipt' })).ok).toBe(true);
  const third = await newFileChooser(agent, tabId, seen);
  seen.add(third.dialogId!);
  const retry = await agent.run('page.dialog.respond', { tabId, dialogId: third.dialogId, accept: true, files: [approvedFile] });
  expect(retry.error?.code).toBe('WAITING_FOR_USER');
  await expect(approval).toContainText(approvedFile);
  await approval.getByRole('button', { name: 'Allow once' }).click();
  await expect(approval).toBeHidden();
  await expect(received).toHaveText(['workspace-receipt.txt', 'outside-receipt.txt']);
  await app.snapshot('upload-allowed-by-user');
  const afterAllow = await agent.run('tab.get_state', { tabId });
  expect(afterAllow.pendingDialogs).toBeUndefined();
  expect(afterAllow.handledDialogs).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'upload', outcome: 'accepted', answerer: 'user', files: [approvedFile] }),
    expect.objectContaining({ kind: 'file', outcome: 'uploaded', answerer: 'agent', files: [approvedFile] }),
  ]));

  expect((await agent.click(tabId, { name: 'Receipt' })).ok).toBe(true);
  const fourth = await newFileChooser(agent, tabId, seen);
  expect(fourth.answerer).toBe('agent');
  const control = await app.controlSurface();
  await control.getByRole('button', { name: 'Take over' }).click();
  await expect(control.getByRole('toolbar', { name: 'Agent is in control' })).toBeHidden();
  const chooser = overlay.getByRole('dialog', { name: `${pages.origin} wants a file` });
  await expect(chooser).toBeVisible();
  await expect(agentBadge(chooser)).toBeHidden();
  await app.snapshot('file-chooser-after-takeover');
  await answerNativeDialog(app, 'showOpenDialog', { canceled: false, filePaths: [userFile] });
  await chooser.getByRole('button', { name: 'Choose files…' }).click();
  await expect(chooser).toBeHidden();
  await expect(received).toHaveText(['workspace-receipt.txt', 'outside-receipt.txt', 'user-receipt.txt']);
  await app.snapshot('user-picked-file-uploaded');
  const blocked = await agent.run('tab.get_state', { tabId });
  expect(blocked.error?.code).toBe('BROWSER_USER_TAKEOVER');

  model.releaseTurns();
  const nextAgent = await app.startAgentTurn('Check what the user uploaded.');
  const resumed = await nextAgent.run('browser.activate_tab', { tabId });
  expect(resumed.ok, JSON.stringify(resumed.error)).toBe(true);
  expect(resumed.handledDialogs ?? []).toEqual([]);
  const reminder = `- file from ${pages.origin}: uploaded by the user (files: ${JSON.stringify(userFile)}).`;
  await expect.poll(
    () => model.requests().some(request => request.messages.some(message => textOf(message.content).includes(reminder))),
    { message: 'waiting for the user upload to be reported in the next turn reminder' },
  ).toBe(true);
});
