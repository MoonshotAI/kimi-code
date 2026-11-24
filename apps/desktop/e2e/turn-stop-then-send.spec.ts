import { held as holdReply, say as reply } from '@moonshot-ai/testkit/model';

import { expect, test, testWithProvider, type DesktopApp } from './fixtures/app';
import { held, messageProblems, say, type StubModel } from './fixtures/model';

const INTERRUPTION_NOTE = 'The previous turn was interrupted by the user before completion';

async function stopAndSendAgain(
  app: DesktopApp,
  model: StubModel,
  phase: { prompt: string; partial: readonly string[]; next: string; reply: string; stop: () => Promise<void> },
): Promise<void> {
  const hold = model.hold(phase.prompt);
  model.script(held(phase.prompt, say([...phase.partial, ' and the rest of the answer.']), phase.partial.length), say(phase.reply));
  const before = model.requests().length;
  const streaming = await app.startTurn(phase.prompt);
  await hold.reached();
  const partial = phase.partial.join('');
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(partial, { exact: true })).toBeVisible();

  await phase.stop();
  await expect.poll(() => streaming.aborted, { message: 'waiting for the client to close the streaming request' }).toBe(true);
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  await expect(transcript.getByRole('status').filter({ hasText: 'Manually stopped' })).toBeVisible();
  await expect(transcript.getByText(partial, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('alert')).toHaveCount(0);

  const next = await app.startTurn(phase.next);
  await expect(transcript.getByText(phase.reply, { exact: true })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  expect(next.userTextsSinceReply).toEqual([phase.next]);
  expect(next.remindersSinceReply.some(reminder => reminder.includes(INTERRUPTION_NOTE))).toBe(true);
  expect(next.texts('assistant').at(-1)).toBe(partial);
  expect(next.texts('user').filter(text => text === phase.prompt)).toHaveLength(1);
  expect(messageProblems(next.messages)).toEqual([]);
  expect(model.requests()).toHaveLength(before + 2);

  const text = await transcript.innerText();
  const order = [phase.prompt, partial, phase.next, phase.reply].map(part => text.lastIndexOf(part));
  expect(order.every(index => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  await expect(transcript.getByText(phase.reply, { exact: true })).toHaveCount(1);
}

test('stopping a streaming turn keeps its partial answer and the next prompt gets its own reply', async ({ app, model }) => {
  await stopAndSendAgain(app, model, {
    prompt: 'Explain the build pipeline',
    partial: ['The pipeline ', 'starts with'],
    next: 'Summarize it in one line instead',
    reply: 'Build, test, package.',
    stop: () => app.window.getByRole('button', { name: 'Interrupt', exact: true }).click(),
  });

  await stopAndSendAgain(app, model, {
    prompt: 'Describe the release checklist',
    partial: ['First, ', 'bump the version'],
    next: 'Just list the first step',
    reply: 'Bump the version.',
    stop: async () => {
      await app.window.getByRole('combobox', { name: 'Message input' }).click();
      await app.window.keyboard.press('Escape');
      const armed = app.window.getByRole('button', { name: 'Press Esc again to interrupt' });
      await expect(armed).toBeVisible();
      await app.window.keyboard.press('Escape');
      await expect(armed).toBeHidden();
    },
  });
  expect(model.aborts()).toBe(2);
});

testWithProvider('the desktop cancels its testkit provider stream and continues the same conversation', async ({ app, provider }) => {
  const partial = 'I have checked the build.';
  const remaining = ' The rest would follow.';
  const answer = 'The next build is ready.';
  provider.script(holdReply('after-first-chunk', reply([partial, remaining]), 1), reply(answer));

  await app.submit('Check the build.');
  const active = await provider.hold('after-first-chunk').reached();
  const transcript = app.window.getByRole('list').first();
  await expect(transcript.getByText(partial, { exact: true })).toBeVisible();
  const sessionId = await app.sessionId();
  expect(active.authorization).toBe('Bearer test-key');
  expect(active.view.model).toBe('stub');
  expect(active.texts('system').join('\n')).toContain(app.workspace);

  await app.window.getByRole('button', { name: 'Interrupt', exact: true }).click();
  await expect.poll(() => active.state).toBe('aborted');
  await expect(transcript.getByRole('status').filter({ hasText: 'Manually stopped' })).toBeVisible();

  await app.submit('Check the next build.');
  await expect(transcript.getByText(answer, { exact: true })).toBeVisible();
  await expect(transcript.getByText(partial, { exact: true })).toBeVisible();
  await expect(transcript).not.toContainText(remaining.trim());
  expect(await app.sessionId()).toBe(sessionId);
  const requests = provider.requests('main');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.texts('assistant').at(-1)).toBe(partial);
});
