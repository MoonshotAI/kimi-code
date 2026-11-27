import { httpError } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

scenario(
  'still shows a failed turn as failed after the user restarts the product',
  { except: { acp: "ACP's session/load replays the messages and tool calls of a session; nothing in it says that a turn failed." } },
  async ({ product, model }) => {
    const prompt = 'Summarise the deployment status.';
    const refusal = 'The example service refused this request.';
    model.script(httpError(400, { message: refusal }));

    await product.send(prompt);
    await product.waitIdle();
    await product.expectError(refusal);

    await product.restart();
    await product.expectTranscript(prompt);
    await product.expectError(refusal);
    expect(model.requests('main')).toHaveLength(1);
  },
);
