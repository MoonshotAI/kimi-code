import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { todos } from './fixtures/agents';
import { bash, batch, messageProblems, say, textOf, type ModelRequest } from './fixtures/model';

const PROMPT = 'Plan the release, start the build and a log watcher in the background';
const FOLLOW_UP = 'Now run the test suite and ship';
const BUILD_GATE = 'build-gate';
const TEST_GATE = 'test-gate';
const STARTED = 'The build and the log watcher are running.';
const WATCH_ACK = 'The log watcher was stopped.';
const BUILD_ACK = 'The build finished; tests are next.';
const DETACHED = 'The test suite keeps running in the background.';
const SHIPPED = 'Tests passed and the release is shipped.';

const row = (pane: Locator, name: string): Locator =>
  pane.locator('.tp-row').filter({ has: pane.page().getByRole('button', { name, exact: true }) });

const bashPill = (page: Page): Locator => page.getByRole('button', { name: /^Bash( \d+ running)?$/ });

function notices(request: ModelRequest): string[] {
  return request.messages.map(message => textOf(message.content)).filter(text => text.startsWith('<notification'));
}

test.use({ permissionMode: 'yolo' });

test('background tasks and the todo list move through a release and survive a relaunch', async ({ app, model }) => {
  model.script(
    batch(
      todos(['Build', 'in_progress'], ['Test', 'pending'], ['Ship', 'pending']),
      bash(`while [ ! -f ${BUILD_GATE} ]; do sleep 0.1; done; echo build-output-ok`, { description: 'Release build', background: true }),
      bash('sleep 600', { description: 'Watch logs', background: true }),
    ),
    say(STARTED),
    say(WATCH_ACK),
    todos(['Build', 'done'], ['Test', 'in_progress'], ['Ship', 'pending']),
    say(BUILD_ACK),
    bash(`while [ ! -f ${TEST_GATE} ]; do sleep 0.1; done; echo tests-passed | tee tests.log`, { description: 'Test suite' }),
    say(DETACHED),
    todos(['Build', 'done'], ['Test', 'done'], ['Ship', 'done']),
    say(SHIPPED),
  );
  const window = app.window;
  const transcript = window.getByRole('list').first();
  const dock = window.locator('.dock-work-panel');

  await test.step('the turn plans three todos and starts two background commands', async () => {
    await app.startTurn(PROMPT);
    await expect(transcript.getByText(STARTED, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Progress 0/3' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Bash 2 running' })).toBeVisible();
    await window.getByRole('button', { name: 'Progress 0/3' }).click();
    await expect(dock.locator('.tc-row')).toHaveText(['Build', 'Test', 'Ship']);
    await expect(dock.locator('.tc-row.s-in_progress')).toHaveText(['Build']);
    await app.snapshot('todos-planned');
  });

  await test.step('the tasks pane lists both commands and keeps the stopped watcher', async () => {
    await window.getByRole('button', { name: 'Bash 2 running' }).click();
    await expect(dock.getByText('2 running')).toBeVisible();
    await expect(row(dock, 'Release build').getByRole('img', { name: 'running' })).toBeVisible();
    await expect(row(dock, 'Watch logs').getByRole('img', { name: 'running' })).toBeVisible();
    await app.snapshot('tasks-running');
    await row(dock, 'Watch logs').getByRole('button', { name: 'stop' }).click();
    await expect(row(dock, 'Watch logs').getByRole('img', { name: 'Stopped' })).toBeVisible();
    await expect(dock.getByText('1 running')).toBeVisible();
    await expect(transcript.getByText(WATCH_ACK, { exact: true })).toBeVisible();
    const ack = model.requests().find(request => request.step?.text?.[0] === WATCH_ACK)!;
    expect(notices(ack).filter(notice => notice.includes('type="task.killed"') && notice.includes('Watch logs was stopped by user.'))).toHaveLength(1);
    await dock.getByRole('button', { name: 'Release build' }).click();
    const panel = window.getByRole('complementary', { name: 'Detail panel' });
    await expect(panel.getByRole('tab', { name: /Release build/ })).toHaveAttribute('aria-selected', 'true');
  });

  await test.step('the build finishes, the agent ticks the first todo and the open panel shows the output', async () => {
    await writeFile(join(app.workspace, BUILD_GATE), '');
    await expect(transcript.getByText(BUILD_ACK, { exact: true })).toBeVisible();
    const ack = model.requests().find(request => request.step?.text?.[0] === BUILD_ACK)!;
    expect(notices(ack).filter(notice => notice.includes('type="task.completed"') && notice.includes('Release build'))).toHaveLength(1);
    expect(messageProblems(ack.messages)).toEqual([]);
    await expect(window.getByRole('button', { name: 'Progress 1/3' })).toBeVisible();
    await expect(bashPill(window)).toBeVisible();
    const panel = window.getByRole('complementary', { name: 'Detail panel' });
    await expect(panel.getByText('build-output-ok', { exact: true })).toBeVisible();
    await expect(panel.getByRole('tab', { name: /Release build/ })).toHaveAttribute('aria-selected', 'true');
    await app.snapshot('task-output-panel');
  });

  await test.step('a foreground test run goes to the background and the turn moves on', async () => {
    await app.submit(FOLLOW_UP);
    const card = transcript.getByText('Test suite');
    await expect(card).toBeVisible();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
    await window.getByRole('button', { name: 'To background' }).click();
    await expect(transcript.getByText(DETACHED, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Bash 1 running' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Progress 1/3' })).toBeVisible();
  });

  await test.step('the detached test run completes and the agent finishes every todo', async () => {
    await writeFile(join(app.workspace, TEST_GATE), '');
    await expect(transcript.getByText(SHIPPED, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Progress 3/3' })).toBeVisible();
    expect((await readFile(join(app.workspace, 'tests.log'), 'utf8')).trim()).toBe('tests-passed');
    const shipped = model.requests().find(request => request.step?.text?.[0] === SHIPPED)!;
    expect(messageProblems(shipped.messages)).toEqual([]);
    expect(model.requests().filter(request => request.step === null)).toHaveLength(0);
    await expect(bashPill(window)).toBeVisible();
    const finish = model.requests().find(request => request.step?.calls?.[0]?.name === 'TodoList' && request.index > 4)!;
    expect(notices(finish).filter(notice => notice.includes('type="task.completed"') && notice.includes('Test suite'))).toHaveLength(1);
    await window.getByRole('button', { name: 'Progress 3/3' }).click();
    await expect(dock.locator('.tc-row.s-done')).toHaveText(['Build', 'Test', 'Ship']);
    await app.snapshot('todos-complete');
  });

  await test.step('after relaunch the completed task returns with the restored output tab', async () => {
    await app.relaunch();
    const restored = app.window;
    await expect(restored.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    await expect(restored.getByRole('list').first().getByText(SHIPPED, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bashPill(restored)).toBeVisible();
    const panel = restored.getByRole('complementary', { name: 'Detail panel' });
    await expect(panel.getByRole('tab', { name: /Release build/ })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText('build-output-ok', { exact: true })).toBeVisible();
    await expect(panel.getByText('Waiting for output…')).toHaveCount(0);
    await app.snapshot('tasks-restored');
  });
});

test('the todo list survives a relaunch', async ({ app, model }) => {
  model.script(todos(['Build', 'done'], ['Ship', 'in_progress']), say('Todos updated.'));
  await app.startTurn('Track the release');
  await expect(app.window.getByRole('button', { name: 'Progress 1/2' })).toBeVisible();
  await app.relaunch();
  await expect(app.window.getByRole('list').first().getByText('Todos updated.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(app.window.getByRole('button', { name: 'Progress 1/2' })).toBeVisible();
  await app.window.getByRole('button', { name: 'Progress 1/2' }).click();
  const dock = app.window.locator('.dock-work-panel');
  await expect(dock.locator('.tc-row')).toHaveText(['Build', 'Ship']);
  await expect(dock.locator('.tc-row.s-done')).toHaveText(['Build']);
  await expect(dock.locator('.tc-row.s-in_progress')).toHaveText(['Ship']);
});
