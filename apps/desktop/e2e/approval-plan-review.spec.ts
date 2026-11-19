import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from './fixtures/app';
import { bash, call, held, messageProblems, say, textOf, type ModelRequest } from './fixtures/model';

const PLAN_V1 = '# Plan v1\n\n- Add a greeting file\n';
const PLAN_V2 = '# Plan v2\n\n- Add a greeting file\n- Mention the release date\n';
const REVISE_FEEDBACK = 'Also mention the release date';
const PLAN_REJECTED = '# Risky plan\n\n- Delete the history\n';

const planFileIn = (request: ModelRequest): string => {
  const text = request.messages.map(message => textOf(message.content)).join('\n');
  const path = [...text.matchAll(/Plan file: (.+?[\\/]plans[\\/].+?\.md)/g)].at(-1)?.[1];
  if (path === undefined) throw new Error('The plan mode reminder did not name a plan file');
  return path;
};

const lastToolResult = (request: ModelRequest): string =>
  textOf(request.messages.filter(message => message.role === 'tool').at(-1)?.content);

test.use({ permissionMode: 'yolo' });

test('plan review: revise with feedback, approve the revised plan and execute, then reject and exit a second plan', async ({ app, model }) => {
  const transcript = app.window.getByRole('list').first();
  const composer = app.window.getByRole('combobox', { name: 'Message input' });
  const planReview = app.window.locator('.dock-approval').filter({ hasText: 'Ready to build with this plan?' });
  const planChip = app.window.getByRole('button', { name: 'Exit mode' });

  const armPlanMode = async (): Promise<void> => {
    await composer.click();
    await app.window.keyboard.type('/plan');
    await app.window.keyboard.press('Enter');
    await expect(planChip).toBeVisible();
  };

  await test.step('/plan arms plan mode in the composer', async () => {
    await armPlanMode();
    await expect(app.window.getByText('What should the agent plan for?')).toBeVisible();
    await app.snapshot('plan-mode-armed');
  });

  let planFile = '';
  await test.step('the model writes a plan into the plan file and asks for review', async () => {
    const research = model.hold('research');
    model.script(held('research', bash('pwd', { description: 'Look around' })));
    const first = await app.startTurn('Plan a greeting file');
    await research.reached();
    planFile = planFileIn(first);
    model.script(
      call('Write', { path: planFile, content: PLAN_V1 }),
      call('ExitPlanMode', {}),
    );
    research.release();
    await expect(planReview).toBeVisible();
    await expect(app.window.getByText('Plan v1').last()).toBeVisible();
    expect(await readFile(planFile, 'utf8')).toBe(PLAN_V1);
    await app.snapshot('plan-review-v1');
  });

  await test.step('Revise sends the feedback to the model and keeps plan mode on', async () => {
    model.script(
      call('Read', { path: planFile }),
      call('Write', { path: planFile, content: PLAN_V2 }),
      call('ExitPlanMode', {}),
    );
    const before = model.requests().length;
    await app.window.getByRole('button', { name: 'Revise', exact: true }).click();
    await app.window.getByPlaceholder('Explain why you are rejecting…').fill(REVISE_FEEDBACK);
    await app.snapshot('plan-revise-feedback');
    await app.window.getByRole('button', { name: 'Reject with feedback' }).click();

    const revised = await model.waitForRequest(before);
    expect(lastToolResult(revised)).toContain(REVISE_FEEDBACK);
    await expect(planReview).toBeVisible();
    await expect(planReview.getByText('Mention the release date')).toBeVisible();
    expect(await readFile(planFile, 'utf8')).toBe(PLAN_V2);
    await app.snapshot('plan-review-v2');
  });

  await test.step('Approve plan exits plan mode and the model executes the plan', async () => {
    model.script(
      bash('echo "hello, release day" > greeting.txt', { description: 'Write the greeting' }),
      say('Plan executed.'),
    );
    const before = model.requests().length;
    await app.window.getByRole('button', { name: 'Approve plan' }).click();
    await expect(transcript.getByText('Plan executed.', { exact: true })).toBeVisible();
    const approved = model.request(before);
    expect(lastToolResult(approved)).toContain('## Approved Plan:');
    expect(lastToolResult(approved)).toContain('Mention the release date');
    expect(await readFile(join(app.workspace, 'greeting.txt'), 'utf8')).toBe('hello, release day\n');
    expect(messageProblems(model.request(before + 1).messages)).toEqual([]);
    await expect(planChip).toBeHidden();
    await app.snapshot('plan-approved-and-executed');
  });

  await test.step('Reject and Exit on a second plan stops the turn and leaves plan mode', async () => {
    await armPlanMode();
    const research = model.hold('research-2');
    model.script(held('research-2', bash('pwd', { description: 'Look around' })));
    const second = await app.startTurn('Plan a cleanup');
    await research.reached();
    const secondPlanFile = planFileIn(second);
    model.script(
      call('Write', { path: secondPlanFile, content: PLAN_REJECTED }),
      call('ExitPlanMode', {}),
      say('This reply must never be requested.'),
    );
    research.release();
    await expect(planReview).toBeVisible();
    await expect(app.window.getByText('Delete the history').last()).toBeVisible();
    const before = model.requests().length;
    await app.window.getByRole('button', { name: 'Reject and Exit' }).click();

    await expect(planReview).toBeHidden();
    await expect(app.window.getByRole('button', { name: 'Interrupt', exact: true })).toBeHidden();
    await expect(planChip).toBeHidden();
    expect(model.requests()).toHaveLength(before);
    expect(existsSync(join(app.workspace, 'history'))).toBe(false);
    await app.snapshot('plan-rejected-and-exited');
  });
});
