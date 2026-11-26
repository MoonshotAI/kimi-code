import { held, say, think } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'takes two steers in a row while the model is still thinking, and shows each prompt and the final reply once, also after a restart',
  { except: { acp: 'ACP has no way to send a message while a turn runs: the editor waits for the session/prompt answer before it sends the next one.' } },
  async ({ product, model }) => {
    const ask = 'Plan the database migration.';
    const first = 'Keep the old columns for a week.';
    const second = 'Back up the users table first.';
    const answer = 'The plan backs up the users table first and keeps the old columns for a week.';
    model.script(
      held('first-thought', think(['Looking at ', 'the schema']), 1),
      held('second-thought', think(['Weighing ', 'the old columns']), 1),
      say(answer),
    );

    await product.send(ask);
    await model.hold('first-thought').reached();
    await product.steer(first);
    await model.hold('second-thought').reached();
    await product.steer(second);
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['aborted', 'aborted', 'finished']);
    expect(requests[2]?.userTextsSinceReply).toEqual([ask, first, second]);
    for (const text of [ask, first, second]) expect(requests[2]?.texts('user').filter((user) => user.includes(text))).toHaveLength(1);
    await product.expectReply(answer);
    for (const text of [ask, first, second, answer]) await product.expectTranscript(text);

    await product.restart();
    for (const text of [ask, first, second, answer]) await product.expectTranscript(text);
    expect(model.requests('main')).toHaveLength(3);
  },
);
