import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { bash, call, messageProblems, say, textOf } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const FIRST = 'echo first-approved > first.txt && cat first.txt';
const SESSION = 'echo session-ok >> session.log';
const OTHER = 'echo other-command > other.txt';
const DRAFT = 'draft.md';
const FEEDBACK = 'Do not create drafts; put it in the README instead';
const NOTES = 'notes.txt';

test.use({ permissionMode: 'manual' });

test('approval decisions under Always Ask: approve, approve for session, reject with feedback, edit, and a fresh session asks again', async ({ app, model }) => {
  const transcript = app.window.getByRole('list').first();
  const sidebar = sidebarOf(app);
  const approve = app.window.getByRole('button', { name: 'Approve', exact: true });
  const approveSession = app.window.getByRole('button', { name: 'Approve for session' });
  await writeFile(join(app.workspace, NOTES), 'status: draft\nowner: e2e\n');

  await test.step('a command waits for approval, minimizes and expands, then runs on Approve', async () => {
    model.script(bash(FIRST, { description: 'Write the first file' }), say('First command finished.'));
    await app.startTurn('Run the first command');
    await expect(app.window.getByText('Run command?')).toBeVisible();
    await expect(app.window.getByText(FIRST).first()).toBeVisible();
    await expect(sidebar.getByText('Approve', { exact: true })).toBeVisible();
    expect(existsSync(join(app.workspace, 'first.txt'))).toBe(false);
    await app.snapshot('command-approval-pending');

    await app.window.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(approve).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'Expand', exact: true })).toBeVisible();
    await app.snapshot('command-approval-minimized');
    await app.window.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(approve).toBeVisible();

    await approve.click();
    await expect(transcript.getByText('First command finished.', { exact: true })).toBeVisible();
    await expect(app.window.getByText('Run command?')).toBeHidden();
    await expect(sidebar.getByText('Approve', { exact: true })).toBeHidden();
    expect(await readFile(join(app.workspace, 'first.txt'), 'utf8')).toBe('first-approved\n');
    const result = model.request(1).messages.find(message => message.role === 'tool');
    expect(textOf(result?.content)).toContain('first-approved');
    await transcript.getByText(FIRST).first().click();
    await expect(transcript.getByText('first-approved', { exact: true })).toBeVisible();
    await app.snapshot('command-output-after-approve');
  });

  await test.step('Approve for session lets the same command run again without a card, while a different command still asks', async () => {
    model.script(
      bash(SESSION, { description: 'Append to the session log' }),
      bash(SESSION, { description: 'Append to the session log again' }),
      bash(OTHER, { description: 'A different command' }),
      say('Session approvals done.'),
    );
    const before = model.requests().length;
    await app.startTurn('Append to the log twice, then run another command');
    await expect(app.window.getByText('Run command?')).toBeVisible();
    await expect(approveSession).toBeVisible();
    await approveSession.click();

    await model.waitForRequest(before + 2);
    await expect(app.window.getByText('Run command?')).toBeVisible();
    await expect(app.window.getByText(OTHER).first()).toBeVisible();
    expect(await readFile(join(app.workspace, 'session.log'), 'utf8')).toBe('session-ok\nsession-ok\n');
    expect(existsSync(join(app.workspace, 'other.txt'))).toBe(false);
    await app.snapshot('different-command-still-asks');

    await approve.click();
    await expect(transcript.getByText('Session approvals done.', { exact: true })).toBeVisible();
    expect(await readFile(join(app.workspace, 'other.txt'), 'utf8')).toBe('other-command\n');
    expect(model.requests()).toHaveLength(before + 4);
  });

  await test.step('rejecting a file write with feedback keeps the file off disk and sends the feedback to the model', async () => {
    model.script(
      call('Write', { path: DRAFT, content: '# Draft\n' }),
      say('Understood, no draft.'),
    );
    const before = model.requests().length;
    await app.startTurn('Write a draft file');
    await expect(app.window.getByText('Write file?')).toBeVisible();
    await app.window.getByRole('button', { name: 'Feedback', exact: true }).click();
    const feedback = app.window.getByPlaceholder('Explain why you are rejecting…');
    await expect(feedback).toBeVisible();
    await feedback.fill(FEEDBACK);
    await app.snapshot('write-feedback-open');
    await app.window.getByRole('button', { name: 'Reject with feedback' }).click();

    await expect(transcript.getByText('Understood, no draft.', { exact: true })).toBeVisible();
    await expect(app.window.getByText('Write file?')).toBeHidden();
    expect(existsSync(join(app.workspace, DRAFT))).toBe(false);
    const next = model.request(before + 1);
    const toolResult = next.messages.filter(message => message.role === 'tool').at(-1);
    expect(textOf(toolResult?.content)).toContain(FEEDBACK);
    expect(messageProblems(next.messages)).toEqual([]);
  });

  await test.step('an approved edit changes the file on disk', async () => {
    model.script(
      call('Edit', { path: NOTES, old_string: 'status: draft', new_string: 'status: final' }),
      say('Notes updated.'),
    );
    await app.startTurn('Mark the notes final');
    await expect(app.window.getByText('Apply changes?')).toBeVisible();
    await expect(app.window.getByText('status: final').first()).toBeVisible();
    expect(await readFile(join(app.workspace, NOTES), 'utf8')).toBe('status: draft\nowner: e2e\n');
    await app.snapshot('edit-approval-pending');
    await approve.click();
    await expect(transcript.getByText('Notes updated.', { exact: true })).toBeVisible();
    expect(await readFile(join(app.workspace, NOTES), 'utf8')).toBe('status: final\nowner: e2e\n');
    await app.snapshot('edit-approved');
  });

  await test.step('a new session still asks for the command approved for the previous session', async () => {
    const firstSession = await app.sessionId();
    await app.window.getByRole('button', { name: 'New Session' }).first().click();
    await expect.poll(() => app.window.url()).not.toContain(firstSession);
    model.script(bash(SESSION, { description: 'Append to the session log' }), say('Rejected in the new session.'));
    await app.startTurn('Append to the log in a new session');
    await expect(app.window.getByText('Run command?')).toBeVisible();
    expect(await app.sessionId()).not.toBe(firstSession);
    await app.snapshot('new-session-asks-again');
    await app.window.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(transcript.getByText('Rejected in the new session.', { exact: true })).toBeVisible();
    expect(await readFile(join(app.workspace, 'session.log'), 'utf8')).toBe('session-ok\nsession-ok\n');
  });
});
