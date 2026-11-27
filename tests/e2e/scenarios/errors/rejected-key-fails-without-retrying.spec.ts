import { httpError } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario('fails the turn at once when the model service rejects the key, without retrying', {}, async ({ product, model }) => {
  const refusal = 'The example key was not accepted.';
  model.script(httpError(401, { message: refusal, type: 'invalid_request_error', code: 'invalid_api_key' }));

  await product.send('Summarise the release notes.');
  await product.waitIdle();
  await product.expectError(refusal);

  expect(model.requests('main').map((request) => request.state)).toEqual(['failed']);
});
