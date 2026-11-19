import { expect, test } from './fixtures/app';
import { messageProblems, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const LINES = ['Plan the migration:', '- move the config loader', '- rename the env flags', '- update the docs', '- keep the old flags working'];
const MULTILINE = LINES.join('\n');
const SECOND = 'Now summarise the plan in one sentence';
const DRAFT = 'unsent thought';
const OPENER = 'Start a migration planning session';

test('a multi-line prompt is written, expanded, sent verbatim and recalled from history after a relaunch', async ({ app, model }) => {
  model.script(say('Ready to plan.'), say('Migration plan noted.'), say('One sentence summary.'));
  const input = app.window.getByRole('combobox', { name: 'Message input' });
  const lines = input.getByRole('paragraph');
  const transcript = app.window.getByRole('list').first();
  const expand = app.window.getByRole('button', { name: 'Expand input for multi-line editing' });
  const collapse = app.window.getByRole('button', { name: 'Collapse input' });

  await test.step('an opening prompt creates the session', async () => {
    const request = await app.startTurn(OPENER);
    expect(request.userTextsSinceReply).toEqual([OPENER]);
    await expect(transcript.getByText('Ready to plan.', { exact: true })).toBeVisible();
    await app.sessionId();
  });

  await test.step('Shift+Enter inserts line breaks without sending', async () => {
    await input.click();
    await app.window.keyboard.type(LINES[0]!);
    await expect(expand).toBeHidden();
    await app.window.keyboard.press('Shift+Enter');
    await app.window.keyboard.type(LINES[1]!);
    await app.window.keyboard.press('Shift+Enter');
    await app.window.keyboard.type(LINES[2]!);
    await expect(lines).toHaveText(LINES.slice(0, 3));
    await app.window.keyboard.press('Shift+Enter');
    await app.window.keyboard.type(LINES[3]!);
    await expect(lines).toHaveText(LINES.slice(0, 4));
    await expect(expand).toBeVisible();
    expect(model.requests()).toHaveLength(1);
    await app.snapshot('four-lines-grown');
  });

  await test.step('the expanded editor takes Enter as a newline and Mod+Enter sends', async () => {
    await expand.click();
    await expect(collapse).toBeVisible();
    await app.window.keyboard.press('Enter');
    await app.window.keyboard.type(LINES[4]!);
    await expect(lines).toHaveText(LINES);
    expect(model.requests()).toHaveLength(1);
    await app.snapshot('expanded-five-lines');
    const next = model.requests().length;
    await app.window.keyboard.press('ControlOrMeta+Enter');
    const request = await model.waitForRequest(next);
    expect(request.userTextsSinceReply).toEqual([MULTILINE]);
    await expect(transcript.getByText('Migration plan noted.', { exact: true })).toBeVisible();
    await expect(lines).toHaveText(['']);
    await expect(collapse).toBeHidden();
    await expect(expand).toBeHidden();
  });

  await test.step('the sent bubble keeps every line and Enter sends the next prompt', async () => {
    const bubble = transcript.getByRole('listitem').filter({ hasText: LINES[0]! }).first();
    for (const line of LINES) await expect(bubble).toContainText(line);
    const request = await app.startTurn(SECOND);
    expect(request.userTextsSinceReply).toEqual([SECOND]);
    expect(request.texts('user').filter(text => text === MULTILINE)).toHaveLength(1);
    expect(messageProblems(request.messages)).toEqual([]);
    await expect(transcript.getByText('One sentence summary.', { exact: true })).toBeVisible();
    await app.snapshot('two-turns');
  });

  await test.step('Escape and ArrowUp leave a non-empty draft alone', async () => {
    await input.click();
    await app.window.keyboard.type(DRAFT);
    await app.window.keyboard.press('Escape');
    await expect(lines).toHaveText([DRAFT]);
    await app.window.keyboard.press('ArrowUp');
    await expect(lines).toHaveText([DRAFT]);
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await app.window.keyboard.press('ControlOrMeta+a');
    await app.window.keyboard.press('Backspace');
    await expect(lines).toHaveText(['']);
    await app.window.keyboard.press('Escape');
    await expect(lines).toHaveText(['']);
    expect(model.requests()).toHaveLength(3);
  });

  await test.step('ArrowUp and ArrowDown walk the prompt history on an empty composer', async () => {
    await app.window.keyboard.press('ArrowUp');
    await expect(lines).toHaveText([SECOND]);
    await app.window.keyboard.press('ArrowUp');
    await expect(lines).toHaveText(LINES);
    await app.snapshot('history-recalled');
    await app.window.keyboard.press('ArrowDown');
    await expect(lines).toHaveText([SECOND]);
    await app.window.keyboard.press('ArrowDown');
    await expect(lines).toHaveText(['']);
  });

  await test.step('history survives a relaunch and a recalled prompt can be sent again', async () => {
    const sessionUrl = app.window.url();
    await app.relaunch();
    const sidebar = sidebarOf(app);
    if (app.window.url() !== sessionUrl) await sidebar.getByText(OPENER).click();
    await expect.poll(() => app.window.url()).toBe(sessionUrl);
    const restoredInput = app.window.getByRole('combobox', { name: 'Message input' });
    const restoredLines = restoredInput.getByRole('paragraph');
    const restored = app.window.getByRole('list').first();
    await expect(restored.getByText('One sentence summary.', { exact: true })).toBeVisible();
    const bubble = restored.getByRole('listitem').filter({ hasText: LINES[0]! }).first();
    for (const line of LINES) await expect(bubble).toContainText(line);
    await expect(restored.getByText(SECOND, { exact: true })).toHaveCount(1);
    await restoredInput.click();
    await app.window.keyboard.press('ArrowUp');
    await expect(restoredLines).toHaveText([SECOND]);
    await app.window.keyboard.press('ArrowUp');
    await expect(restoredLines).toHaveText(LINES);
    await app.snapshot('history-after-relaunch');
    model.script(say('Sent again.'));
    const next = model.requests().length;
    await app.window.keyboard.press('Enter');
    const request = await model.waitForRequest(next);
    expect(request.userTextsSinceReply).toEqual([MULTILINE]);
    await expect(app.window.getByRole('list').first().getByText('Sent again.', { exact: true })).toBeVisible();
    await expect(restoredLines).toHaveText(['']);
    await expect(app.window.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('next-prompt manual recall', () => {
  test.use({ appEnv: { KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION: '1' } });

  test('parks a prediction for Tab or Right Arrow recall and consumes it on submit or Escape', async ({ app, model }) => {
    const tabPrediction = 'Recall this prediction with Tab';
    const rightPrediction = 'Recall this prediction with Right Arrow';
    const dismissedPrediction = 'Dismiss this prediction only';
    const draft = 'keep this draft';
    model.script(
      say('First answer.'),
      say(tabPrediction),
      say('Second answer.'),
      say(rightPrediction),
      say('Third answer.'),
      say(dismissedPrediction),
    );
    const input = app.window.getByRole('combobox', { name: 'Message input' });
    const lines = input.getByRole('paragraph');
    const ghost = app.window.locator('.composer-prompt-prediction-overlay');
    const recall = app.window.locator('.prompt-prediction-recall');
    const transcript = app.window.getByRole('list').first();

    await app.startTurn(OPENER);
    await expect(ghost).toHaveText(tabPrediction);
    const descriptionId = await input.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    await expect(app.window.locator(`#${descriptionId}`)).toHaveText(`Prediction: ${tabPrediction}. Press Tab or Right Arrow to insert.`);
    await app.window.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(ghost).toBeVisible();
    await input.click();
    await app.window.keyboard.type('another draft');
    await expect(ghost).toBeHidden();
    await app.window.keyboard.press('ControlOrMeta+a');
    await app.window.keyboard.press('Backspace');
    await expect(recall).toBeVisible();
    await expect(recall).toContainText(tabPrediction);
    await app.window.keyboard.press('Tab');
    await expect(lines).toHaveText([tabPrediction]);
    await expect(recall).toHaveCount(0);
    expect(model.requests()).toHaveLength(2);

    await app.window.keyboard.press('ControlOrMeta+a');
    await app.window.keyboard.press('Backspace');
    await expect(recall).toHaveCount(0);
    await app.window.keyboard.type(tabPrediction);
    await app.window.keyboard.press('Enter');
    const second = await model.waitForRequest(2);
    expect(second.userTextsSinceReply).toEqual([tabPrediction]);
    await expect(transcript.getByText('Second answer.', { exact: true })).toBeVisible();

    await expect(ghost).toHaveText(rightPrediction);
    await input.click();
    await app.window.keyboard.type('another draft');
    await app.window.keyboard.press('ControlOrMeta+a');
    await app.window.keyboard.press('Backspace');
    await expect(recall).toContainText(rightPrediction);
    await app.window.keyboard.press('ArrowRight');
    await expect(lines).toHaveText([rightPrediction]);
    await app.window.keyboard.press('Enter');
    const third = await model.waitForRequest(4);
    expect(third.userTextsSinceReply).toEqual([rightPrediction]);
    await expect(transcript.getByText('Third answer.', { exact: true })).toBeVisible();

    await expect(ghost).toHaveText(dismissedPrediction);
    await input.click();
    await app.window.keyboard.type(draft);
    await app.window.keyboard.press('Escape');
    await expect(lines).toHaveText([draft]);
    await expect(ghost).toBeHidden();
    await expect(recall).toHaveCount(0);
    expect(model.requests()).toHaveLength(6);
  });
});
