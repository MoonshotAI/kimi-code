import { expect, test, type DesktopApp } from './fixtures/app';
import { bash, messageProblems, say, type StubModel } from './fixtures/model';

test.use({ permissionMode: 'yolo' });

interface Phase {
  readonly prompt: string;
  readonly steer: string;
  readonly reply: string;
  readonly gate: string;
  readonly sendSteer: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

async function steerThenStop(app: DesktopApp, model: StubModel, phase: Phase): Promise<void> {
  model.script(bash(`while [ ! -f ${phase.gate} ]; do sleep 0.1; done; echo built`, { description: 'Slow build' }), say(phase.reply));
  const before = model.requests().length;
  await app.startTurn(phase.prompt);
  const transcript = app.window.getByRole('list').first();
  const build = transcript.getByRole('listitem').filter({ hasText: `while [ ! -f ${phase.gate} ]` });
  await expect(build.getByRole('status', { name: 'running' })).toBeVisible();
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();

  await phase.sendSteer();
  await expect(transcript.getByText(phase.steer, { exact: true })).toHaveCount(1);
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  expect(model.requests()).toHaveLength(before + 1);

  await phase.stop();
  await expect(build.getByRole('status', { name: 'cancelled' })).toBeVisible();

  model.dropScript();

  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  await expect(app.window.getByRole('combobox', { name: 'Message input' })).toHaveText('');
  for (const request of model.requests().slice(before)) expect(messageProblems(request.messages)).toEqual([]);
}

test('Stop after a steer interrupts the running build, and a reload shows each prompt once', async ({ app, model }) => {
  const input = app.window.getByRole('combobox', { name: 'Message input' });
  const phases: Phase[] = [
    {
      prompt: 'Run the slow build',
      steer: 'Use the release profile instead',
      reply: 'Building with the release profile.',
      gate: 'first-gate',
      sendSteer: async () => {
        await app.submit('Use the release profile instead');
        const tip = app.window.getByRole('status').filter({ hasText: 'Messages sent while running now steer into the current turn by default.' });
        await expect(tip).toBeVisible();
        await tip.getByRole('button', { name: 'Dismiss' }).click();
      },
      stop: () => app.window.getByRole('button', { name: 'Interrupt', exact: true }).click(),
    },
    {
      prompt: 'Run the slow build again',
      steer: 'Skip the integration tests',
      reply: 'Skipping the integration tests.',
      gate: 'second-gate',
      sendSteer: async () => {
        await input.click();
        await app.window.keyboard.type('Skip the integration tests');
        await app.window.keyboard.press('ControlOrMeta+Enter');
        await expect(app.window.getByText('1 waiting to send')).toBeVisible();
        await app.window.keyboard.press('ControlOrMeta+s');
      },
      stop: async () => {
        await input.click();
        await app.window.keyboard.press('Escape');
        await expect(app.window.getByRole('button', { name: 'Press Esc again to interrupt' })).toBeVisible();
        await app.window.keyboard.press('Escape');
      },
    },
  ];
  for (const phase of phases) await steerThenStop(app, model, phase);
  const sent = model.requests().length;
  expect(model.aborts()).toBe(0);

  await app.window.reload();
  const reloaded = app.window.getByRole('list').first();
  await expect(reloaded.getByText(phases[1]!.prompt, { exact: true })).toBeVisible({ timeout: 30_000 });
  for (const phase of phases) await expect(reloaded.getByText(phase.prompt, { exact: true })).toHaveCount(1);
  await expect(app.window.getByText(/waiting to send/)).toHaveCount(0);
  await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
  expect(model.requests()).toHaveLength(sent);
  await expect(app.window.getByRole('alert')).toHaveCount(0);
});
