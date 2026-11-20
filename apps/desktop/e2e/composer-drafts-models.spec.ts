import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { providerApiKey, writeModelConfig } from './fixtures/composer';
import { say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const ALPHA = 'Alpha: audit the parser';
const BETA = 'Beta: tidy the docs';
const ALPHA_DRAFT = 'alpha draft that must survive';
const BETA_DRAFT = 'beta draft, also unsent';

test('per-session drafts survive switching and a relaunch, and model, favourite and thinking choices reach the request', async ({ app, model, scratch }) => {
  model.script(say('Alpha ready.'), say('Beta ready.'));
  const sidebar = () => sidebarOf(app);
  const input = () => app.window.getByRole('combobox', { name: 'Message input' });
  const lines = () => input().getByRole('paragraph');
  const openSession = async (title: string, sessionId: string): Promise<void> => {
    await sidebar().getByText(title, { exact: true }).click();
    await expect.poll(() => app.window.url()).toContain(sessionId);
  };
  const openModelMenu = async (pillName: string | RegExp) => {
    await app.window.getByRole('button', typeof pillName === 'string' ? { name: pillName, exact: true } : { name: pillName }).click();
    const overlay = await app.overlay();
    const menu = overlay.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  };
  const sendDraft = async (expected: string) => {
    const next = model.requests().length;
    await input().click();
    await app.window.keyboard.press('Enter');
    const request = await model.waitForRequest(next);
    expect(request.userTextsSinceReply).toEqual([expected]);
    return request;
  };

  await test.step('the stub providers offer several models after a relaunch', async () => {
    await writeModelConfig(join(scratch, 'home'), model.baseUrl, [
      { id: 'e2e/swift', model: 'swift', displayName: 'Swift Stub' },
      { id: 'e2e/think', model: 'think', displayName: 'Thinking Stub', capabilities: ['thinking'], efforts: ['low', 'high'], defaultEffort: 'low', offEffort: 'none' },
      { id: 'e2e-alt/remote', provider: 'e2e-alt', model: 'remote', displayName: 'Remote Stub' },
    ]);
    await app.relaunch();
    await expect(app.window.getByRole('button', { name: 'stub', exact: true })).toBeVisible();
  });

  let alpha = '';
  let beta = '';
  await test.step('two sessions are created', async () => {
    const first = await app.startTurn(ALPHA);
    expect(first.body['model']).toBe('stub');
    expect(first.path).toBe('/v1/chat/completions');
    expect(first.authorization).toBe(`Bearer ${providerApiKey('e2e')}`);
    await expect(app.window.getByText('Alpha ready.', { exact: true })).toBeVisible();
    alpha = await app.sessionId();
    await sidebar().getByRole('button', { name: /^New Session/ }).click();
    await expect.poll(() => app.window.url()).not.toContain(alpha);
    await app.startTurn(BETA);
    await expect(app.window.getByText('Beta ready.', { exact: true })).toBeVisible();
    beta = await app.sessionId();
    expect(beta).not.toBe(alpha);
  });

  await test.step('each session keeps its own draft while switching back and forth', async () => {
    await input().click();
    await app.window.keyboard.type(BETA_DRAFT);
    await openSession(ALPHA, alpha);
    await expect(app.window.getByText('Alpha ready.', { exact: true })).toBeVisible();
    await expect(lines()).toHaveText(['']);
    await input().click();
    await app.window.keyboard.type(ALPHA_DRAFT);
    await openSession(BETA, beta);
    await expect(lines()).toHaveText([BETA_DRAFT]);
    await openSession(ALPHA, alpha);
    await expect(lines()).toHaveText([ALPHA_DRAFT]);
    await expect(app.window.getByText('Alpha ready.', { exact: true })).toBeVisible();
    await app.snapshot('alpha-draft');
    expect(model.requests()).toHaveLength(2);
  });

  await test.step('both drafts survive a relaunch', async () => {
    await app.relaunch();
    await openSession(BETA, beta);
    await expect(lines()).toHaveText([BETA_DRAFT]);
    await app.snapshot('beta-draft-after-relaunch');
    await openSession(ALPHA, alpha);
    await expect(lines()).toHaveText([ALPHA_DRAFT]);
  });

  await test.step('the quick model menu switches the session model and the draft is sent with it', async () => {
    const menu = await openModelMenu('stub');
    await expect(menu.getByRole('menuitemradio', { name: 'stub', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Swift Stub' })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Remote Stub' })).toBeHidden();
    await app.snapshot('model-quick-menu');
    await menu.getByRole('menuitemradio', { name: 'Swift Stub' }).click();
    await expect(app.window.getByRole('button', { name: 'Swift Stub' })).toBeVisible();
    model.script(say('Sent with swift.'));
    const request = await sendDraft(ALPHA_DRAFT);
    expect(request.body['model']).toBe('swift');
    await expect(app.window.getByText('Sent with swift.', { exact: true })).toBeVisible();
    await expect(lines()).toHaveText(['']);
  });

  await test.step('the model picker searches and stars a model from another provider', async () => {
    const menu = await openModelMenu('Swift Stub');
    await menu.getByRole('menuitem', { name: /More models/ }).click();
    const picker = app.window.getByRole('dialog', { name: 'Switch model' });
    await expect(picker).toBeVisible();
    await picker.getByRole('textbox', { name: 'Search models or providers…' }).fill('remote');
    const options = picker.getByRole('listbox', { name: 'Switch model' }).getByRole('option');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('Remote Stub');
    await options.first().hover();
    await options.first().getByRole('button', { name: 'Add to favorites' }).click();
    await expect(options.first().getByRole('button', { name: /Remove from favorites/ })).toBeVisible();
    await app.snapshot('picker-starred');
    await picker.getByRole('button', { name: 'Close' }).click();
    await expect(picker).toBeHidden();
    const reopened = await openModelMenu('Swift Stub');
    await expect(reopened.getByText('Starred', { exact: true })).toBeVisible();
    await expect(reopened.getByRole('menuitemradio', { name: /Remote Stub/ })).toBeVisible();
    await app.snapshot('starred-in-quick-menu');
    await reopened.page().keyboard.press('Escape');
    await expect(reopened).toBeHidden();
  });

  await test.step('the thinking effort chosen in the quick menu reaches the request', async () => {
    const menu = await openModelMenu('Swift Stub');
    await menu.getByRole('menuitemradio', { name: 'Thinking Stub' }).click();
    await expect(app.window.getByRole('button', { name: 'Thinking Stub · Low' })).toBeVisible();
    const thinking = await openModelMenu('Thinking Stub · Low');
    await expect(thinking.getByRole('tab', { name: 'Low' })).toHaveAttribute('aria-selected', 'true');
    await thinking.getByRole('tab', { name: 'High' }).click();
    await expect(app.window.getByRole('button', { name: 'Thinking Stub · High' })).toBeVisible();
    await expect(thinking.getByRole('tab', { name: 'High' })).toHaveAttribute('aria-selected', 'true');
    await app.snapshot('thinking-high');
    await thinking.page().keyboard.press('Escape');
    await expect(thinking).toBeHidden();
    model.script(say('Thought hard.'), say('Thought not at all.'));
    await input().click();
    await app.window.keyboard.type('Think hard about the parser');
    const high = await sendDraft('Think hard about the parser');
    expect(high.body['model']).toBe('think');
    expect(high.body['reasoning_effort']).toBe('high');
    await expect(app.window.getByText('Thought hard.', { exact: true })).toBeVisible();
    const off = await openModelMenu('Thinking Stub · High');
    await off.getByRole('tab', { name: 'Off' }).click();
    await expect(app.window.getByRole('button', { name: 'Thinking Stub', exact: true })).toBeVisible();
    await off.page().keyboard.press('Escape');
    await expect(off).toBeHidden();
    await input().click();
    await app.window.keyboard.type('Answer without thinking');
    const none = await sendDraft('Answer without thinking');
    expect(none.body['model']).toBe('think');
    expect(none.body['reasoning_effort']).toBe('none');
    await expect(app.window.getByText('Thought not at all.', { exact: true })).toBeVisible();
  });

  await test.step('the starred model from the other provider is picked from the quick menu', async () => {
    const menu = await openModelMenu(/^Thinking Stub/);
    await menu.getByRole('menuitemradio', { name: /Remote Stub/ }).click();
    await expect(app.window.getByRole('button', { name: 'Remote Stub' })).toBeVisible();
    model.script(say('Remote answered.'));
    await input().click();
    await app.window.keyboard.type('Ask the remote model');
    const remote = await sendDraft('Ask the remote model');
    expect(remote.body['model']).toBe('remote');
    expect(remote.path).toBe('/e2e-alt/v1/chat/completions');
    expect(remote.authorization).toBe(`Bearer ${providerApiKey('e2e-alt')}`);
    await expect(app.window.getByText('Remote answered.', { exact: true })).toBeVisible();
    await openSession(BETA, beta);
    await expect(lines()).toHaveText([BETA_DRAFT]);
    await expect(app.window.getByText('Beta ready.', { exact: true })).toBeVisible();
    await expect(app.window.getByRole('button', { name: 'stub', exact: true })).toBeVisible();
    await app.snapshot('beta-keeps-draft-and-model');
  });
});
