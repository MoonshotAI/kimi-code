import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { updateGoal } from './fixtures/agents';
import { bash, held, messageProblems, say } from './fixtures/model';

const OBJECTIVE = 'Write CHANGELOG.md for the release';
const DRAFTED = 'Drafted the changelog.';
const POLISHING = 'Still polishing the wording.';
const BLOCKED = 'Blocked: the release date is unknown.';
const DONE = 'The changelog is complete.';
const SECOND = 'Tag the release in git';
const TAGGING = 'Preparing the tag.';

const GOAL_REMINDER = 'You are working under an active goal (goal mode).';
const CONTINUE = /^Continue working toward the active goal\./;

test.use({ permissionMode: 'yolo' });

test('a goal runs continuation turns, pauses, blocks, resumes and completes', async ({ app, model }) => {
  model.script(
    bash('echo "## Draft" > CHANGELOG.md', { description: 'Draft the changelog' }),
    say(DRAFTED),
    held('goal-polish', say(POLISHING)),
    updateGoal('blocked'),
    say(BLOCKED),
    bash('echo "Released 2026-10-02" >> CHANGELOG.md', { description: 'Add the release date' }),
    updateGoal('complete'),
    say(DONE),
  );
  const polish = model.hold('goal-polish');
  const window = app.window;
  const transcript = window.getByRole('list').first();
  const dock = window.locator('.dock-work-panel');

  await test.step('starting a goal runs the first turn and a continuation', async () => {
    await app.submit(`/goal ${OBJECTIVE}`);
    await expect(transcript.getByText(DRAFTED, { exact: true })).toBeVisible();
    const continuation = await polish.reached();
    const first = model.request(0);
    expect(first.userTextsSinceReply).toEqual([OBJECTIVE]);
    expect(first.remindersSinceReply.filter(reminder => reminder.startsWith(GOAL_REMINDER) && reminder.includes(OBJECTIVE))).toHaveLength(1);
    expect(continuation.index).toBe(2);
    expect(continuation.userTextsSinceReply).toHaveLength(1);
    expect(continuation.userTextsSinceReply[0]).toMatch(CONTINUE);
    expect(continuation.remindersSinceReply.some(reminder => reminder.includes('Progress: 1 continuation turns'))).toBe(true);
    expect((await readFile(join(app.workspace, 'CHANGELOG.md'), 'utf8'))).toBe('## Draft\n');
    await expect(window.getByRole('button', { name: 'Goal Active' })).toBeVisible();
    await window.getByRole('button', { name: 'Goal Active' }).click();
    await expect(dock.getByText(OBJECTIVE)).toBeVisible();
    await app.snapshot('goal-active');
  });

  await test.step('pausing lets the running turn finish without another continuation', async () => {
    await dock.getByRole('button', { name: 'Pause' }).click();
    await expect(window.getByRole('button', { name: 'Goal Paused' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect.poll(() => model.request(2).aborted).toBe(true);
    polish.release();
    await expect(transcript.getByText(POLISHING, { exact: true })).toHaveCount(0);
    expect(model.requests()).toHaveLength(3);
    await app.snapshot('goal-paused');
  });

  await test.step('resuming continues and the agent marks the goal blocked', async () => {
    await expect(window.getByRole('button', { name: 'Goal Paused' })).toHaveAttribute('aria-pressed', 'true');
    await dock.getByRole('button', { name: 'Resume' }).click();
    await expect(transcript.getByText(BLOCKED, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Goal Blocked' })).toBeVisible();
    const blocked = model.requests().find(request => request.step?.text?.[0] === BLOCKED)!;
    expect(blocked.texts('tool').filter(text => text.startsWith('Goal blocked.'))).toHaveLength(1);
    expect(model.request(3).userTextsSinceReply[0]).toMatch(CONTINUE);
    expect(model.requests()).toHaveLength(5);
    await app.snapshot('goal-blocked');
  });

  await test.step('resuming the blocked goal finishes the work and completes it', async () => {
    await expect(window.getByRole('button', { name: 'Goal Blocked' })).toHaveAttribute('aria-pressed', 'true');
    await dock.getByRole('button', { name: 'Resume' }).click();
    await expect(transcript.getByText(DONE, { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: /^Goal/ })).toHaveCount(0);
    const final = model.requests().find(request => request.step?.text?.[0] === DONE)!;
    expect(final.texts('tool').filter(text => text.startsWith('Goal completed successfully.'))).toHaveLength(1);
    expect(await readFile(join(app.workspace, 'CHANGELOG.md'), 'utf8')).toBe('## Draft\nReleased 2026-10-02\n');
    expect(model.request(5).userTextsSinceReply[0]).toMatch(CONTINUE);
    expect(model.requests()).toHaveLength(8);
    expect(model.requests().filter(request => request.aborted).map(request => request.index)).toEqual([2]);
    expect(messageProblems(final.messages)).toEqual([]);
    await app.snapshot('goal-complete');
  });

  await test.step('a second goal is cancelled only after confirming', async () => {
    model.script(say(TAGGING), held('goal-tag', say('Tag pushed.')));
    await app.submit(`/goal ${SECOND}`);
    await expect(transcript.getByText(TAGGING, { exact: true })).toBeVisible();
    await model.hold('goal-tag').reached();
    const pill = window.getByRole('button', { name: 'Goal Active' });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(dock.getByText(SECOND)).toBeVisible();
    await dock.getByRole('button', { name: 'Cancel' }).click();
    await expect(window.getByText('Cancel this goal? It cannot be resumed afterwards.')).toBeVisible();
    await app.snapshot('goal-cancel-confirm');
    await window.getByRole('button', { name: 'No', exact: true }).click();
    await expect(window.getByText('Cancel this goal? It cannot be resumed afterwards.')).toBeHidden();
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
    await pill.click();
    await dock.getByRole('button', { name: 'Cancel' }).click();
    await window.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(window.getByRole('button', { name: /^Goal/ })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect.poll(() => model.requests().at(-1)!.aborted).toBe(true);
    await expect(transcript.getByText('Tag pushed.', { exact: true })).toHaveCount(0);
    expect(model.requests()).toHaveLength(10);
    await app.snapshot('goal-cancelled');
  });

  await test.step('after relaunch no goal is restored and both goal runs stay in the transcript', async () => {
    await app.relaunch();
    const restored = app.window;
    await expect(restored.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    const list = restored.getByRole('list').first();
    await expect(list.getByText(TAGGING, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByText(DONE, { exact: true })).toBeVisible();
    await expect(list.getByText(BLOCKED, { exact: true })).toBeVisible();
    await expect(restored.getByRole('button', { name: /^Goal/ })).toHaveCount(0);
    expect(model.requests()).toHaveLength(10);
  });
});
