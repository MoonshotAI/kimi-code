import { expect, test } from './fixtures/app';
import { held, messageProblems, say, textOf, withoutReminders } from './fixtures/model';

const TOPICS = ['parser', 'lexer', 'emitter'] as const;
const prompt = (topic: string): string => `Explain the ${topic} module`;
const reply = (topic: string): string[] =>
  Array.from({ length: 12 }, (_, index) => `The ${topic} note ${index + 1}: ${topic} details for paragraph ${index + 1}.\n\n`);
const SIDE_QUESTION = 'Which modules did we cover so far?';
const SIDE_ANSWER = 'We covered the parser, the lexer and the emitter.';
const SUMMARY = 'Handoff summary: explained the parser, lexer and emitter modules.';
const AFTER = 'Now explain the optimizer';
const AFTER_REPLY = 'The optimizer folds constants.';

test.use({ permissionMode: 'yolo' });

test('outline, transcript search, side chat and manual compaction work over one long session', { tag: '@quarantine' }, async ({ app, model }) => {
  model.script(...TOPICS.map(topic => say(reply(topic), { intervalMs: 5 })));
  const window = app.window;
  const transcript = window.getByRole('list').first();

  await test.step('three long turns build a scrollable conversation with an outline', async () => {
    for (const topic of TOPICS) {
      await app.startTurn(prompt(topic));
      await expect(transcript.getByText(`The ${topic} note 12:`, { exact: false })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    }
    const outline = window.getByRole('navigation', { name: 'Conversation outline' });
    await window.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(outline.getByRole('button')).toHaveCount(TOPICS.length);
    expect(await outline.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(TOPICS.map(prompt));
    await expect(transcript.getByText(prompt('parser'), { exact: true })).not.toBeInViewport();
    await outline.getByRole('button', { name: prompt('parser') }).first().click();
    await expect(transcript.getByText(prompt('parser'), { exact: true })).toBeInViewport();
    await expect(outline.getByRole('button', { name: prompt('parser') }).first()).toHaveAttribute('aria-current', 'location');
    await app.snapshot('outline-first-turn');
    await outline.getByRole('button', { name: prompt('emitter') }).first().click();
    await expect(transcript.getByText(prompt('emitter'), { exact: true })).toBeInViewport();
  });

  await test.step('transcript search finds matches across turns', async () => {
    await window.keyboard.press('ControlOrMeta+f');
    const search = window.getByRole('search');
    const count = search.getByRole('status').filter({ hasText: /results?$/ });
    await expect(search.getByPlaceholder('Search chat…')).toBeFocused();
    await window.keyboard.type('lexer details');
    await expect(count).toHaveText(/^\d+\/12 results$/);
    const current = Number(/^(\d+)/.exec(await count.innerText())![1]);
    const next = current % 12 + 1;
    await window.keyboard.press('Enter');
    await expect(count).toHaveText(`${next}/12 results`);
    await expect(transcript.getByText(`The lexer note ${next}:`, { exact: false })).toBeInViewport();
    await window.keyboard.press('Shift+Enter');
    await expect(count).toHaveText(`${current}/12 results`);
    await expect(transcript.getByText(`The lexer note ${current}:`, { exact: false })).toBeInViewport();
    await app.snapshot('transcript-search');
    await search.getByPlaceholder('Search chat…').fill('no such phrase');
    await expect(search.getByText('No results', { exact: true })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(search).toBeHidden();
  });

  await test.step('the side chat answers from the session context without touching the transcript', async () => {
    model.script(say(SIDE_ANSWER));
    const before = model.requests().length;
    await window.keyboard.press('Alt+ControlOrMeta+b');
    const panel = window.getByRole('complementary', { name: 'Detail panel' });
    await expect(panel.getByRole('tab', { name: /Side Chat/ })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText('Read-only Q&A based on the current session context.', { exact: false })).toBeVisible();
    const input = panel.getByRole('combobox', { name: 'Message input' });
    await input.click();
    await window.keyboard.type(SIDE_QUESTION);
    await window.keyboard.press('Enter');
    await expect(panel.getByText(SIDE_ANSWER, { exact: true })).toBeVisible();
    const side = await model.waitForRequest(before);
    const texts = side.messages.map(message => withoutReminders(textOf(message.content)));
    for (const topic of TOPICS) expect(texts).toContain(prompt(topic));
    expect(side.userTextsSinceReply).toEqual([SIDE_QUESTION]);
    expect(side.remindersSinceReply.some(reminder => reminder.startsWith('This is a side-channel conversation with the user.'))).toBe(true);
    await expect(transcript.getByText(SIDE_QUESTION)).toHaveCount(0);
    await expect(transcript.getByText(SIDE_ANSWER)).toHaveCount(0);
    await app.snapshot('side-chat-answer');
  });

  await test.step('/compact shows progress, then the summary opens in its own tab', async () => {
    model.script(held('compact-summary', say(SUMMARY)));
    const hold = model.hold('compact-summary');
    await window.getByRole('button', { name: 'Jump to latest message' }).click();
    await expect(transcript.getByText('The emitter note 12:', { exact: false })).toBeInViewport();
    await app.window.getByRole('combobox', { name: 'Message input' }).first().click();
    await window.keyboard.type('/compact');
    await window.keyboard.press('Enter');
    await window.keyboard.press('Enter');
    const request = await hold.reached();
    expect(request.userTextsSinceReply[0]).toMatch(/^You are about to run out of context\. Create a handoff summary/);
    const progress = window.getByRole('status').filter({ hasText: 'Compacting context…' });
    await expect(progress).toBeVisible();
    await app.snapshot('compacting');
    hold.release();
    await expect(transcript.getByText(/^Context compacted/)).toBeVisible();
    await expect(progress).toBeHidden();
    await transcript.getByRole('button', { name: 'View summary' }).click();
    const panel = window.getByRole('complementary', { name: 'Detail panel' });
    await expect(panel.getByRole('tab', { name: /Compaction summary/ })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText(SUMMARY)).toBeVisible();
    await app.snapshot('compaction-summary');
  });

  await test.step('the next turn is built from the compacted context', async () => {
    model.script(say(AFTER_REPLY));
    const next = await app.startTurn(AFTER);
    await expect(transcript.getByText(AFTER_REPLY, { exact: true })).toBeVisible();
    const texts = next.messages.map(message => withoutReminders(textOf(message.content)));
    expect(texts.some(text => text.includes(SUMMARY))).toBe(true);
    expect(texts.some(text => text.includes('The parser note 1:'))).toBe(false);
    expect(texts.some(text => text.includes(SIDE_ANSWER) || text.includes(SIDE_QUESTION))).toBe(false);
    expect(next.messages.filter(message => message.role === 'assistant')).toHaveLength(0);
    expect(next.userTextsSinceReply).toHaveLength(3);
    expect(next.userTextsSinceReply[0]).toBe(TOPICS.map(prompt).join('\n\n'));
    expect(next.userTextsSinceReply[1]).toMatch(/^The conversation so far has been compacted/);
    expect(next.userTextsSinceReply[1]).toContain(SUMMARY);
    expect(next.userTextsSinceReply[2]).toBe(AFTER);
    expect(messageProblems(next.messages)).toEqual([]);
  });

  await test.step('after relaunch the transcript and the open summary tab are restored', async () => {
    await app.relaunch();
    const restored = app.window;
    await expect(restored.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    const list = restored.getByRole('list').first();
    await expect(list.getByText(AFTER_REPLY, { exact: true })).toBeVisible({ timeout: 30_000 });
    for (const topic of TOPICS) await expect(list.getByText(prompt(topic), { exact: true })).toHaveCount(1);
    await expect(list.getByText(SIDE_ANSWER)).toHaveCount(0);
    await expect(list.getByText(SIDE_QUESTION)).toHaveCount(0);
    const panel = restored.getByRole('complementary', { name: 'Detail panel' });
    await expect(panel.getByRole('tab', { name: /Compaction summary/ })).toBeVisible();
    await panel.getByRole('tab', { name: /Compaction summary/ }).click();
    await expect(panel.getByText(SUMMARY)).toBeVisible();
    await app.snapshot('compaction-restored');
  });
});

test('the compaction divider and its View summary button survive a relaunch', async ({ app, model }) => {
  model.script(say('First answer.'), say('Second answer.'), say(SUMMARY));
  await app.startTurn('First question');
  await expect(app.window.getByText('First answer.', { exact: true })).toBeVisible();
  await app.startTurn('Second question');
  await expect(app.window.getByText('Second answer.', { exact: true })).toBeVisible();
  await app.window.getByRole('combobox', { name: 'Message input' }).click();
  await app.window.keyboard.type('/compact');
  await app.window.keyboard.press('Enter');
  await app.window.keyboard.press('Enter');
  await expect(app.window.getByRole('list').first().getByText(/^Context compacted/)).toBeVisible();
  await app.relaunch();
  const list = app.window.getByRole('list').first();
  await expect(list.getByText('Second answer.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByText(/^Context compacted/)).toBeVisible();
  await list.getByRole('button', { name: 'View summary' }).click();
  await expect(app.window.getByRole('complementary', { name: 'Detail panel' }).getByText(SUMMARY)).toBeVisible();
});
