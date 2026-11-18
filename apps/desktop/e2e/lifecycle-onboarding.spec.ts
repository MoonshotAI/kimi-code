import { expect, test, type DesktopApp } from './fixtures/app';
import { say } from './fixtures/model';
import { createProject } from './fixtures/project';
import { sidebarOf } from './fixtures/sessions';

const PROMPT = 'Introduce yourself';
const REPLY = 'Hello, I am ready to help with this workspace.';

test.use({ seedWorkspace: false, onboarded: false });

function wizard(app: DesktopApp) {
  return app.window.getByRole('dialog', { name: 'Welcome to Kimi Code' });
}

test('a fresh profile goes through onboarding once and an onboarded profile never sees it again', async ({ app, model }) => {
  await test.step('a fresh profile opens on the welcome step', async () => {
    await expect(wizard(app)).toBeVisible();
    await expect(wizard(app).getByRole('heading', { name: 'Welcome to Kimi Code' })).toBeVisible();
    await expect(wizard(app).getByText('Language', { exact: true })).toBeVisible();
    await expect(wizard(app).getByText('Appearance', { exact: true })).toBeVisible();
    await app.snapshot('onboarding-welcome');
  });

  await test.step('Continue moves to the model step', async () => {
    await wizard(app).getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(wizard(app).getByRole('heading', { name: 'Configure Model' })).toBeVisible();
    await expect(wizard(app).getByText('Add a custom provider', { exact: true })).toBeVisible();
    await expect(wizard(app).getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await app.snapshot('onboarding-model-step');
  });

  await test.step('Skip for now lands in the main UI', async () => {
    await wizard(app).getByRole('button', { name: 'Skip for now', exact: true }).click();
    await expect(wizard(app)).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
    await app.snapshot('onboarding-skipped-main-ui');
  });

  await test.step('the main UI works: a workspace is added and a turn completes', async () => {
    await createProject(app);
    await expect(sidebarOf(app).getByText('workspace', { exact: true })).toBeVisible();
    await app.trustWorkspace();
    model.script(say(REPLY));
    await app.startTurn(PROMPT);
    await expect(app.window.getByRole('list').first().getByText(REPLY, { exact: true })).toBeVisible();
  });

  await test.step('after a relaunch the wizard stays closed', async () => {
    await app.relaunch();
    const sidebar = sidebarOf(app);
    await expect(sidebar.getByText(PROMPT, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible();
    await expect(wizard(app)).toBeHidden();
    await expect(app.window.getByRole('status', { name: 'Connecting…' })).toHaveCount(0);
    await app.snapshot('relaunched-without-onboarding');
  });

  await test.step('a renderer reload keeps the session and the wizard closed', async () => {
    const url = app.window.url();
    await app.window.reload();
    await expect(app.window.getByRole('combobox', { name: 'Message input' })).toBeVisible({ timeout: 30_000 });
    await expect(sidebarOf(app).getByText(PROMPT, { exact: true })).toBeVisible();
    await expect(wizard(app)).toBeHidden();
    expect(app.window.url()).toBe(url);
    expect(model.agentRequests()).toBe(1);
  });
});
