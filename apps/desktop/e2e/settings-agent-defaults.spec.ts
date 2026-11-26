import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Request } from '@playwright/test';

import { expect, test, type DesktopApp } from './fixtures/app';
import { agent, batch, call, say, stubModelConfig, type StubModel } from './fixtures/model';
import { chooseOption, closeSettings, openSettings, startRecordingModel, type RecordingModel } from './fixtures/settings';
import { sidebarOf } from './fixtures/sessions';

const T1 = 'Plan the database migration';
const T2 = 'Plan the cache rollout';
const T3 = 'Name this session for me';
const T4 = 'Audit the repository layout';
const SUB_PROMPT = 'List the top-level folders';
const SUB_DONE = 'The helper finished the audit.';
const RUN_DONE = 'All three checks passed.';

const recReply = (prompt: string): string => `Recorded: ${prompt}`;

async function writeAgentConfig(home: string, model: StubModel, rec: RecordingModel): Promise<void> {
  const base = stubModelConfig(model.baseUrl, 'yolo').replace('default_model = "e2e/stub"', 'default_model = "rec/thinker"');
  await writeFile(join(home, 'config.toml'), [
    base,
    '[providers.rec]', 'type = "openai"', `base_url = "${rec.baseUrl}"`, 'api_key = "sk-rec"', '',
    '[models."rec/thinker"]', 'provider = "rec"', 'model = "thinker-1"', 'max_context_size = 64000', 'display_name = "Thinker"',
    'capabilities = ["thinking", "tool_use"]', 'support_efforts = ["low", "high"]', 'default_effort = "high"', 'off_effort = "none"', '',
    '[models."rec/helper"]', 'provider = "rec"', 'model = "helper-1"', 'max_context_size = 32000', 'display_name = "Helper"', 'capabilities = ["tool_use"]', '',
  ].join('\n'));
}

async function newSession(app: DesktopApp): Promise<void> {
  await sidebarOf(app).getByRole('button', { name: /^New Session/ }).click();
  await expect.poll(() => app.window.url()).not.toMatch(/\/sessions\//);
}

test('agent defaults shape new sessions: thinking, title, subagent model and folding', async ({ app, model, scratch }) => {
  const rec = await startRecordingModel({ apiKey: 'sk-rec', models: [], reply: recReply, sideReply: 'unused' });
  const home = join(scratch, 'home');
  const transcript = (): Locator => app.window.getByRole('list').first();

  try {
    await test.step('Agent & Sessions shows the configured defaults', async () => {
      await writeAgentConfig(home, model, rec);
      await app.relaunch();
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      await expect(dialog.getByRole('combobox', { name: 'Default model' })).toHaveText('Thinker');
      const thinking = dialog.getByRole('tablist', { name: 'Thinking by default' });
      await expect(thinking.getByRole('tab')).toHaveText(['Off', 'Low', 'High']);
      await expect(thinking.getByRole('tab', { name: 'High' })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByRole('combobox', { name: 'Subagent model' })).toHaveText('Follow default model');
      const runningSend = dialog.getByRole('tablist', { name: 'Send while running' });
      await expect(runningSend.getByRole('tab')).toHaveText(['Steer', 'Queue']);
      await expect(runningSend.getByRole('tab', { name: 'Steer' })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByRole('switch', { name: 'Auto-fold messages' })).toHaveAttribute('aria-checked', 'false');
      await expect(dialog.getByRole('switch', { name: 'Tool call summary' })).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByRole('switch', { name: 'Auto-generate title' })).toHaveAttribute('aria-checked', 'true');
      await app.snapshot('agent-defaults');
    });

    await test.step('thinking off by default reaches the next session request', async () => {
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      const off = dialog.getByRole('tablist', { name: 'Thinking by default' }).getByRole('tab', { name: 'Off' });
      await off.click();
      await expect(off).toHaveAttribute('aria-selected', 'true');
      await closeSettings(app.window);
      await app.submit(T1);
      const request = await rec.waitForTurn(0);
      expect(request.model).toBe('thinker-1');
      expect(request.body['reasoning_effort']).toBe('none');
      await expect(transcript().getByText(recReply(T1), { exact: true })).toBeVisible();
      await app.snapshot('thinking-off-session');
    });

    await test.step('thinking High by default sends the high effort', async () => {
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      const high = dialog.getByRole('tablist', { name: 'Thinking by default' }).getByRole('tab', { name: 'High' });
      await high.click();
      await expect(high).toHaveAttribute('aria-selected', 'true');
      await closeSettings(app.window);
      await newSession(app);
      await app.submit(T2);
      const request = await rec.waitForTurn(1);
      expect(request.body['reasoning_effort']).toBe('high');
      await expect(transcript().getByText(recReply(T2), { exact: true })).toBeVisible();
    });

    await test.step('with auto titles off a new session keeps its prompt as title and asks for none', async () => {
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      const toggle = dialog.getByRole('switch', { name: 'Auto-generate title' });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await closeSettings(app.window);
      await newSession(app);
      const sideBefore = rec.sideRequests().length;
      await app.submit(T3);
      await rec.waitForTurn(2);
      await expect(transcript().getByText(recReply(T3), { exact: true })).toBeVisible();
      await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
      await expect(sidebarOf(app).getByText(T3)).toBeVisible();
      expect(rec.sideRequests()).toHaveLength(sideBefore);
      const back = await openSettings(app.window, 'Agent & Sessions');
      const restore = back.getByRole('switch', { name: 'Auto-generate title' });
      await restore.click();
      await expect(restore).toHaveAttribute('aria-checked', 'true');
      await closeSettings(app.window);
    });

    await test.step('the subagent model picker routes subagents to the chosen model', async () => {
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      const picker = dialog.getByRole('combobox', { name: 'Subagent model' });
      await picker.click();
      const menu = app.window.getByRole('dialog', { name: 'Subagent model' });
      await menu.getByRole('option', { name: 'Helper' }).click();
      await menu.getByRole('listbox', { name: 'Thinking effort' }).getByRole('option', { name: 'Model default' }).click();
      await expect(menu).toBeHidden();
      await expect(picker).toHaveText(/Helper/);
      const defaultModel = dialog.getByRole('combobox', { name: 'Default model' });
      await chooseOption(app.window, defaultModel, 'stub');
      await expect(defaultModel).toHaveText('stub');
      await app.snapshot('subagent-model-helper');
      await closeSettings(app.window);

      await newSession(app);
      model.script(agent(SUB_PROMPT), say(SUB_DONE));
      const before = rec.turns().length;
      await app.startTurn(T4);
      const sub = await rec.waitForTurn(before);
      expect(sub.model).toBe('helper-1');
      expect(sub.lastUserText).toContain(SUB_PROMPT);
      await expect(transcript().getByText(SUB_DONE, { exact: true })).toBeVisible();
      await expect(transcript().getByRole('button', { name: 'Open' }).filter({ hasText: 'helper task' })).toContainText('coder · Helper');
      expect(model.requests()).toHaveLength(2);
      await app.snapshot('subagent-on-helper');
    });

    await test.step('tool call summary folds a multi-tool turn into one row, and can be turned off', async () => {
      model.script(
        batch(
          call('Write', { path: 'alpha.txt', content: 'alpha\n' }),
          call('Write', { path: 'beta.txt', content: 'beta\n' }),
          call('Write', { path: 'gamma.txt', content: 'gamma\n' }),
        ),
        say(RUN_DONE),
      );
      await app.startTurn('Run the three checks');
      await expect(transcript().getByText(RUN_DONE, { exact: true })).toBeVisible();
      const turn = transcript().getByRole('listitem').filter({ hasText: RUN_DONE }).first();
      const summary = turn.locator('button.ar-head');
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await app.snapshot('tool-calls-summarised');

      const dialog = await openSettings(app.window, 'Agent & Sessions');
      await dialog.getByRole('switch', { name: 'Tool call summary' }).click();
      await closeSettings(app.window);
      await expect(summary).toHaveCount(0);
      for (const path of ['alpha.txt', 'beta.txt', 'gamma.txt']) await expect(turn.getByText(path).first()).toBeVisible();
      await app.snapshot('tool-calls-unfolded');
    });

    await test.step('auto-fold collapses the finished turn behind a work row', async () => {
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      await dialog.getByRole('switch', { name: 'Auto-fold messages' }).click();
      await closeSettings(app.window);
      const turn = transcript().getByRole('listitem').filter({ hasText: RUN_DONE }).first();
      const fold = turn.getByRole('button', { name: /^(Worked |Work details)/ });
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await expect(turn.getByText(RUN_DONE, { exact: true })).toBeVisible();
      await app.snapshot('turn-auto-folded');
      await fold.click();
      await expect(fold).toHaveAttribute('aria-expanded', 'true');
      await expect(turn.getByText('gamma.txt').first()).toBeVisible();
    });

    await test.step('every choice survives a relaunch', async () => {
      await app.relaunch();
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      await expect(dialog.getByRole('combobox', { name: 'Default model' })).toHaveText('stub');
      await expect(dialog.getByRole('combobox', { name: 'Subagent model' })).toHaveText(/Helper/);
      await expect(dialog.getByRole('switch', { name: 'Auto-fold messages' })).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByRole('switch', { name: 'Tool call summary' })).toHaveAttribute('aria-checked', 'false');
      await expect(dialog.getByRole('switch', { name: 'Auto-generate title' })).toHaveAttribute('aria-checked', 'true');
      await app.snapshot('relaunched-agent-defaults');
      await chooseOption(app.window, dialog.getByRole('combobox', { name: 'Default model' }), 'Thinker');
      await expect(dialog.getByRole('tablist', { name: 'Thinking by default' }).getByRole('tab', { name: 'High' })).toHaveAttribute('aria-selected', 'true');
    });
  } finally {
    await rec.close();
  }
});

test('auto-generated titles are requested after the first turn', async ({ app, model }) => {
  const titles: Request[] = [];
  app.window.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/title/generate')) titles.push(request);
  });
  model.script(say('First answer.'));
  await app.startTurn('Write the onboarding guide');
  await expect(app.window.getByRole('list').first().getByText('First answer.', { exact: true })).toBeVisible();
  await expect.poll(() => titles.length).toBe(1);
});
