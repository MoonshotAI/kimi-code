import { call, httpError, say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';

import { permissionModeServices, testkitAgentFixtures, type TestkitAgentFixtures } from '../../harness';

const test = base.extend<TestkitAgentFixtures>(testkitAgentFixtures(permissionModeServices('auto'), {
  initialConfig: { experimental: { auto_review: true } },
}));

test('reviews an ask-mode Bash call using the loop-bound model when defaultBinding is unset', async ({ agent, model }) => {
  expect(agent.get(IAgentProfileService).getModel()).toBe('');
  model.lane('side').script(say('{"risk":"low","decision":"allow","reason":null}'));
  model.script(call('Bash', { command: 'gh pr view 4655' }), say('done'));

  await agent.rpc.prompt({ input: [{ type: 'text', text: 'review pr 4655' }] });
  const events = await agent.untilTurnEnd();
  const raw = JSON.stringify(events);
  expect(events).toContainEqual(expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) }));
  expect(raw).not.toContain('permitting hook failed');
  expect(raw).not.toContain('Model not set');
});

test('tells the main model to inform the user when Auto Review fails in Never Ask mode', async ({ agent, model }) => {
  model.lane('side').script(httpError(403, { message: 'Reviewer quota exceeded' }));
  model.script(
    call('Bash', { command: 'gh pr view 4655' }),
    say('Auto Review failed: Reviewer quota exceeded'),
  );

  await agent.rpc.prompt({ input: [{ type: 'text', text: 'review pr 4655' }] });
  await agent.untilTurnEnd();

  const followUp = model.lane('main').requests()[1];
  expect(JSON.stringify(followUp?.view.messages)).toContain(
    'inform the user in your response that Auto Review failed and include this reason',
  );
  expect(JSON.stringify(followUp?.view.messages)).toContain('Reviewer quota exceeded');
});

test('shows failure detail in the approval prompt and reports it to the main model on rejection in Ask When Needed mode', async ({ agent, model }) => {
  agent.get(IAgentPermissionModeService).setMode('yolo');
  model.lane('side').script(httpError(403, { message: 'Reviewer quota exceeded' }));
  model.script(
    call('Bash', { command: 'gh pr view 4655' }),
    say('Stopped after rejection'),
  );

  await agent.rpc.prompt({ input: [{ type: 'text', text: 'review pr 4655' }] });
  const approval = await agent.takeApprovalRequest();
  expect(JSON.stringify(approval.events)).toContain('"outcome":"failed"');
  expect(JSON.stringify(approval.events)).toContain('Reviewer quota exceeded');
  approval.respond({ decision: 'rejected', feedback: 'Try again later.' });
  await agent.untilTurnEnd();

  const followUp = model.lane('main').requests()[1];
  const serialized = JSON.stringify(followUp?.view.messages);
  expect(serialized).toContain(
    'Tool \\"Bash\\" was not run because the user rejected the approval request (Auto Review failed:',
  );
  expect(serialized).toContain('Reviewer quota exceeded');
  expect(serialized).toContain('Reason: Try again later.');
});
