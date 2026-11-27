import { httpError, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('keeps the prompt cache prefix when the model service fails once after a finished turn and the request is retried', {}, async ({ product, model }) => {
  model.script(say('The parser is ready.'));
  await product.send('Is the parser ready?');
  await product.waitIdle();
  await product.expectReply('The parser is ready.');

  model.script(httpError(503, { message: 'The example service is not ready yet.', retryAfterSeconds: 1 }), say('The emitter is ready too.'));
  await product.send('Is the emitter ready?');
  await product.waitIdle();
  await product.expectReply('The emitter is ready too.');

  model.script(say('Both are ready.'));
  await product.send('So both are ready?');
  await product.waitIdle();
  await product.expectReply('Both are ready.');

  const requests = model.requests('main');
  expect(requests.map((request) => request.state)).toEqual(['finished', 'failed', 'finished', 'finished']);
  expect(requests[2]?.body).toEqual(requests[1]?.body);
  const main = model.promptCache().filter((entry) => entry.role === 'main');
  expect(main.map((entry) => entry.rejected)).toEqual([false, true, false, false]);
  expect(main.map((entry) => entry.baseline)).toEqual([undefined, main[0]?.request, main[0]?.request, main[2]?.request]);
  expect(main.map((entry) => entry.break)).toEqual([undefined, undefined, undefined, undefined]);
});
