import { expect, test } from './fixtures/app';
import { held, say } from './fixtures/model';
import { sidebarOf } from './fixtures/sessions';

const OPENER = 'Kick off the release work';
const BUILT_INS = ['new', 'clear', 'plan', 'goal', 'compact', 'undo', 'fork', 'export', 'status'];

test('slash commands and the Add menu drive status, plan mode, goals and a fresh session', async ({ app, model }) => {
  const goalTurn = model.hold('composer-goal-turn');

  model.script(say('Release work started.'), say('Plan drafted.'), held('composer-goal-turn', say(['Working toward ', 'the release candidate.']), 1));
  const window = app.window;
  const input = window.getByRole('combobox', { name: 'Message input' });
  const lines = input.getByRole('paragraph');
  const transcript = window.getByRole('list').first();
  const slashMenu = window.getByRole('listbox');
  const exitMode = window.getByRole('button', { name: 'Exit mode' });
  const planIndicator = window.getByRole('button', { name: 'Plan', exact: true });

  await test.step('an opening turn creates the session', async () => {
    await app.startTurn(OPENER);
    await expect(transcript.getByText('Release work started.', { exact: true })).toBeVisible();
  });
  const firstSession = await app.sessionId();

  await test.step('/ lists the built-in commands, typing filters them and Escape closes the menu', async () => {
    await input.click();
    await window.keyboard.type('/');
    for (const command of BUILT_INS) await expect(slashMenu.getByRole('option', { name: new RegExp(`^${command} `) })).toBeVisible();
    await expect(slashMenu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await app.snapshot('slash-menu');
    await window.keyboard.type('st');
    await expect(slashMenu.getByRole('option', { name: /^status / })).toBeVisible();
    await expect(slashMenu.getByRole('option', { name: /^plan / })).toBeHidden();
    await expect(slashMenu.getByRole('option', { name: /^new / })).toBeHidden();
    await app.snapshot('slash-filtered');
    await window.keyboard.press('Escape');
    await expect(slashMenu).toBeHidden();
    await expect(lines).toHaveText(['/st']);
    await window.keyboard.press('ControlOrMeta+a');
    await window.keyboard.press('Backspace');
    await expect(lines).toHaveText(['']);
  });

  await test.step('/status opens the session status with the model and permission', async () => {
    await window.keyboard.type('/status');
    await window.keyboard.press('Enter');
    const status = window.getByRole('dialog', { name: 'Session status' });
    await expect(status).toBeVisible();
    await expect(status.getByRole('definition').nth(0)).toHaveText('stub');
    await expect(status.getByRole('term').filter({ hasText: 'Permission' })).toBeVisible();
    await expect(status.getByText('Always Ask', { exact: true })).toBeVisible();
    await expect(status.getByRole('term').nth(3)).toHaveText('Plan mode');
    await expect(status.getByRole('definition').nth(3)).toHaveText('off');
    await expect(status.getByRole('term').filter({ hasText: 'Session ID' })).toBeVisible();
    await expect(status.getByText(firstSession, { exact: true })).toBeVisible();
    await app.snapshot('status-panel');
    await status.getByRole('button', { name: 'Close' }).click();
    await expect(status).toBeHidden();
    await expect(lines).toHaveText(['']);
    expect(model.requests()).toHaveLength(1);
  });

  await test.step('/plan arms plan mode and the next prompt runs with the plan-mode reminder', async () => {
    await input.click();
    await window.keyboard.type('/plan');
    await window.keyboard.press('Enter');
    await expect(window.getByText('Plan', { exact: true })).toBeVisible();
    await expect(exitMode).toBeVisible();
    await app.snapshot('plan-armed');
    const request = await app.startTurn('Draft the rollout plan');
    expect(request.userTextsSinceReply).toEqual(['Draft the rollout plan']);
    expect(request.remindersSinceReply.some(reminder => reminder.startsWith('Plan mode is active:'))).toBe(true);
    expect(model.request(0).remindersSinceReply.some(reminder => reminder.startsWith('Plan mode is active:'))).toBe(false);
    await expect(transcript.getByText('Plan drafted.', { exact: true })).toBeVisible();
    await expect(exitMode).toBeHidden();
    await expect(planIndicator).toBeVisible();
    await expect(input).toHaveAttribute('aria-placeholder', 'What should the agent plan for?');
    await app.snapshot('plan-active');
  });

  await test.step('/status reports plan mode on', async () => {
    await input.click();
    await window.keyboard.type('/status');
    await window.keyboard.press('Enter');
    const status = window.getByRole('dialog', { name: 'Session status' });
    await expect(status.getByRole('definition').nth(3)).toHaveText('on');
    await status.getByRole('button', { name: 'Close' }).click();
    await expect(status).toBeHidden();
  });

  await test.step('the Plan pill opens the plan panel whose Exit mode turns plan mode off', async () => {
    await planIndicator.click();
    await expect(window.getByText('Plan mode is on — the plan the agent writes will show up here.')).toBeVisible();
    await app.snapshot('plan-panel');
    await exitMode.click();
    await expect(planIndicator).toBeHidden();
    await expect(input).toHaveAttribute('aria-placeholder', 'Type @ to reference files, or start with / for commands and skills');
  });

  await test.step('the Add menu lists its entries and its Plan item toggles plan mode', async () => {
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    const menu = window.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /^Files / })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Screenshot / })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Goal / })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Plan / })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Swarm / })).toBeVisible();
    await app.snapshot('add-menu');
    await menu.getByRole('menuitem', { name: /^Plan / }).click();
    await expect(menu).toBeHidden();
    await expect(exitMode).toBeVisible();
    await exitMode.click();
    await expect(exitMode).toBeHidden();
  });

  await test.step('Add → Goal starts a goal from the next prompt and the goal panel cancels it', async () => {
    await window.getByRole('button', { name: 'Add', exact: true }).click();
    await window.getByRole('menu').getByRole('menuitem', { name: /^Goal / }).click();
    await expect(window.getByRole('menu')).toBeHidden();
    await expect(input).toHaveAttribute('aria-placeholder', /.+/);
    await expect(window.getByText('Goal', { exact: true })).toBeVisible();
    await expect(exitMode).toBeVisible();
    const goal = await app.startTurn('Ship the release candidate');
    expect(goal.userTextsSinceReply).toEqual(['Ship the release candidate']);
    expect(goal.remindersSinceReply.some(reminder => reminder.includes('<untrusted_objective>\nShip the release candidate\n</untrusted_objective>'))).toBe(true);
    await goalTurn.reached();
    const goalButton = window.getByRole('button', { name: 'Goal Active' });
    await expect(goalButton).toBeVisible();
    await goalButton.click();
    await expect(window.getByRole('paragraph').filter({ hasText: 'Ship the release candidate' })).toBeVisible();
    await app.snapshot('goal-panel');
    await window.getByRole('button', { name: 'Cancel', exact: true }).click();
    const confirm = window.getByRole('dialog', { name: 'Cancel' });
    await expect(confirm.getByText('Cancel this goal? It cannot be resumed afterwards.')).toBeVisible();
    await app.snapshot('goal-cancel-confirm');
    await confirm.getByRole('button', { name: 'Yes' }).click();
    await expect(confirm).toBeHidden();
    await expect(goalButton).toBeHidden();
    await expect(transcript.getByRole('status').filter({ hasText: 'Manually stopped' })).toBeVisible();
    await expect(transcript.getByText('Working toward', { exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect.poll(() => model.aborts()).toBe(1);
    expect(model.requests()).toHaveLength(3);
    await app.snapshot('goal-cancelled');
  });

  await test.step('/clear starts a fresh session and keeps the old one', async () => {
    await input.click();
    await window.keyboard.type('/clear');
    await window.keyboard.press('Enter');
    await expect.poll(() => window.url()).not.toContain(firstSession);
    await expect(lines).toHaveText(['']);
    await expect(sidebarOf(app).getByText(OPENER)).toBeVisible();
    await expect(transcript.getByText('Release work started.', { exact: true })).toBeHidden();
    model.script(say('Fresh session ready.'));
    const fresh = await app.startTurn('Start over with a clean slate');
    expect(fresh.texts('user').map(text => text.includes(OPENER))).not.toContain(true);
    expect(fresh.userTextsSinceReply).toEqual(['Start over with a clean slate']);
    await expect(window.getByRole('list').first().getByText('Fresh session ready.', { exact: true })).toBeVisible();
    const secondSession = await app.sessionId();
    expect(secondSession).not.toBe(firstSession);
    await input.click();
    await window.keyboard.type('/status');
    await window.keyboard.press('Enter');
    const status = window.getByRole('dialog', { name: 'Session status' });
    await expect(status.getByText(secondSession, { exact: true })).toBeVisible();
    await expect(status.getByText(firstSession, { exact: true })).toBeHidden();
    await status.getByRole('button', { name: 'Close' }).click();
    await expect(sidebarOf(app).getByText('Start over with a clean slate')).toBeVisible();
    await expect(sidebarOf(app).getByText(OPENER)).toBeVisible();
    await app.snapshot('cleared-new-session');
  });
});
