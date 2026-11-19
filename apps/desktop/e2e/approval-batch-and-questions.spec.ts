import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { batch, bash, call, messageProblems, say, textOf, type ModelRequest } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const ONE = 'echo one > one.txt';
const TWO = 'echo two > two.txt';
const BATCH_FEEDBACK = 'Only the first file is needed';
const OTHER_TEXT = 'Ship it behind a feature flag';

const question = (text: string, header: string, labels: readonly string[]) => ({
  question: text,
  header,
  options: labels.map(label => ({ label, description: `Pick ${label}` })),
  multi_select: false,
});

const toolResults = (request: ModelRequest): string[] =>
  request.messages.filter(message => message.role === 'tool').map(message => textOf(message.content));

test.use({ permissionMode: 'manual' });

test('parallel approvals resolve in order and the question card answers, uses Other, navigates and dismisses', async ({ app, model }) => {
  const transcript = app.window.getByRole('list').first();
  const sidebar = sidebarOf(app);
  const runCommand = app.window.getByText('Run command?');
  const submit = app.window.getByRole('button', { name: 'Submit', exact: true });

  await test.step('two batched commands ask one after the other; approve the first and reject the second with feedback', async () => {
    model.script(batch(bash(ONE, { description: 'First file' }), bash(TWO, { description: 'Second file' })), say('Batch handled.'));
    await app.startTurn('Create both files');
    await expect(runCommand).toBeVisible();
    await expect(app.window.getByText(`$ ${ONE}`)).toBeVisible();
    await expect(sidebar.getByText('Approve', { exact: true })).toBeVisible();
    await app.snapshot('first-of-two-approvals');
    await app.window.getByRole('button', { name: 'Approve', exact: true }).click();

    await expect(app.window.getByText(`$ ${TWO}`)).toBeVisible();
    await expect(runCommand).toHaveCount(1);
    await expect(sidebar.getByText('Approve', { exact: true })).toBeVisible();
    expect(model.requests()).toHaveLength(1);
    await app.snapshot('second-of-two-approvals');
    await app.window.getByRole('button', { name: 'Feedback', exact: true }).click();
    await app.window.getByPlaceholder('Explain why you are rejecting…').fill(BATCH_FEEDBACK);
    await app.window.getByRole('button', { name: 'Reject with feedback' }).click();

    await expect(transcript.getByText('Batch handled.', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Approve', { exact: true })).toBeHidden();
    expect(await readFile(join(app.workspace, 'one.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(app.workspace, 'two.txt'))).toBe(false);
    const next = model.request(1);
    const results = toolResults(next);
    expect(results).toHaveLength(2);
    expect(results[1]).toContain(BATCH_FEEDBACK);
    expect(results[0]).not.toContain(BATCH_FEEDBACK);
    expect(messageProblems(next.messages)).toEqual([]);
  });

  await test.step('a single question shows Answer in the sidebar and sends the chosen option', async () => {
    model.script(
      call('AskUserQuestion', { questions: [question('Which database should we use?', 'Database', ['Postgres', 'SQLite', 'MySQL'])] }),
      say('Going with SQLite.'),
    );
    const before = model.requests().length;
    await app.startTurn('Help me choose a database');
    await expect(app.window.getByText('Which database should we use?')).toBeVisible();
    await expect(sidebar.getByText('Answer', { exact: true })).toBeVisible();
    await expect(submit).toBeDisabled();
    await app.snapshot('question-pending');
    await app.window.getByText('SQLite', { exact: true }).click();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(transcript.getByText('Going with SQLite.', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Answer', { exact: true })).toBeHidden();
    const result = toolResults(model.request(before + 1)).at(-1) ?? '';
    expect(result).toContain('SQLite');
    expect(result).not.toContain('Postgres');
  });

  await test.step('two questions: pick an option, write an Other answer, go back and forward, then submit both', async () => {
    model.script(
      call('AskUserQuestion', {
        questions: [
          question('Which framework should we use?', 'Framework', ['Vue', 'React']),
          question('How should we release it?', 'Release', ['All at once', 'Canary first']),
        ],
      }),
      say('Plan recorded.'),
    );
    const before = model.requests().length;
    await app.startTurn('Plan the rollout');
    await expect(app.window.getByText('Which framework should we use?')).toBeVisible();
    await app.window.getByText('Vue', { exact: true }).click();
    await app.window.getByRole('button', { name: 'Next question' }).click();
    await expect(app.window.getByText('How should we release it?')).toBeVisible();
    await expect(submit).toBeDisabled();
    await app.window.getByPlaceholder('Share your thoughts…').fill(OTHER_TEXT);
    await expect(submit).toBeEnabled();
    await app.snapshot('second-question-other-answer');

    await app.window.getByRole('button', { name: 'Previous question' }).click();
    await expect(app.window.getByText('Which framework should we use?')).toBeVisible();
    await expect(app.window.locator('label.qopt.selected')).toHaveText(/Vue/);
    await app.window.getByRole('button', { name: 'Next question' }).click();
    await expect(app.window.getByPlaceholder('Share your thoughts…')).toHaveValue(OTHER_TEXT);
    await submit.click();

    await expect(transcript.getByText('Plan recorded.', { exact: true })).toBeVisible();
    const result = toolResults(model.request(before + 1)).at(-1) ?? '';
    expect(result).toContain('Vue');
    expect(result).toContain(OTHER_TEXT);
    expect(result).not.toContain('Canary first');
  });

  await test.step('a dismissed question tells the model the user did not answer', async () => {
    model.script(
      call('AskUserQuestion', { questions: [question('Should I also write docs?', 'Docs', ['Yes', 'No'])] }),
      say('Skipping docs.'),
    );
    const before = model.requests().length;
    await app.startTurn('Finish up');
    await expect(app.window.getByText('Should I also write docs?')).toBeVisible();
    await app.window.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(submit).toBeHidden();
    await app.window.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(submit).toBeVisible();
    await app.window.getByRole('button', { name: 'Dismiss', exact: true }).last().click();
    await expect(transcript.getByText('Skipping docs.', { exact: true })).toBeVisible();
    await expect(submit).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
    const result = toolResults(model.request(before + 1)).at(-1) ?? '';
    expect(result).toContain('dismissed');
    await expect(transcript.getByText('Should I also write docs? —— No answer', { exact: true })).toBeVisible();
  });

  await test.step('after a relaunch the transcript still shows the answered and dismissed questions', async () => {
    const sessionUrl = app.window.url();
    await app.relaunch();
    const restoredSidebar = sidebarOf(app);
    await expect(restoredSidebar.getByText('Create both files')).toBeVisible({ timeout: 30_000 });
    if (app.window.url() !== sessionUrl) await restoredSidebar.getByText('Create both files').click();
    const restored = app.window.getByRole('list').first();
    await expect(restored.getByText('Skipping docs.', { exact: true })).toBeVisible();
    await expect(restored.getByText('Collected your answers')).toHaveCount(2);
    await expect(restored.getByText('Should I also write docs? —— No answer', { exact: true })).toBeVisible();
    await expect(restoredSidebar.getByText('Answer', { exact: true })).toHaveCount(0);
    await expect(restoredSidebar.getByText('Approve', { exact: true })).toHaveCount(0);
    await app.snapshot('questions-after-relaunch');
  });
});
