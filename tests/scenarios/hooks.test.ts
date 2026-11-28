import { say } from '@moonshot-ai/testkit/model';
import { test as base, describe, expect } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const BLOCK_REASON = 'forbidden by policy';

const test = base.extend<ScenarioFixtures>(
  scenarioFixtures({
    config: {
      hooks: [
        {
          event: 'UserPromptSubmit',
          matcher: 'forbidden',
          command: `"${process.execPath}" -e "process.stderr.write('${BLOCK_REASON}'); process.exit(2)"`,
        },
      ],
    },
  }),
);

describe('hooks over KAP', () => {
  test('ends a prompt that a UserPromptSubmit hook blocks as a failed turn with the reason, without asking the model, and runs the next prompt', async ({ kap, model }) => {
    model.script(say('allowed answer'));
    const socket = await kap.connect();
    const session = await kap.createSession();
    await socket.subscribe(session.id);

    expect(await kap.prompt(session.id, 'say the forbidden word')).toMatchObject({ status: 'blocked' });
    await kap.waitIdle(session.id);
    expect(model.requests()).toEqual([]);
    const [blocked] = await kap.turns(session.id);
    expect(blocked).toMatchObject({ status: 'ended', outcome: 'failed', end_reason: 'blocked' });
    expect(blocked?.items.map((item) => item['text'])).toContainEqual(expect.stringContaining(BLOCK_REASON));

    await kap.prompt(session.id, 'say something allowed');
    await kap.waitIdle(session.id);
    const turns = await kap.turns(session.id);
    expect(turns.map((turn) => turn['outcome'])).toEqual(['failed', 'completed']);
    expect(turns[1]?.items.at(-1)).toMatchObject({ type: 'assistant_message', text: 'allowed answer' });
  });
});
