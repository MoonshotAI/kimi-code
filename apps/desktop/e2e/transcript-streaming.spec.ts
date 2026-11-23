import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { batch, call, held, messageProblems, say, think, textOf } from './fixtures/model';
import { relaunchAndSettle, scrollTopOf, waitForSettledReply } from './fixtures/transcript';

const THINK_PROMPT = 'Should the build use the cache?';
const REASONING = ['Weighing the warm cache ', 'against a clean network fetch.'];
const ANSWER = 'Use the warm cache.';
const TOOLS_PROMPT = 'Write the three marker files';
const TOOLS_REPLY = 'All three marker files are written.';
const LONG_PROMPT = 'Write the long rollout plan';
const LINES = Array.from({ length: 80 }, (_, index) => `Rollout line ${index + 1} of the plan.\n\n`);
const HELD_AT = 60;

test.use({ permissionMode: 'yolo' });

test('streamed replies show thinking, fold tool runs, and keep the reader in place until they jump to the latest message', async ({ app, model }) => {
  const transcript = app.window.getByRole('list').first();
  const interrupt = app.window.getByRole('button', { name: 'Interrupt', exact: true });

  await test.step('reasoning streams into a live thinking block before the answer arrives', async () => {
    const hold = model.hold('reasoning-midway');
    model.script(held('reasoning-midway', think(REASONING, say(['Use the ', 'warm cache.'])), 1));
    await app.startTurn(THINK_PROMPT);
    await hold.reached();
    await expect(transcript.getByRole('button', { name: /^Thinking…/ })).toBeVisible();
    await expect(transcript.getByText(REASONING[0]!.trim())).toBeAttached();
    await expect(transcript.getByText(ANSWER)).toHaveCount(0);
    await expect(interrupt).toBeVisible();
    await app.snapshot('thinking-live');
    hold.release();
    await waitForSettledReply(app.window, ANSWER);
  });

  await test.step('the finished thinking block collapses and toggles open and closed', async () => {
    const toggle = transcript.getByRole('button', { name: /^Thinking/ });
    await expect(toggle).toHaveCount(1);
    await expect(toggle).not.toHaveAccessibleName(/Thinking…/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const reasoning = transcript.getByText(REASONING.join('').trim());
    await expect(reasoning).toBeAttached();
    await expect(reasoning).not.toBeInViewport();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(reasoning).toBeInViewport();
    await app.snapshot('thinking-open');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(reasoning).not.toBeInViewport();
  });

  await test.step('a batch of tool calls folds into one activity run that expands to every file', async () => {
    model.script(
      think('Plan the marker files.', batch(
        call('Write', { path: 'one.txt', content: 'one\n' }),
        call('Write', { path: 'two.txt', content: 'two\n' }),
        call('Write', { path: 'three.txt', content: 'three\n' }),
      )),
      say(TOOLS_REPLY),
    );
    await app.startTurn(TOOLS_PROMPT);
    await waitForSettledReply(app.window, TOOLS_REPLY);
    for (const name of ['one', 'two', 'three']) {
      expect((await readFile(join(app.workspace, `${name}.txt`), 'utf8')).trim()).toBe(name);
    }
    const run = transcript.locator('button.ar-head');
    await expect(run).toHaveAttribute('aria-expanded', 'false');
    const activity = run.locator('xpath=ancestor::div[contains(@class,"activity-run")][1]');
    const card = (name: string) => activity.getByRole('button', { name: `${name}.txt`, exact: true }).first();
    const first = card('one');
    await expect(first).not.toBeInViewport();
    await app.snapshot('activity-run-folded');
    await run.click();
    await expect(run).toHaveAttribute('aria-expanded', 'true');
    for (const name of ['one', 'two', 'three']) {
      await expect(card(name)).toBeInViewport();
    }
    await app.snapshot('activity-run-open');
    await run.click();
    await expect(run).toHaveAttribute('aria-expanded', 'false');
    await expect(first).not.toBeInViewport();

    const followUp = model.request(model.requests().length - 1);
    const results = followUp.messages.filter(message => message.role === 'tool').map(message => textOf(message.content));
    expect(results).toHaveLength(3);
    expect(messageProblems(followUp.messages)).toEqual([]);
  });

  await test.step('a long reply streams progressively while the turn is running', async () => {
    const hold = model.hold('long-midway');
    model.script(held('long-midway', say(LINES, { intervalMs: 5 }), HELD_AT));
    await app.startTurn(LONG_PROMPT);
    await hold.reached();
    await expect(transcript.getByText(`Rollout line ${HELD_AT} of the plan.`, { exact: true })).toBeVisible();
    await expect(transcript.getByText(`Rollout line ${HELD_AT + 1} of the plan.`, { exact: true })).toHaveCount(0);
    await expect(app.window.getByRole('status').filter({ hasText: 'Working…' })).toBeVisible();
    await expect(interrupt).toBeVisible();
    await expect(transcript.getByText(`Rollout line ${HELD_AT} of the plan.`, { exact: true })).toBeInViewport();
  });

  await test.step('scrolling up mid-stream offers the jump pill and new text does not drag the reader down', async () => {
    const jump = app.window.getByRole('button', { name: 'Jump to latest message' });
    await expect(jump).toBeHidden();
    await transcript.hover();
    await app.window.mouse.wheel(0, -4000);
    await expect(jump).toBeVisible();
    await expect(transcript.getByText(`Rollout line ${HELD_AT} of the plan.`, { exact: true })).not.toBeInViewport();
    const parked = await scrollTopOf(transcript);
    await expect(jump).toHaveCSS('opacity', '1');
    await app.snapshot('jump-pill');

    model.hold('long-midway').release();
    await expect(transcript.getByText('Rollout line 80 of the plan.', { exact: true })).toBeAttached();
    await expect(interrupt).toBeHidden();
    await expect(jump).toBeVisible();
    await expect(transcript.getByText('Rollout line 80 of the plan.', { exact: true })).not.toBeInViewport();
    expect(Math.abs((await scrollTopOf(transcript)) - parked)).toBeLessThan(40);
  });

  await test.step('the jump pill scrolls to the end of the finished reply and hides', async () => {
    await app.window.getByRole('button', { name: 'Jump to latest message' }).click();
    await expect(transcript.getByText('Rollout line 80 of the plan.', { exact: true })).toBeInViewport();
    await expect(app.window.getByRole('button', { name: 'Jump to latest message' })).toBeHidden();
    await app.snapshot('jumped-to-latest');
  });

  await test.step('after a relaunch the thinking block and the activity run come back collapsed with the full reply', async () => {
    await relaunchAndSettle(app, THINK_PROMPT);
    const restored = app.window.getByRole('list').first();
    await expect(restored.getByText('Rollout line 80 of the plan.', { exact: true })).toBeAttached({ timeout: 30_000 });
    await restored.hover();
    await app.window.mouse.wheel(0, -100_000);
    await expect(restored.getByText(ANSWER, { exact: true })).toBeAttached();
    const toggle = restored.getByRole('button', { name: /^Thinking/ }).first();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const run = restored.locator('button.ar-head');
    await expect(run).toHaveAttribute('aria-expanded', 'false');
    await run.scrollIntoViewIfNeeded();
    await run.click();
    await expect(restored.getByText('Wrote 6 bytes to three.txt', { exact: true })).toBeVisible();
    await expect(restored.getByText(TOOLS_REPLY, { exact: true })).toBeVisible();
    await app.snapshot('restored');
    expect(model.requests()).toHaveLength(4);
    expect(model.aborts()).toBe(0);
  });
});
