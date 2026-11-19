import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { subagent } from './fixtures/agents';
import { bash, batch, held, messageProblems, say, textOf, withoutReminders, type ModelRequest } from './fixtures/model';

const PROMPT = 'Audit the workspace and lint it with two helpers';
const AUDIT = 'Audit the workspace files and record the result';
const LINT = 'Lint the workspace sources and report findings';
const AUDIT_REPORT = 'Audit report: wrote audit.txt.';
const LINT_REPORT = 'Lint report: no findings.';
const STARTED = 'Started two helpers.';
const LINT_ACK = 'The lint helper reported no findings.';
const SUMMARY = 'Both helpers are done: the audit wrote audit.txt and lint is clean.';

const card = (dock: Locator, name: string): Locator =>
  dock.locator('.sg-card').filter({ has: dock.page().getByRole('button', { name, exact: true }) });

const agentCard = (transcript: Locator, name: string): Locator =>
  transcript.getByRole('button', { name: 'Open', exact: true }).filter({ hasText: name });

const backgroundAgentPill = (page: Page): Locator =>
  page.getByRole('button', { name: /^Background Agent( \d+ running)?$/ });

function completionNotice(request: ModelRequest, description: string): { outputFile: string } {
  const notices = request.messages.map(message => textOf(message.content)).filter(text => text.includes('type="task.completed"') && text.includes(`${description} completed.`));
  expect(notices).toHaveLength(1);
  const outputFile = /<output-file path="([^"]+)"/.exec(notices[0]!)?.[1];
  expect(outputFile).toBeDefined();
  return { outputFile: outputFile! };
}

test.use({ permissionMode: 'manual' });

test('two background subagents run in parallel, ask for approval and report back to the parent turn', async ({ app, model }) => {
  model.script(
    batch(subagent(AUDIT, 'Audit files', { background: true }), subagent(LINT, 'Lint sources', { background: true })),
    say(STARTED),
    say(LINT_ACK),
    say(SUMMARY),
  );
  model.scriptFor(AUDIT, bash('echo audited > audit.txt', { description: 'Write the audit file' }), held('subagents-audit-final', say(AUDIT_REPORT)));
  model.scriptFor(LINT, held('subagents-lint-final', say(LINT_REPORT)));
  const lintHold = model.hold('subagents-lint-final');
  const auditHold = model.hold('subagents-audit-final');
  const window = app.window;
  const transcript = window.getByRole('list').first();
  const dock = window.locator('.dock-work-panel');

  await test.step('the parent spawns two background helpers and keeps talking', async () => {
    await app.startTurn(PROMPT);
    await expect(transcript.getByText(STARTED, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect(transcript.locator('button.ar-head')).toHaveCount(0);
    await expect(transcript.getByText('Audit files')).toBeVisible();
    await expect(transcript.getByText('Lint sources')).toBeVisible();
    await lintHold.reached();
    await expect(window.getByRole('button', { name: 'Background Agent 2 running' })).toBeVisible();
  });

  await test.step('the audit helper asks for approval with the subagent badge', async () => {
    await expect(window.getByText('Run command?')).toBeVisible();
    await expect(window.getByText('sub agent · Audit files')).toBeVisible();
    await expect(window.getByText('$ echo audited > audit.txt')).toBeVisible();
    await app.snapshot('subagent-approval');
  });

  await test.step('the dock grid lists both helpers as running', async () => {
    await window.getByRole('button', { name: 'Background Agent 2 running' }).click();
    await expect(dock.getByText('2 running')).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Audit files' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Lint sources' })).toBeVisible();
    await expect(dock.getByText('running', { exact: true })).toHaveCount(2);
    await app.snapshot('subagent-grid-running');
  });

  await test.step('the lint helper finishes first and the parent acknowledges it', async () => {
    lintHold.release();
    await expect(transcript.getByText(LINT_ACK, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Background Agent 1 running' })).toBeVisible();
    const ack = model.requests().find(request => request.step?.text?.[0] === LINT_ACK)!;
    const notice = completionNotice(ack, 'Lint sources');
    expect((await readFile(notice.outputFile, 'utf8')).trim()).toBe(LINT_REPORT);
    expect(messageProblems(ack.messages)).toEqual([]);
  });

  await test.step('the finished lint helper stays in the dock and its transcript opens from its card', async () => {
    await expect(dock.getByText('1 running')).toBeVisible();
    await expect(card(dock, 'Audit files')).toContainText('running');
    await expect(card(dock, 'Lint sources')).toContainText('Done');
    await app.snapshot('subagent-grid-one-running');
    const pill = window.getByRole('button', { name: 'Background Agent 1 running' });
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
    await expect(dock).toBeHidden();
    await agentCard(transcript, 'Lint sources').click();
    const panel = window.getByRole('complementary', { name: 'Detail panel' });
    await expect(panel.getByRole('tab', { name: /Lint sources/ })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText(LINT_REPORT)).toBeVisible();
    await expect(panel.getByText(AUDIT_REPORT)).toHaveCount(0);
    await app.snapshot('subagent-panel-tab');
  });

  await test.step('approving the audit command writes the file and finishes the helper', async () => {
    await window.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(window.getByText('Run command?')).toBeHidden();
    const auditFinal = await auditHold.reached();
    expect((await readFile(join(app.workspace, 'audit.txt'), 'utf8')).trim()).toBe('audited');
    expect(auditFinal.texts('user').map(withoutReminders).filter(text => text !== '')).toEqual([AUDIT]);
    expect(auditFinal.messages.filter(message => message.role === 'tool')).toHaveLength(1);
    expect(messageProblems(auditFinal.messages)).toEqual([]);
    auditHold.release();
    await expect(transcript.getByText(SUMMARY, { exact: true })).toBeVisible();
    await expect(backgroundAgentPill(window)).toBeVisible();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  });

  await test.step('the parent summary request carries the audit result', async () => {
    const summary = model.requests().find(request => request.step?.text?.[0] === SUMMARY)!;
    const notice = completionNotice(summary, 'Audit files');
    expect((await readFile(notice.outputFile, 'utf8')).trim()).toBe(AUDIT_REPORT);
    expect(messageProblems(summary.messages)).toEqual([]);
    expect(model.requests().filter(request => request.step === null)).toHaveLength(0);
  });

  await test.step('after relaunch the dock stays empty and a helper transcript opens from its card', async () => {
    await app.relaunch();
    const restored = app.window;
    const restoredTranscript = restored.getByRole('list').first();
    await expect(restored.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    await expect(restoredTranscript.getByText(SUMMARY, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(backgroundAgentPill(restored)).toHaveCount(0);
    const panel = restored.getByRole('complementary', { name: 'Detail panel' });
    await agentCard(restoredTranscript, 'Audit files').click();
    await expect(panel.getByRole('tab', { name: /Audit files/ })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText(AUDIT_REPORT)).toBeVisible();
    await app.snapshot('subagent-restored');
  });
});
