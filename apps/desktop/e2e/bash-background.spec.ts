import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { cardOutput, gatedLoop, gateFile, readyFile, toolCard } from './fixtures/bash-card';
import { captureClipboardWrites } from './fixtures/clipboard';
import { bash, messageProblems, say, textOf } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

test.use({ permissionMode: 'yolo' });

const LONG = gatedLoop('bg', ['bg-line-1', 'bg-line-2'], ['bg-line-3', 'bg-done'], true);
const PROMPT = 'Start the long job';
const MOVED = 'Moved it to the background.';
const FINISHED = 'The long job finished.';
const FULL_OUTPUT = 'bg-line-1\nbg-line-2\nbg-line-3\nbg-done';

test('a running command moved to the background finishes and its output stays viewable', { tag: '@quarantine' }, async ({ app, model }) => {
  const window = app.window;
  const transcript = window.getByRole('list').first();
  const card = toolCard(transcript, LONG);
  const clipboardWrites = await captureClipboardWrites(app);
  let taskId = '';
  let outputLog = '';

  await test.step('the model starts a long command that waits in the foreground', async () => {
    model.script(bash(LONG, { description: 'Long job' }), say(MOVED), say(FINISHED));
    await app.startTurn(PROMPT);
    await expect(card.getByRole('status', { name: 'running' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
    expect(model.requests()).toHaveLength(1);
    await app.snapshot('foreground-running');
  });

  await test.step('"To background" hands the command to a task and the turn moves on', async () => {
    await expect.poll(() => existsSync(join(app.workspace, readyFile('bg')))).toBe(true);
    await card.getByRole('button', { name: 'To background' }).click();
    await expect(transcript.getByText(MOVED, { exact: true })).toBeVisible();
    await expect(card.getByRole('status')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'To background' })).toHaveCount(0);
    const detached = model.request(1).messages.at(-1)!;
    expect(detached.role).toBe('tool');
    const result = textOf(detached.content);
    expect(result).toContain('detached_by_user: true');
    expect(result).toContain('status: running');
    expect(result).toMatch(/foreground_output:\nbg-line-1\nbg-line-2\n/);
    taskId = /task_id: (\S+)/.exec(result)?.[1] ?? '';
    expect(taskId).not.toBe('');
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect(window.getByRole('button', { name: 'Bash 1 running' })).toBeVisible();
  });

  await test.step('the tasks dock lists the job as running and opens it in the detail panel', async () => {
    await window.getByRole('button', { name: 'Bash 1 running' }).click();
    await expect(window.getByRole('button', { name: 'Long job' })).toBeVisible();
    await expect(window.getByRole('img', { name: 'Done' })).toHaveCount(0);
    await app.snapshot('dock-running');
    await window.getByRole('button', { name: 'Long job' }).click();
    const detail = window.getByRole('complementary', { name: 'Detail panel' });
    await expect(detail.getByRole('tab', { name: 'Long job' })).toHaveAttribute('aria-selected', 'true');
  });

  await test.step('when the job ends the model is notified and the job leaves the dock', async () => {
    await writeFile(join(app.workspace, gateFile('bg')), '');
    const notified = await model.waitForRequest(2);
    const notice = notified.userTextsSinceReply.join('\n');
    expect(notice).toContain(`source_id="${taskId}"`);
    expect(notice).toContain('type="task.completed"');
    expect(notice).toContain('Long job completed.');
    outputLog = /<output-file path="([^"]+)"/.exec(notice)?.[1] ?? '';
    expect(outputLog).not.toBe('');
    expect((await readFile(outputLog, 'utf8')).trimEnd()).toBe(FULL_OUTPUT);
    expect(messageProblems(notified.messages)).toEqual([]);
    await expect(transcript.getByText(FINISHED, { exact: true })).toBeVisible();
    await expect(transcript.getByRole('status').filter({ hasText: 'From background (Bash)' })).toContainText('Completed');
    await expect(window.getByRole('button', { name: /^Bash( \d+ running)?$/ })).toHaveCount(0);
    expect(model.requests()).toHaveLength(3);
    await app.snapshot('dock-done');
  });

  await test.step('the open detail panel shows the finished job with its full output', async () => {
    const detail = window.getByRole('complementary', { name: 'Detail panel' });
    await expect(detail.getByRole('tab', { name: 'Long job' })).toHaveAttribute('aria-selected', 'true');
    for (const line of FULL_OUTPUT.split('\n')) await expect(detail.getByText(line, { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: 'Copy output' }).click();
    await expect.poll(async () => (await clipboardWrites()).map(text => text.trimEnd())).toEqual([FULL_OUTPUT]);
    await detail.getByRole('button', { name: 'Copy command' }).click();
    await expect.poll(async () => (await clipboardWrites()).at(-1)).toBe(LONG);
    expect(await clipboardWrites()).toHaveLength(2);
    await app.snapshot('task-detail');
  });

  await test.step('the foreground card still shows only what ran before the hand-off', async () => {
    await card.getByRole('button', { name: 'Expand details' }).click();
    await expect(cardOutput(card)).toContainText('bg-line-2');
    await expect(cardOutput(card)).not.toContainText('bg-done');
  });

  await test.step('after a relaunch the session keeps the hand-off, the notice and the finished task', async () => {
    const sessionUrl = window.url();
    await app.relaunch();
    const restored = app.window;
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(PROMPT)).toBeVisible({ timeout: 30_000 });
    if (restored.url() !== sessionUrl) await sidebar.getByText(PROMPT).click();
    await expect.poll(() => restored.url()).toBe(sessionUrl);
    const list = restored.getByRole('list').first();
    await expect(list.getByText(FINISHED, { exact: true })).toBeVisible();
    await expect(list.getByRole('status').filter({ hasText: 'From background (Bash)' })).toContainText('Completed');
    await expect(toolCard(list, LONG).getByRole('status')).toHaveCount(0);
    await expect(restored.getByText('Opening session…')).toBeHidden();
    const detail = restored.getByRole('complementary', { name: 'Detail panel' });
    await expect(detail.getByRole('tab', { name: 'Long job' })).toHaveAttribute('aria-selected', 'true');
    for (const line of FULL_OUTPUT.split('\n')) await expect(detail.getByText(line, { exact: true })).toBeVisible();
    await expect(detail.getByText('Waiting for output…')).toBeHidden();
    await expect(restored.getByRole('button', { name: /^Bash( \d+ running)?$/ })).toHaveCount(0);
    await app.snapshot('restored');
    expect(model.requests()).toHaveLength(3);
  });
});
