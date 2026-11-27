import { say, streamError } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'fails a turn whose reply breaks off on every attempt, and sends the question only once with the next message',
  { config: { loopControl: { max_attempts_per_step: 2 } } },
  async ({ product, model }) => {
    const prompt = 'Estimate the downtime.';
    const followUp = 'Try once more.';
    const dropped = 'The example service dropped the reply.';
    model.script(
      streamError(say(['Downtime is about five']), { status: 500, message: dropped }),
      streamError(say(['Retrying, the downtime']), { status: 500, message: dropped }),
      say('About five minutes.'),
    );

    await product.send(prompt);
    await product.waitIdle();
    await product.expectError(dropped);

    await product.send(followUp);
    await product.waitIdle();
    await product.expectReply('About five minutes.');
    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['failed', 'failed', 'finished']);
    expect(requests[1]?.userTextsSinceReply).toEqual([prompt]);
    expect(requests[1]?.texts('assistant')).toEqual(requests[0]?.texts('assistant'));
    expect(requests[2]?.texts('user').filter((text) => text.includes(prompt))).toHaveLength(1);
  },
);
