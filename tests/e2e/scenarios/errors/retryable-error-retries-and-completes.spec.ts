import { httpError, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('retries a request the model service could not serve for now, and completes the turn', {}, async ({ product, model }) => {
  const prompt = 'Summarise the project status.';
  model.script(httpError(503, { message: 'The example service is not ready yet.', retryAfterSeconds: 1 }), say('The project is on track.'));

  await product.send(prompt);
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests.map((request) => request.state)).toEqual(['failed', 'finished']);
  expect(requests[1]?.userTextsSinceReply).toEqual(requests[0]?.userTextsSinceReply);
  expect(requests[1]?.userTextsSinceReply).toEqual([prompt]);
  await product.expectReply('The project is on track.');
});
