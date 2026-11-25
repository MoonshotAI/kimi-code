import { call, say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

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
