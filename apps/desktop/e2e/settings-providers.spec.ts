import type { Locator } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { say } from './fixtures/model';
import { chooseOption, closeSettings, openSettings, startRecordingModel, type RecordingModel } from './fixtures/settings';
import { sidebarOf } from './fixtures/sessions';

const P1 = 'Summarise the open pull requests';
const P2 = 'Which one is the oldest?';
const P3 = 'And after the rename?';
const P4 = 'Is anyone still listening?';
const MAIN_REPLY = 'The stub model picked this up.';

const replyFrom = (prompt: string): string => `Alt server answered: ${prompt}`;

test('a custom provider is added, made default, survives a relaunch, renamed and deleted', async ({ app, model }) => {
  const alt: RecordingModel = await startRecordingModel({ apiKey: 'sk-alt-key', models: ['alt-model-7', 'alt-model-8'], reply: replyFrom, sideReply: 'unused' });
  const providerRow = (dialog: Locator, name: string): Locator => dialog.getByRole('button', { name: new RegExp(`^${name} openai \\d+ models$`) });
  const transcript = (): Locator => app.window.getByRole('list').first();

  try {
    await test.step('the providers tab lists the seeded provider and the custom form validates', async () => {
      const dialog = await openSettings(app.window, 'Model Providers');
      await expect(providerRow(dialog, 'e2e')).toHaveAccessibleName('e2e openai 1 models');
      await expect(dialog.getByText('Kimi Subscription', { exact: true }).first()).toBeVisible();
      await dialog.getByRole('button', { name: 'Add provider' }).click();
      await dialog.getByRole('button', { name: 'Custom', exact: true }).click();
      const form = dialog.locator('.pf:visible');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form.getByText('Name cannot be empty')).toBeVisible();
      await form.getByPlaceholder('my-openai').fill('alt-lab');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form.getByText('API Key cannot be empty')).toBeVisible();
      await app.snapshot('custom-form-validation');
    });

    await test.step('a custom OpenAI-compatible provider is saved with two models', async () => {
      const dialog = await openSettings(app.window);
      const form = dialog.locator('.pf:visible');
      await form.getByPlaceholder('sk-…').fill('sk-alt-key');
      await form.getByPlaceholder('https://api.example.com/v1').fill(alt.baseUrl);
      await form.getByPlaceholder('kimi-k3').fill('alt-model-7');
      await form.getByPlaceholder('1048576').fill('64000');
      await form.getByPlaceholder('Optional').fill('Alt Seven');
      await form.getByRole('button', { name: 'Add model' }).click();
      await form.getByPlaceholder('kimi-k3').nth(1).fill('alt-model-8');
      await form.getByPlaceholder('1048576').nth(1).fill('32000');
      await expect(form.getByText('2 models')).toBeVisible();
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(app.window.getByText('Provider added')).toBeVisible();
      await expect(providerRow(dialog, 'alt-lab')).toHaveAccessibleName('alt-lab openai 2 models');
      await app.snapshot('provider-added');
    });

    await test.step('reopening the provider shows its stored key, URL and model table', async () => {
      const dialog = await openSettings(app.window);
      await providerRow(dialog, 'alt-lab').click();
      const form = dialog.locator('.pf:visible');
      await expect(form.getByPlaceholder('my-openai')).toHaveValue('alt-lab');
      await expect(form.getByPlaceholder('Set — enter a new key to replace')).toHaveValue('sk-alt-key');
      await expect(form.getByPlaceholder('https://api.example.com/v1')).toHaveValue(alt.baseUrl);
      await expect(form.getByPlaceholder('kimi-k3').nth(0)).toHaveValue('alt-model-7');
      await expect(form.getByPlaceholder('kimi-k3').nth(1)).toHaveValue('alt-model-8');
      await expect(form.getByPlaceholder('1048576').nth(0)).toHaveValue('64000');
      await expect(form.getByPlaceholder('1048576').nth(1)).toHaveValue('32000');
      await expect(form.getByPlaceholder('Optional').nth(0)).toHaveValue('Alt Seven');
      await expect(form.getByRole('button', { name: 'Delete provider' })).toBeVisible();
      await app.snapshot('provider-edit-form');
      await form.getByRole('button', { name: 'Cancel' }).click();
      await expect(providerRow(dialog, 'alt-lab')).toBeVisible();
    });

    await test.step('as the default model it serves new sessions from the second server', async () => {
      const dialog = await openSettings(app.window, 'Agent & Sessions');
      const defaultModel = dialog.getByRole('combobox', { name: 'Default model' });
      await expect(defaultModel).toHaveText('stub');
      await chooseOption(app.window, defaultModel, 'Alt Seven');
      await expect(defaultModel).toHaveText('Alt Seven');
      await closeSettings(app.window);
      await expect(app.window.getByRole('button', { name: /^Alt Seven/ })).toBeVisible();

      await app.submit(P1);
      const request = await alt.waitForTurn(0);
      expect(request.model).toBe('alt-model-7');
      expect(request.authorization).toBe('Bearer sk-alt-key');
      expect(request.lastUserText).toBe(P1);
      await expect(transcript().getByText(replyFrom(P1), { exact: true })).toBeVisible();
      expect(model.requests()).toHaveLength(0);
      await app.snapshot('session-on-alt-server');
    });

    await test.step('the provider, its key and the default survive a relaunch', async () => {
      await app.relaunch();
      await sidebarOf(app).getByText(P1).click();
      await expect(transcript().getByText(replyFrom(P1), { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(app.window.getByRole('button', { name: /^Alt Seven/ })).toBeVisible();
      await app.submit(P2);
      const request = await alt.waitForTurn(1);
      expect(request.model).toBe('alt-model-7');
      expect(request.authorization).toBe('Bearer sk-alt-key');
      expect(request.lastUserText).toBe(P2);
      await expect(transcript().getByText(replyFrom(P2), { exact: true })).toBeVisible();
      const dialog = await openSettings(app.window, 'Model Providers');
      await expect(providerRow(dialog, 'alt-lab')).toHaveAccessibleName('alt-lab openai 2 models');
      await app.snapshot('relaunched-provider-list');
    });

    await test.step('renaming the provider rewires the default model to the new name', async () => {
      const dialog = await openSettings(app.window, 'Model Providers');
      await providerRow(dialog, 'alt-lab').click();
      const form = dialog.locator('.pf:visible');
      await form.getByPlaceholder('my-openai').fill('alt-renamed');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(app.window.getByText('Provider saved')).toBeVisible();
      await expect(providerRow(dialog, 'alt-renamed')).toHaveAccessibleName('alt-renamed openai 2 models');
      await expect(providerRow(dialog, 'alt-lab')).toHaveCount(0);
      await app.snapshot('provider-renamed');
      const agentTab = await openSettings(app.window, 'Agent & Sessions');
      await expect(agentTab.getByRole('combobox', { name: 'Default model' })).toHaveText('Alt Seven');
      await closeSettings(app.window);

      await app.submit(P3);
      const request = await alt.waitForTurn(2);
      expect(request.model).toBe('alt-model-7');
      expect(request.lastUserText).toBe(P3);
      expect(request.authorization).toBe('Bearer sk-alt-key');
      await expect(transcript().getByText(replyFrom(P3), { exact: true })).toBeVisible();
    });

    await test.step('deleting the provider needs a confirmation and removes it everywhere', async () => {
      const dialog = await openSettings(app.window, 'Model Providers');
      await providerRow(dialog, 'alt-renamed').click();
      const form = dialog.locator('.pf:visible');
      await form.getByRole('button', { name: 'Delete provider' }).click();
      await expect(form.getByText('Delete alt-renamed and its 2 models?')).toBeVisible();
      await form.getByRole('button', { name: 'Cancel' }).click();
      await expect(form.getByText('Delete alt-renamed and its 2 models?')).toBeHidden();
      await form.getByRole('button', { name: 'Cancel' }).click();
      await expect(providerRow(dialog, 'alt-renamed')).toHaveAccessibleName('alt-renamed openai 2 models');
      await providerRow(dialog, 'alt-renamed').click();
      await form.getByRole('button', { name: 'Delete provider' }).click();
      await app.snapshot('delete-confirm');
      await form.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(providerRow(dialog, 'alt-renamed')).toHaveCount(0);
      await expect(providerRow(dialog, 'e2e')).toBeVisible();
      await app.snapshot('provider-deleted');
      await closeSettings(app.window);
    });

    await test.step('the session that used it asks for a model instead of calling a dead provider', async () => {
      const turnsBefore = alt.turns().length;
      await app.submit(P4);
      const ask = app.window.getByRole('dialog', { name: 'Choose a model' });
      await expect(ask).toBeVisible();
      await expect(ask.getByText('Models are available. Pick a default model to start chatting.')).toBeVisible();
      await expect(app.window.getByRole('button', { name: 'Choose', exact: true }).first()).toBeVisible();
      expect(alt.turns()).toHaveLength(turnsBefore);
      expect(model.requests()).toHaveLength(0);
      await app.snapshot('pick-model-prompt');
      await ask.getByRole('button', { name: 'Choose', exact: true }).click();
      const picker = app.window.getByRole('dialog', { name: 'Switch model' });
      await expect(picker).toBeVisible();
      await picker.getByText('stub', { exact: true }).click();
      await expect(picker).toBeHidden();
      model.script(say(MAIN_REPLY));
      const resend = model.requests().length;
      await app.window.getByRole('combobox', { name: 'Message input' }).click();
      await app.window.keyboard.press('Enter');
      const request = await model.waitForRequest(resend);
      expect(request.userTextsSinceReply).toContain(P4);
      await expect(transcript().getByText(MAIN_REPLY, { exact: true })).toBeVisible();
      expect(alt.turns()).toHaveLength(turnsBefore);
      await app.snapshot('fallback-to-stub');
    });

    await test.step('the deleted provider and its models stay gone after a relaunch', async () => {
      await app.relaunch();
      const dialog = await openSettings(app.window, 'Model Providers');
      await expect(providerRow(dialog, 'e2e')).toBeVisible();
      await expect(providerRow(dialog, 'alt-renamed')).toHaveCount(0);
      const agentTab = await openSettings(app.window, 'Agent & Sessions');
      await agentTab.getByRole('combobox', { name: 'Default model' }).click();
      await expect(app.window.getByRole('listbox').getByRole('option', { name: 'stub', exact: true })).toBeVisible();
      await expect(app.window.getByRole('listbox').getByRole('option', { name: /Alt Seven|alt-model-8/ })).toHaveCount(0);
      await app.window.keyboard.press('Escape');
      await app.snapshot('relaunched-after-delete');
    });
  } finally {
    await alt.close();
  }
});
