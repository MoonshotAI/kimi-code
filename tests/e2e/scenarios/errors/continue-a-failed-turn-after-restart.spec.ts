import { httpError, say } from '@moonshot-ai/testkit/model';

import { expect, scenario } from '../../support/scenario';

const CONTINUE_REMINDER = 'No new user message was sent. Continue the interrupted work from where it stopped; do not repeat steps that already completed.';

scenario(
  'still shows a failed turn as failed after the user restarts the product, and continues it from there',
  {
    onlyOn: ['desktop', 'web'],
    reason: 'Only Desktop and Web offer Continue on a failed turn; in the terminal UI and over ACP a user sends another message instead.',
  },
  async ({ product, model }) => {
    const prompt = 'Summarise the deployment status.';
    const refusal = 'The example service refused this request.';
    model.script(httpError(400, { message: refusal }), say('The deployment is healthy.'));

    await product.send(prompt);
    await product.waitIdle();
    await product.expectError(refusal);

    await product.restart();
    await product.expectError(refusal);
    expect(model.requests('main')).toHaveLength(1);

    await product.continue();
    await product.waitIdle();
    await product.expectReply('The deployment is healthy.');
    const requests = model.requests('main');
    expect(requests.map((request) => request.state)).toEqual(['failed', 'finished']);
    expect(requests[1]?.userTextsSinceReply).toEqual([prompt]);
    expect(requests[1]?.remindersSinceReply.at(-1)).toBe(CONTINUE_REMINDER);
    expect(requests[1]?.texts('user').filter((text) => text.includes(prompt))).toHaveLength(1);
    await product.expectTranscript(prompt);
  },
);
