import { httpError, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'reports model retry progress as live ACP notices',
  { onlyOn: ['acp'], reason: 'Only ACP exposes retry progress as live session notices.' },
  async ({ product, model }) => {
    const prompt = 'Summarise the project status.';
    model.script(
      httpError(503, { message: 'The example service is not ready yet.', retryAfterSeconds: 1 }),
      say('The project is on track.'),
    );

    await product.send(prompt);
    await product.expectNotice('Model request failed; retrying (2/10)');
    await product.expectNotice('503');
    await product.waitIdle();

    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['failed', 'finished']);
    expect(requests[1]?.userTextsSinceReply).toEqual([prompt]);
    await product.expectReply('The project is on track.');
  },
);
