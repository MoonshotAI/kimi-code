import { httpError, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('shows a request the model service refused as a failed turn, and answers the next message', {}, async ({ product, model }) => {
  const prompt = 'Summarise the project status.';
  const followUp = 'Try once more.';
  const refusal = 'The example service refused this request.';
  model.script(httpError(400, { message: refusal }), say('The project is on track.'));

  await product.send(prompt);
  await product.waitIdle();
  await product.expectError(refusal);
  expect(model.requests('main').map((request) => request.state)).toEqual(['failed']);

  await product.send(followUp);
  await product.waitIdle();

  const requests = model.requests('main');
  expect(requests.map((request) => request.state)).toEqual(['failed', 'finished']);
  expect(requests[1]?.userTextsSinceReply).toEqual([prompt, followUp]);
  await product.expectReply('The project is on track.');
});
