import { held, say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { testkitAgentFixtures, type TestkitAgentFixtures } from '../../harness';

const test = base.extend<TestkitAgentFixtures>(testkitAgentFixtures());

const completed = expect.objectContaining({ event: 'turn.ended', args: expect.objectContaining({ reason: 'completed' }) });

test('drives the engine from the shared testkit script and reads the request the provider sent', async ({ agent, model }) => {
  model.script(say('Hello from the agent.'), say('I remember.'));
  for (const question of ['Hello', 'Do you remember?']) {
    await agent.rpc.prompt({ input: [{ type: 'text', text: question }] });
    expect(await agent.untilTurnEnd()).toContainEqual(completed);
  }
  const requests = model.requests('main');
  expect(requests).toHaveLength(2);
  expect(requests[1]!.view.messages.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Hello from the agent.' },
    { role: 'user', text: 'Do you remember?' },
  ]);
});

test('holds the provider stream at a named point until the test releases it', async ({ agent, model }) => {
  model.script(held('after-first-chunk', say(['Hel', 'lo']), 1), say('Still here.'));
  await agent.rpc.prompt({ input: [{ type: 'text', text: 'Hi' }] });
  await model.hold('after-first-chunk').reached();
  expect(model.requests('main')[0]!.state).toBe('held');
  model.hold('after-first-chunk').release();
  expect(await agent.untilTurnEnd()).toContainEqual(completed);
  await agent.rpc.prompt({ input: [{ type: 'text', text: 'Again' }] });
  expect(await agent.untilTurnEnd()).toContainEqual(completed);
  expect(model.requests('main')[1]!.texts('assistant')).toEqual(['Hello']);
});

test('refuses the built-in mock API on an agent driven by the testkit model', ({ agent }) => {
  const refused = /belongs to the built-in harness model, but this agent uses the testkit model/;
  expect(() => agent.mockNextResponse({ type: 'text', text: 'ignored' })).toThrow(refused);
  expect(() => agent.llmCalls).toThrow(refused);
  expect(() => agent.lastLlmInput()).toThrow(refused);
  expect(() => agent.llmInputs()).toThrow(refused);
});

base('fails an engine test that leaves a scripted reply unused', async (context) => {
  const fixtures = testkitAgentFixtures();
  const run = fixtures.model(context, async (model) => {
    await fixtures.agent({ model }, async () => {
      model.script(say('never requested'));
    });
  });
  await expect(run).rejects.toThrow(/lane "main" has 1 unused step\(s\)/);
});

base('fails an engine test that leaves a reached hold unreleased', async (context) => {
  const fixtures = testkitAgentFixtures();
  const run = fixtures.model(context, async (model) => {
    await fixtures.agent({ model }, async (agent) => {
      model.script(held('forgotten', say('late')));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
      await model.hold('forgotten').reached();
    });
  });
  await expect(run).rejects.toThrow(/hold "forgotten" was reached by request #0 but never released, failed, or cut/);
});
