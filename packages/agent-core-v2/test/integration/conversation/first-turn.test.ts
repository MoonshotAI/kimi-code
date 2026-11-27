import { expect, it } from 'vitest';

import { createTestAgent } from '../../harness';

it('finishes a first turn and carries the exchange into the next model request', async ({ onTestFinished }) => {
  const agent = createTestAgent();
  onTestFinished(() => agent.dispose());
  agent.mockNextResponse({ type: 'text', text: 'Hello from the agent.' });
  agent.mockNextResponse({ type: 'text', text: 'I remember.' });

  for (const question of ['Hello', 'Do you remember?']) {
    await agent.rpc.prompt({ input: [{ type: 'text', text: question }] });
    expect(await agent.untilTurnEnd()).toContainEqual(expect.objectContaining({
      event: 'turn.ended',
      args: expect.objectContaining({ reason: 'completed' }),
    }));
  }
  expect(agent.llmCalls).toHaveLength(2);
  expect(agent.llmCalls[1]?.history).toMatchObject([
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello from the agent.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Do you remember?' }] },
  ]);
});
